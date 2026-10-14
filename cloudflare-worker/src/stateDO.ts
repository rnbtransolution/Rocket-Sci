import { DurableObject } from 'cloudflare:workers';
import { Env } from './types.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RocketStateDO — strongly-consistent authoritative state for Rocket Science
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 * ---------------
 * All live business state (player profiles, deposits/withdrawals ledger, pending
 * orders, chat feed, active round) was previously stored in Cloudflare Workers KV.
 *
 * Workers KV is an *eventually consistent* store: a write is only immediately
 * visible at the Cloudflare location that served the write. Reads served from any
 * other location may keep returning the previous value until the local cache
 * entry expires — "up to 60 seconds or more" per Cloudflare's own documentation,
 * and negative lookups ("key does not exist") are cached too.
 *
 * In this system the writer and the reader are physically separated:
 *   • LINE OA webhooks are delivered from LINE's own servers  → Tokyo-region PoP
 *   • Admin Console polls are issued from the operator's browser → Thailand PoP
 *
 * That means every Deposit / Withdraw created in LINE OA stayed invisible in the
 * Admin Console for up to ~60s (and vice-versa for admin approvals reflected back
 * into the LINE OA). This Durable Object removes that class of delay entirely:
 * a single instance is the single writer and the single reader, so every write
 * is immediately visible to every subsequent read, worldwide.
 *
 * DESIGN
 * ------
 * • SQLite-backed storage (strongly consistent, transactional, durable).
 * • Full state mirrored in an in-memory Map so reads never touch disk.
 * • TTL (expirationTtl) semantics preserved from the original KV usage.
 * • Workers KV is retained by the caller layer as a cold backup mirror.
 */

/** Single global state object — one authoritative writer for the whole platform. */
const STATE_DDL = `
  CREATE TABLE IF NOT EXISTS state (
    k   TEXT PRIMARY KEY,
    v   TEXT NOT NULL,
    exp INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`;

/**
 * Keys copied from the legacy KV namespace the first time this object boots.
 * These are the aggregate keys the platform cannot function without; player
 * profiles are adopted lazily per-key by the read-miss fallback in state.ts.
 */
const BOOTSTRAP_KEYS = [
  'PLAYERS_LIST',
  'TRANSACTIONS_LIST',
  'CHAT_LOGS',
  'PENDING_ORDERS_LIST',
  'MATCHED_ORDERS_LIST',
  'SETTLED_ORDERS_LIST',
  'ACTIVE_ROUND',
  'ACTIVE_GROUP_ID',
  'LINE_GROUPS',
];

/**
 * Credential keys are adopted by PREFIX rather than by name, since one exists
 * per admin. Losing these would lock every admin out of the console, so they
 * must be restored from the KV mirror when the Durable Object is rebuilt.
 */
const BOOTSTRAP_PREFIXES = ['ADMIN_CRED_'];

interface StateRow {
  v: string;
  exp: number;
}

/**
 * Collapse duplicate player records in PLAYERS_LIST by LINE user id / short id.
 * Mirrors deduplicatePlayers() in queueHandler.ts, which cannot be imported here
 * (the DO is a separate entrypoint with no access to the app's module graph).
 * The newest record wins on conflict because callers append before merging.
 */
function dedupeProfiles(list: any[]): any[] {
  const map = new Map<string, any>();
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const lineId = typeof p.lineUserId === 'string' && p.lineUserId.startsWith('U') ? p.lineUserId : '';
    const shortId = typeof p.shortId === 'string' && p.shortId.startsWith('PL') ? p.shortId : '';
    const primaryKey = lineId || shortId || p.id;
    if (!primaryKey) continue;

    const existing = map.get(primaryKey);
    if (!existing) {
      map.set(primaryKey, { ...p, id: shortId || p.id || primaryKey, shortId: shortId || p.shortId || p.id || primaryKey });
      continue;
    }

    // Later records are newer; keep the newest balance/name but retain any
    // bank details the newer record happens to be missing.
    map.set(primaryKey, {
      ...existing,
      ...p,
      id: shortId || p.shortId || existing.shortId || existing.id || primaryKey,
      shortId: shortId || p.shortId || existing.shortId || existing.id || primaryKey,
      lineUserId: lineId || existing.lineUserId || '',
      name: p.displayName || p.name || existing.displayName || existing.name || 'ผู้เล่น',
      displayName: p.displayName || p.name || existing.displayName || existing.name || 'ผู้เล่น',
      balance: p.balance !== undefined && !Number.isNaN(Number(p.balance))
        ? Number(p.balance)
        : (Number(existing.balance) || 0),
      bankName: p.bankName || existing.bankName || '',
      accountNumber: p.accountNumber || p.bankAccount || existing.accountNumber || existing.bankAccount || '',
      bankAccount: p.bankAccount || p.accountNumber || existing.bankAccount || existing.accountNumber || '',
      accountName: p.accountName || existing.accountName || p.displayName || p.name || '',
      registeredAt: existing.registeredAt || p.registeredAt || Date.now(),
      updatedAt: Math.max(existing.updatedAt || 0, p.updatedAt || 0, Date.now()),
    });
  }
  return Array.from(map.values());
}

export class RocketStateDO extends DurableObject<Env> {
  /** Hot in-memory mirror of the persisted state (authoritative while loaded). */
  private cache = new Map<string, StateRow>();
  /** Resolves once the in-memory mirror has been fully hydrated from SQLite. */
  private ready: Promise<void>;

  // NOTE: extending `DurableObject` is REQUIRED. Workers RPC refuses to call a
  // class that only uses the legacy (ctx, env) constructor, and fails every
  // invocation with "does not support RPC" — which silently degrades the
  // strongly-consistent path back to eventually-consistent KV.
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const sql = ctx.storage.sql;
    sql.exec(STATE_DDL);

    this.ready = (async () => {
      try {
        const now = Date.now();
        const rows = sql
          .exec('SELECT k, v, exp FROM state')
          .toArray() as unknown as Array<{ k: string; v: string; exp: number }>;
        for (const row of rows) {
          if (!row || typeof row.k !== 'string' || typeof row.v !== 'string') continue;
          const exp = Number(row.exp) || 0;
          if (exp && exp <= now) continue; // already expired — treat as absent
          this.cache.set(row.k, { v: row.v, exp });
        }
      } catch (err) {
        console.error('[RocketStateDO] hydration error:', err);
      }

      // One-time adoption of the legacy KV mirror on first boot only.
      //
      // On a fresh Durable Object the state table is empty, so without this the
      // platform would come up with no players, no ledger and no orders — even
      // though every one of them is sitting in KV. Bootstrapping once (guarded
      // by the `meta` table) makes the cutover invisible to users.
      try {
        const done = sql.exec("SELECT v FROM meta WHERE k = 'bootstrapped'").toArray() as any[];
        if (!done || done.length === 0) {
          let adopted = 0;
          for (const key of BOOTSTRAP_KEYS) {
            if (this.cache.has(key)) continue; // never clobber existing DO state
            const legacy = await this.env.KV_CACHE.get(key);
            if (legacy !== null && legacy !== undefined) {
              this.cache.set(key, { v: legacy, exp: 0 });
              sql.exec(
                'INSERT INTO state (k, v, exp) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v;',
                key,
                legacy
              );
              adopted++;
            }
          }
          // Admin credentials: restore by prefix so admins are not locked out if the
          // Durable Object is rebuilt. Missing these would leave the console
          // unreachable with no way back except a deploy-time secret reset.
          for (const prefix of BOOTSTRAP_PREFIXES) {
            let cursor: string | undefined;
            do {
              const page: any = await this.env.KV_CACHE.list({
                prefix,
                ...(cursor ? { cursor } : {}),
              } as any);
              for (const k of page.keys || []) {
                if (this.cache.has(k.name)) continue;
                const value = await this.env.KV_CACHE.get(k.name);
                if (value === null || value === undefined) continue;
                this.cache.set(k.name, { v: value, exp: 0 });
                sql.exec(
                  'INSERT INTO state (k, v, exp) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v;',
                  k.name,
                  value
                );
                adopted++;
              }
              cursor = page.list_complete ? undefined : page.cursor;
            } while (cursor);
          }

          sql.exec("INSERT INTO meta (k, v) VALUES ('bootstrapped', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v;", String(Date.now()));
          console.log(`[RocketStateDO] bootstrapped ${adopted} keys from KV`);
        }
      } catch (err) {
        console.error('[RocketStateDO] KV bootstrap error:', err);
      }

      console.log(`[RocketStateDO] hydrated ${this.cache.size} keys`);
    })();

    // Keep the object alive for the duration of the hydration read.
    ctx.waitUntil(this.ready);

    // Expire TTL'd bookkeeping keys hourly so the table does not grow unbounded.
    ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    await this.ready;
    const row = this.cache.get(key);
    if (!row) return null;
    if (row.exp && row.exp <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return row.v;
  }

  /** Batched read — one RPC for many keys (used by the dashboard hot path). */
  async multi(keys: string[]): Promise<Array<string | null>> {
    await this.ready;
    const now = Date.now();
    const out: Array<string | null> = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const row = this.cache.get(keys[i]);
      if (!row) {
        out[i] = null;
      } else if (row.exp && row.exp <= now) {
        this.cache.delete(keys[i]);
        out[i] = null;
      } else {
        out[i] = row.v;
      }
    }
    return out;
  }

  /** All key names matching an optional prefix. */
  async keys(prefix?: string): Promise<string[]> {
    await this.ready;
    const now = Date.now();
    const out: string[] = [];
    for (const [key, row] of this.cache.entries()) {
      if (row.exp && row.exp <= now) {
        this.cache.delete(key);
        continue;
      }
      if (!prefix || key.startsWith(prefix)) out.push(key);
    }
    return out;
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async put(key: string, value: string, expiresAt?: number): Promise<void> {
    await this.ready;
    const exp = Number(expiresAt) || 0;
    this.cache.set(key, { v: value, exp });
    this.ctx.storage.sql.exec(
      'INSERT INTO state (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp;',
      key,
      value,
      exp
    );
  }

  async delete(key: string): Promise<boolean> {
    await this.ready;
    const existed = this.cache.delete(key);
    this.ctx.storage.sql.exec('DELETE FROM state WHERE k = ?;', key);
    return existed;
  }

  // ── Atomic hot-path mutations ────────────────────────────────────────────
  // The operations below are read-modify-write sequences over the SAME key. If
  // they were composed from separate RPCs at the caller, a concurrent write
  // (e.g. a LINE OA deposit arriving while the Admin Console approves another
  // one) could interleave and silently drop the loser. Running them inside the
  // DO makes each one atomic, which is what keeps the two platforms in step.

  /**
   * Upsert a transaction by id, newest-first, capped at `limit`.
   * Returns the full resulting ledger.
   */
  async upsertTransaction(txJson: string, limit = 100): Promise<string> {
    await this.ready;
    let list: any[] = [];
    const row = this.cache.get('TRANSACTIONS_LIST');
    if (row) {
      try { list = JSON.parse(row.v) || []; } catch (_) { list = []; }
    }
    let incoming: any;
    try { incoming = JSON.parse(txJson); } catch (_) { return row ? row.v : '[]'; }

    const merged = [incoming, ...list.filter((t) => t && t.id !== incoming.id)].slice(0, limit);
    const serialized = JSON.stringify(merged);
    this.cache.set('TRANSACTIONS_LIST', { v: serialized, exp: 0 });
    this.ctx.storage.sql.exec(
      'INSERT INTO state (k, v, exp) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = 0;',
      'TRANSACTIONS_LIST',
      serialized
    );
    return serialized;
  }

  /** Apply a status/amount/reason update to an existing transaction. */
  async patchTransactionStatus(
    txId: string,
    status: string,
    reviewReason: string,
    actualAmount?: number | null
  ): Promise<string | null> {
    await this.ready;
    const row = this.cache.get('TRANSACTIONS_LIST');
    if (!row) return null;
    let list: any[];
    try { list = JSON.parse(row.v) || []; } catch (_) { return null; }

    const target = list.find((t) => t && t.id === txId);
    if (!target) return row.v;

    target.status = status;
    if (typeof actualAmount === 'number' && !Number.isNaN(actualAmount)) {
      target.actualAmount = actualAmount;
    }
    if (reviewReason) target.reviewReason = reviewReason;
    target.reviewedAt = Date.now();

    const serialized = JSON.stringify(list);
    this.cache.set('TRANSACTIONS_LIST', { v: serialized, exp: 0 });
    this.ctx.storage.sql.exec(
      'INSERT INTO state (k, v, exp) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = 0;',
      'TRANSACTIONS_LIST',
      serialized
    );
    return serialized;
  }

  /**
   * Persist a player profile across ALL of its keys in one atomic commit:
   *   USER_<lineUserId>, USER_<shortId>, RAW_LINE_<shortId> and the
   *   PLAYERS_LIST directory entry the Admin Console actually reads.
   *
   * These were previously four independent read-modify-write operations. Two
   * overlapping calls (e.g. an approval in the Admin Console racing a deposit
   * from LINE OA) could interleave so that the directory showed one balance
   * while the canonical profile key held another — the two platforms then
   * displayed different balances for the same player until something forced a
   * rewrite. Doing it here makes every key agree at all times.
   */
  // ── Rate limiting ──────────────────────────────────────────────────────

  /**
   * Fixed-window attempt counter for a throttling key (e.g. `login:<ip>`).
   *
   * Held here rather than in an isolate-scoped Map so the limit survives cold
   * starts and deployments — otherwise an attacker resets the counter simply
   * by waiting for a new isolate, which is free to trigger.
   */
  async rateLimit(key: string): Promise<{ count: number; resetAt: number }> {
    await this.ready;
    const row = this.cache.get(`RATELIMIT_${key}`);
    if (!row) return { count: 0, resetAt: 0 };
    try {
      return JSON.parse(row.v) as { count: number; resetAt: number };
    } catch (_) {
      return { count: 0, resetAt: 0 };
    }
  }

  /** Persist an attempt counter; it self-deletes once its window elapses. */
  async setRateLimit(key: string, value: { count: number; resetAt: number }): Promise<void> {
    await this.ready;
    const storageKey = `RATELIMIT_${key}`;
    if (value.resetAt <= Date.now()) {
      this.cache.delete(storageKey);
      this.ctx.storage.sql.exec('DELETE FROM state WHERE k = ?;', storageKey);
      return;
    }
    const serialized = JSON.stringify(value);
    this.cache.set(storageKey, { v: serialized, exp: value.resetAt });
    this.ctx.storage.sql.exec(
      'INSERT INTO state (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp;',
      storageKey,
      serialized,
      value.resetAt
    );
  }

  /** Clear a counter after a successful login or reset. */
  async clearRateLimit(key: string): Promise<void> {
    await this.ready;
    const storageKey = `RATELIMIT_${key}`;
    this.cache.delete(storageKey);
    this.ctx.storage.sql.exec('DELETE FROM state WHERE k = ?;', storageKey);
  }

  /**
   * Persist a player profile across ALL of its keys in one atomic commit:
    await this.ready;
    let profile: any;
    let entry: any;
    try {
      profile = JSON.parse(profileJson);
      entry = JSON.parse(entryJson);
    } catch (_) {
      return false;
    }
    if (!profile || typeof profile !== 'object') return false;

    const writes: Array<[string, string]> = [];
    if (typeof profile.lineUserId === 'string' && profile.lineUserId.startsWith('U')) {
      writes.push([`USER_${profile.lineUserId}`, profileJson]);
    }
    if (profile.shortId) {
      writes.push([`USER_${profile.shortId}`, profileJson]);
      if (typeof profile.lineUserId === 'string' && profile.lineUserId.startsWith('U')) {
        writes.push([`RAW_LINE_${profile.shortId}`, profile.lineUserId]);
      }
    }

    // Directory update: merge into PLAYERS_LIST as part of the same commit.
    let list: any[] = [];
    const row = this.cache.get('PLAYERS_LIST');
    if (row) {
      try { list = JSON.parse(row.v) || []; } catch (_) { list = []; }
    }
    list.push(entry || {});
    const merged = dedupeProfiles(list).slice(-limit);
    writes.push(['PLAYERS_LIST', JSON.stringify(merged)]);

    for (const [key, value] of writes) {
      this.cache.set(key, { v: value, exp: 0 });
      this.ctx.storage.sql.exec(
        'INSERT INTO state (k, v, exp) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = 0;',
        key,
        value
      );
    }
    return true;
  }

  /** Append a chat log entry, capped at `limit`. */
  async appendChatLog(logJson: string, limit = 100): Promise<void> {
    await this.ready;
    let logs: any[] = [];
    const row = this.cache.get('CHAT_LOGS');
    if (row) {
      try { logs = JSON.parse(row.v) || []; } catch (_) { logs = []; }
    }
    try {
      logs.push(JSON.parse(logJson));
    } catch (_) {
      return;
    }
    const serialized = JSON.stringify(logs.slice(-limit));
    this.cache.set('CHAT_LOGS', { v: serialized, exp: 0 });
    this.ctx.storage.sql.exec(
      'INSERT INTO state (k, v, exp) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = 0;',
      'CHAT_LOGS',
      serialized
    );
  }

  /**
   * Write several keys in a single atomic commit.
   * Used to fan a player profile out to all of its alias keys (short id, LINE
   * user id, raw-line mapping) without a reader ever observing a half-applied
   * update — which is what previously let the Admin Console and LINE OA show
   * different balances for the same player.
   */
  async writeMany(entries: Array<[string, string]>, expiresAt = 0): Promise<void> {
    await this.ready;
    for (const [key, value] of entries || []) {
      if (!key || typeof value !== 'string') continue;
      this.cache.set(key, { v: value, exp: expiresAt });
      this.ctx.storage.sql.exec(
        'INSERT INTO state (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp;',
        key,
        value,
        expiresAt
      );
    }
  }

  /** Wipe every key (Factory Reset). */
  async clear(): Promise<void> {
    await this.ready;
    this.cache.clear();
    this.ctx.storage.sql.exec('DELETE FROM state;');
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    await this.ready;
    try {
      const now = Date.now();
      const expired = this.ctx.storage.sql
        .exec('SELECT k FROM state WHERE exp > 0 AND exp <= ?;', now)
        .toArray() as unknown as Array<{ k: string }>;
      for (const row of expired) this.cache.delete(row.k);
      this.ctx.storage.sql.exec('DELETE FROM state WHERE exp > 0 AND exp <= ?;', now);
    } catch (err) {
      console.error('[RocketStateDO] alarm purge error:', err);
    } finally {
      this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    }
  }

  /** Operational introspection surfaced through the admin debug panel. */
  async stats(): Promise<{ keys: number; dbBytes: number; at: string }> {
    await this.ready;
    let dbBytes = 0;
    try {
      dbBytes = this.ctx.storage.sql.databaseSize;
    } catch (_) {}
    return { keys: this.cache.size, dbBytes, at: new Date().toISOString() };
  }
}