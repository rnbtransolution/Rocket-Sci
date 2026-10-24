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

// ── Atomic ledger transaction types ─────────────────────────────────────────
//
// Every movement of player credit, and every order status change that decides
// who is owed what, is executed as ONE `txn()` call. The Durable Object runs a
// request to completion without interleaving another one between synchronous
// steps, so "check the status, check the balance, then write everything" inside
// a single call is a true atomic compare-and-set. Composing the same steps from
// separate get/put RPCs in the Worker is what let concurrent LINE messages
// overwrite each other's balance and order-list updates.

/** Order statuses after which an order can never move money again. */
const TERMINAL_ORDER_STATUSES = new Set(['cancelled', 'settled', 'resolved', 'void']);

/** Index lists that hold live orders. They are never capped: dropping an entry strands its stake. */
const UNCAPPED_LISTS = new Set(['PENDING_ORDERS_LIST', 'MATCHED_ORDERS_LIST']);

/** Transactions still awaiting an admin decision are never trimmed out of the ledger. */
const OPEN_TX_STATUSES = new Set(['pending', 'escalated']);
const TX_LIST_KEEP_FINAL = 500;

export interface TxnBalanceOp {
  shortId?: string | null;
  lineUserId?: string | null;
  /** Signed change in credit. */
  delta?: number;
  /** Absolute balance (admin adjustment). */
  set?: number;
  /** Refuse the whole transaction if the result would be negative. */
  requireSufficient?: boolean;
  displayName?: string;
}

export interface TxnSettleSpec {
  finalSeconds: number;
  /** Fallback band for an order that carries no range of its own. */
  tMin: number;
  tMax: number;
  commissionRate: number;
}

export interface TxnOrderOp {
  orderNumber: string;
  /** Create the order. The number must be unused or belong to a finished order. */
  create?: any;
  expectCreatedAt?: number;
  expectStatus?: string[];
  expectFields?: Record<string, unknown>;
  expectMissingFields?: string[];
  expectCreatorId?: string;
  rejectCreatorId?: string;
  expectAmount?: number;
  patch?: Record<string, unknown>;
  /** Cancel and return the stored stake to the creator, and to the matcher if there is one. */
  refund?: boolean;
  /** Settle against the stored order and credit the winner (or both sides on a draw). */
  settle?: TxnSettleSpec;
  /**
   * Balance moves derived from THIS order's stored values, applied after the
   * order checks pass: `{ who: 'creator'|'matcher', delta }`.
   */
  credits?: Array<{ who: 'creator' | 'matcher'; delta: number }>;
}

export interface TxnListOp {
  key: string;
  op: 'upsert' | 'remove';
  orderNumber: string;
  cap?: number;
}

export interface TxnClaimOp {
  key: string;
  payload: unknown;
  ttlMs?: number;
}

export interface TxnTransactionOp {
  id: string;
  insert?: any;
  mustExist?: boolean;
  expectStatusNotIn?: string[];
  patch?: Record<string, unknown>;
  /** Credit `requestedAmount` of the stored transaction to its player. */
  creditRequested?: boolean;
}

export interface TxnSpec {
  /**
   * Set by StateStore on its retry, after legacy KV records were adopted. Only
   * then may a player found solely in the PLAYERS_LIST directory be used: on
   * the first attempt the authoritative USER_ record may simply not have been
   * adopted yet, and the directory copy can be older.
   */
  allowDirectoryFallback?: boolean;
  round?: { expectStatus?: string[]; expectQuoteReleased?: boolean };
  claims?: TxnClaimOp[];
  orders?: TxnOrderOp[];
  balances?: TxnBalanceOp[];
  lists?: TxnListOp[];
  transactions?: TxnTransactionOp[];
}

export interface TxnBalanceResult {
  shortId: string;
  lineUserId: string;
  displayName: string;
  before: number;
  after: number;
}

export interface TxnResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  /** Stored value of the order a failed check was made against. */
  current?: any;
  orders: Record<string, any>;
  balances: TxnBalanceResult[];
  transactions: Record<string, any>;
  /** Every key written, for the Worker's best-effort KV mirror. */
  writes: Array<[string, string]>;
}

class TxnAbort extends Error {
  constructor(public reason: string, public detail = '', public current?: any) {
    super(reason);
  }
}

/** Round a credit amount to whole satang so float drift can never accumulate. */
function money(n: number): number {
  return Math.round(n * 100) / 100;
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

    let existingKey: string | null = null;
    for (const [k, val] of map.entries()) {
      if (
        k === primaryKey ||
        (lineId && val.lineUserId === lineId) ||
        (shortId && (val.shortId === shortId || val.id === shortId))
      ) {
        existingKey = k;
        break;
      }
    }

    if (!existingKey) {
      map.set(primaryKey, {
        ...p,
        id: shortId || p.id || primaryKey,
        shortId: shortId || p.shortId || p.id || primaryKey,
        updatedAt: Number(p.updatedAt) || 0,
      });
      continue;
    }

    const existing = map.get(existingKey);
    const exAt = Number(existing.updatedAt) || 0;
    const inAt = Number(p.updatedAt) || 0;
    const exBal = Number(existing.balance) || 0;
    const inBal = p.balance !== undefined && !Number.isNaN(Number(p.balance)) ? Number(p.balance) : exBal;
    const chosenBal = exAt > 0 && inAt > 0
      ? (inAt >= exAt ? inBal : exBal)
      : (inAt > 0 ? inBal : (exAt > 0 ? exBal : inBal));

    map.set(existingKey, {
      ...existing,
      ...p,
      id: shortId || p.shortId || existing.shortId || existing.id || primaryKey,
      shortId: shortId || p.shortId || existing.shortId || existing.id || primaryKey,
      lineUserId: lineId || existing.lineUserId || '',
      name: p.displayName || p.name || existing.displayName || existing.name || 'ผู้เล่น',
      displayName: p.displayName || p.name || existing.displayName || existing.name || 'ผู้เล่น',
      balance: chosenBal,
      bankName: p.bankName || existing.bankName || '',
      accountNumber: p.accountNumber || p.bankAccount || existing.accountNumber || existing.bankAccount || '',
      bankAccount: p.bankAccount || p.accountNumber || existing.bankAccount || existing.accountNumber || '',
      accountName: p.accountName || existing.accountName || p.displayName || p.name || '',
      registeredAt: existing.registeredAt || p.registeredAt || Date.now(),
      updatedAt: Math.max(exAt, inAt),
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

    // Open requests (a withdrawal whose points are already deducted, a slip
    // awaiting review) are never trimmed; only finished entries age out.
    let finals = 0;
    const keepFinal = Math.max(limit, TX_LIST_KEEP_FINAL);
    const merged = [incoming, ...list.filter((t) => t && t.id !== incoming.id)].filter((t) => {
      if (OPEN_TX_STATUSES.has(String(t.status))) return true;
      finals++;
      return finals <= keepFinal;
    });
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
  async saveProfile(profileJson: string, entryJson: string, limit = 5000): Promise<string | null> {
    await this.ready;
    let profile: any;
    let entry: any;
    try {
      profile = JSON.parse(profileJson);
      entry = JSON.parse(entryJson);
    } catch (_) {
      return null;
    }
    if (!profile || typeof profile !== 'object') return null;

    // The balance is NOT the caller's to write. Callers save a profile they read
    // some time ago (to change a name or bank details); its balance is a stale
    // snapshot, and writing it back silently undid any bet, payout or deposit
    // committed in between. Credit moves only through txn(). A profile with no
    // stored record (a brand-new player) keeps the balance it was created with.
    const existing = this.resolveProfile(profile.shortId, profile.lineUserId);
    if (existing) {
      profile.balance = existing.balance;
      if (entry && typeof entry === 'object') entry.balance = existing.balance;
    }
    profileJson = JSON.stringify(profile);

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

    this.commit(writes.map(([k, v]) => [k, v, 0] as [string, string, number]));
    return profileJson;
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

  // ── Atomic ledger ────────────────────────────────────────────────────────

  /** Live value of a key from the in-memory mirror, honouring expiry. */
  private live(key: string): string | null {
    const row = this.cache.get(key);
    if (!row) return null;
    if (row.exp && row.exp <= Date.now()) return null;
    return row.v;
  }

  private liveJson<T = any>(key: string): T | null {
    const raw = this.live(key);
    if (raw === null) return null;
    try { return JSON.parse(raw) as T; } catch (_) { return null; }
  }

  /** Write a batch of rows to memory and SQLite as one storage transaction. */
  private commit(rows: Array<[string, string, number]>): void {
    const sql = this.ctx.storage.sql;
    const apply = () => {
      for (const [key, value, exp] of rows) {
        sql.exec(
          'INSERT INTO state (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp;',
          key,
          value,
          exp
        );
      }
    };
    const storage: any = this.ctx.storage;
    if (typeof storage.transactionSync === 'function') storage.transactionSync(apply);
    else apply();
    for (const [key, value, exp] of rows) this.cache.set(key, { v: value, exp });
  }

  /** Store a value only if the key is not already present (legacy KV adoption). */
  async putIfAbsent(key: string, value: string): Promise<string> {
    await this.ready;
    const existing = this.live(key);
    if (existing !== null) return existing;
    this.commit([[key, value, 0]]);
    return value;
  }

  /**
   * Resolve a player's authoritative profile from any identifier.
   * USER_<lineUserId> and USER_<shortId> are kept identical by every write
   * below; for legacy data where they differ, the newer `updatedAt` wins
   * (never the larger balance — a bet makes the newer balance smaller).
   */
  private resolveProfile(shortIdIn?: string | null, lineIdIn?: string | null, allowDirectory = true): any | null {
    let line = typeof lineIdIn === 'string' && lineIdIn.startsWith('U') ? lineIdIn : '';
    if (!line && typeof shortIdIn === 'string' && shortIdIn.startsWith('U')) line = shortIdIn;
    let short = typeof shortIdIn === 'string' && shortIdIn.startsWith('PL') ? shortIdIn : '';
    if (!line && short) line = this.live(`RAW_LINE_${short}`) || '';

    const byLine = line ? this.liveJson(`USER_${line}`) : null;
    if (!short && byLine && typeof byLine.shortId === 'string') short = byLine.shortId;
    let byShort = short ? this.liveJson(`USER_${short}`) : null;
    // A short id is derived from the LINE id and can collide; never let another
    // player's short-id record stand in for this one.
    if (byShort && line && byShort.lineUserId && String(byShort.lineUserId).startsWith('U') && byShort.lineUserId !== line) {
      byShort = null;
    }

    let profile: any = null;
    if (byLine && byShort) {
      profile = (Number(byShort.updatedAt) || 0) > (Number(byLine.updatedAt) || 0)
        ? { ...byLine, ...byShort }
        : { ...byShort, ...byLine };
    } else {
      profile = byLine || byShort;
    }

    if (!profile && allowDirectory) {
      const list = this.liveJson<any[]>('PLAYERS_LIST') || [];
      const entry = list.find((p) =>
        p && ((line && p.lineUserId === line) || (short && (p.shortId === short || p.id === short)))
      );
      if (entry) {
        profile = {
          shortId: entry.shortId || entry.id || short,
          lineUserId: entry.lineUserId || line,
          displayName: entry.displayName || entry.name || 'ผู้เล่น',
          balance: Number(entry.balance) || 0,
          bankName: entry.bankName || '',
          accountNumber: entry.accountNumber || entry.bankAccount || '',
          accountName: entry.accountName || entry.displayName || entry.name || '',
          registeredAt: Number(entry.registeredAt) || Date.now(),
          updatedAt: Number(entry.updatedAt) || 0,
        };
      }
    }
    if (!profile) return null;

    profile.shortId = profile.shortId || short || (line ? `PL${line.slice(-6).toUpperCase()}` : '');
    if (!(typeof profile.lineUserId === 'string' && profile.lineUserId.startsWith('U')) && line) {
      profile.lineUserId = line;
    }
    profile.balance = Number(profile.balance) || 0;
    return profile;
  }

  /** The rows that persist one profile under all of its keys. */
  private profileRows(profile: any): Array<[string, string, number]> {
    const json = JSON.stringify(profile);
    const rows: Array<[string, string, number]> = [];
    const line = typeof profile.lineUserId === 'string' && profile.lineUserId.startsWith('U') ? profile.lineUserId : '';
    if (line) rows.push([`USER_${line}`, json, 0]);
    if (profile.shortId) {
      rows.push([`USER_${profile.shortId}`, json, 0]);
      if (line) rows.push([`RAW_LINE_${profile.shortId}`, line, 0]);
    }
    return rows;
  }

  /** Directory entry the Admin Console reads, in the shape savePlayerProfile writes. */
  private directoryEntry(profile: any): any {
    return {
      id: profile.shortId || profile.lineUserId,
      name: profile.displayName || 'ผู้เล่น',
      displayName: profile.displayName || 'ผู้เล่น',
      shortId: profile.shortId,
      lineUserId: profile.lineUserId,
      balance: Number(profile.balance) || 0,
      bankName: profile.bankName || '',
      accountNumber: profile.accountNumber || '',
      bankAccount: profile.accountNumber || '',
      accountName: profile.accountName || profile.displayName || '',
      registeredAt: profile.registeredAt || Date.now(),
      updatedAt: profile.updatedAt,
    };
  }

  /** Decide one order's result. Mirrors the rules the settlement used in index.ts. */
  private computeSettlement(order: any, spec: TxnSettleSpec) {
    const amt = Number(order.amount) || 0;
    const finalSeconds = Number(spec.finalSeconds);
    const orderMin = Number.isFinite(Number(order.rangeMin)) && Number(order.rangeMin) > 0 ? Number(order.rangeMin) : spec.tMin;
    const orderMax = Number.isFinite(Number(order.rangeMax)) && Number(order.rangeMax) > 0 ? Number(order.rangeMax) : spec.tMax;

    let winnerSide: 'low' | 'high' | 'draw' = 'draw';
    if (finalSeconds < orderMin) winnerSide = 'low';
    else if (finalSeconds > orderMax) winnerSide = 'high';

    let winnerId = '';
    let winnerLineUserId = '';
    let winnerName = '-';
    if (winnerSide !== 'draw') {
      const creatorWins = order.side === winnerSide;
      winnerId = (creatorWins ? order.creatorId : order.matcherId) || '';
      winnerLineUserId = (creatorWins ? order.creatorLineUserId : order.matcherLineUserId) || '';
      winnerName = (creatorWins ? order.creatorName : order.matcherName) || '-';
    }

    // 10% of the loser's stake is the platform fee; the winner gets their own
    // stake back plus the rest. Math.round keeps balances whole (confirmed rule).
    const commission = winnerSide !== 'draw' ? Math.round(amt * spec.commissionRate) : 0;
    const payout = winnerSide !== 'draw' ? amt + (amt - commission) : 0;
    return { amt, winnerSide, winnerId, winnerLineUserId, winnerName, commission, payout };
  }

  /**
   * Execute a ledger transaction atomically: every check first, then every
   * write in one storage transaction. Nothing is written if any check fails.
   */
  async txn(specJson: string): Promise<string> {
    await this.ready;
    const empty: TxnResult = { ok: false, orders: {}, balances: [], transactions: {}, writes: [] };
    let spec: TxnSpec;
    try { spec = JSON.parse(specJson) as TxnSpec; } catch (_) {
      return JSON.stringify({ ...empty, reason: 'bad_spec' });
    }

    try {
      const now = Date.now();

      // 1. Round lock.
      if (spec.round) {
        const round = this.liveJson<any>('ACTIVE_ROUND');
        const status = round?.status || 'ACTIVE';
        const quoteReleased = round ? round.quoteReleased === true : false;
        if (spec.round.expectStatus && !spec.round.expectStatus.includes(status)) {
          throw new TxnAbort('round_closed', status, round);
        }
        if (typeof spec.round.expectQuoteReleased === 'boolean' && spec.round.expectQuoteReleased !== quoteReleased) {
          throw new TxnAbort('round_changed', `quoteReleased=${quoteReleased}`, round);
        }
      }

      // 2. Claims (single-use keys — slip refs, legacy refund/settle claims).
      const claimRows: Array<[string, string, number]> = [];
      for (const c of spec.claims || []) {
        const key = `CLAIM_${c.key}`;
        if (this.live(key) !== null) throw new TxnAbort('claimed', c.key);
        const ttl = Number(c.ttlMs) || 0;
        claimRows.push([key, JSON.stringify(c.payload ?? {}), ttl > 0 ? now + ttl : 0]);
      }

      // 3. Orders: verify, then compute the post-transaction value.
      const orders = new Map<string, any>();
      const pendingCredits: TxnBalanceOp[] = [];
      for (const op of spec.orders || []) {
        const key = `ORDER_${op.orderNumber}`;
        const stored = orders.get(op.orderNumber) ?? this.liveJson<any>(key);

        if (op.create) {
          if (stored && !TERMINAL_ORDER_STATUSES.has(String(stored.status))) {
            throw new TxnAbort('order_exists', op.orderNumber, stored);
          }
          orders.set(op.orderNumber, { ...op.create });
          continue;
        }

        if (!stored) throw new TxnAbort('order_not_found', op.orderNumber);
        if (op.expectCreatedAt !== undefined && (Number(stored.createdAt) || 0) !== Number(op.expectCreatedAt)) {
          throw new TxnAbort('order_replaced', op.orderNumber, stored);
        }
        if (op.expectStatus && !op.expectStatus.includes(String(stored.status))) {
          throw new TxnAbort('order_status', String(stored.status), stored);
        }
        for (const [f, v] of Object.entries(op.expectFields || {})) {
          if (stored[f] !== v) throw new TxnAbort('order_field', `${f}=${stored[f]}`, stored);
        }
        for (const f of op.expectMissingFields || []) {
          if (stored[f] !== undefined && stored[f] !== null && stored[f] !== '') {
            throw new TxnAbort('order_field', `${f} present`, stored);
          }
        }
        if (op.expectCreatorId !== undefined && stored.creatorId !== op.expectCreatorId) {
          throw new TxnAbort('not_creator', op.orderNumber, stored);
        }
        if (op.rejectCreatorId !== undefined && stored.creatorId === op.rejectCreatorId) {
          throw new TxnAbort('own_order', op.orderNumber, stored);
        }
        if (op.expectAmount !== undefined && Number(stored.amount) !== Number(op.expectAmount)) {
          throw new TxnAbort('order_amount', String(stored.amount), stored);
        }

        const next: any = { ...stored, ...(op.patch || {}) };
        const amt = Number(stored.amount) || 0;

        if (op.refund) {
          next.status = 'cancelled';
          next.refundedAt = now;
          if (amt > 0) {
            if (stored.creatorId) pendingCredits.push({ shortId: stored.creatorId, lineUserId: stored.creatorLineUserId, delta: amt });
            if (stored.matcherId) pendingCredits.push({ shortId: stored.matcherId, lineUserId: stored.matcherLineUserId, delta: amt });
          }
        }

        if (op.settle) {
          const r = this.computeSettlement(stored, op.settle);
          if (r.winnerSide !== 'draw' && !r.winnerId) {
            throw new TxnAbort('no_winner_party', op.orderNumber, stored);
          }
          next.status = 'settled';
          next.finalTime = Number(op.settle.finalSeconds);
          next.winnerSide = r.winnerSide;
          next.winnerName = r.winnerName;
          next.settledAt = now;
          next.grossWinAmount = r.winnerSide !== 'draw' ? r.amt : 0;
          next.commission = r.commission;
          next.payout = r.payout;
          if (r.winnerSide !== 'draw') {
            if (r.payout > 0) pendingCredits.push({ shortId: r.winnerId, lineUserId: r.winnerLineUserId, delta: r.payout });
          } else if (r.amt > 0) {
            if (stored.creatorId) pendingCredits.push({ shortId: stored.creatorId, lineUserId: stored.creatorLineUserId, delta: r.amt });
            if (stored.matcherId) pendingCredits.push({ shortId: stored.matcherId, lineUserId: stored.matcherLineUserId, delta: r.amt });
          }
        }

        for (const c of op.credits || []) {
          if (!(Number(c.delta) !== 0)) continue;
          const id = c.who === 'creator' ? stored.creatorId : stored.matcherId;
          const lid = c.who === 'creator' ? stored.creatorLineUserId : stored.matcherLineUserId;
          if (!id) throw new TxnAbort('party_missing', `${c.who} on ${op.orderNumber}`, stored);
          pendingCredits.push({ shortId: id, lineUserId: lid, delta: Number(c.delta) });
        }

        orders.set(op.orderNumber, next);
      }

      // 4. Ledger entries (deposits / withdrawals).
      let txList: any[] | null = null;
      const txResults: Record<string, any> = {};
      for (const t of spec.transactions || []) {
        if (txList === null) txList = this.liveJson<any[]>('TRANSACTIONS_LIST') || [];
        const idx = txList.findIndex((x) => x && x.id === t.id);
        if (t.insert) {
          if (idx >= 0) throw new TxnAbort('tx_exists', t.id, txList[idx]);
          txList.unshift({ ...t.insert });
          txResults[t.id] = txList[0];
          continue;
        }
        if (idx < 0) {
          if (t.mustExist) throw new TxnAbort('tx_not_found', t.id);
          continue;
        }
        const stored = txList[idx];
        if (t.expectStatusNotIn && t.expectStatusNotIn.includes(String(stored.status))) {
          throw new TxnAbort('tx_status', String(stored.status), stored);
        }
        const next = { ...stored, ...(t.patch || {}), reviewedAt: now };
        txList[idx] = next;
        txResults[t.id] = next;
        if (t.creditRequested) {
          const amt = Number(stored.requestedAmount) || 0;
          if (!(amt > 0)) throw new TxnAbort('tx_amount', String(stored.requestedAmount), stored);
          pendingCredits.push({ shortId: stored.playerId, lineUserId: stored.lineUserId, delta: amt });
        }
      }

      // 5. Balances: explicit ops, then the credits the order/tx ops produced.
      const working = new Map<string, { profile: any; before: number }>();
      const order: string[] = [];
      for (const b of [...(spec.balances || []), ...pendingCredits]) {
        const resolved = this.resolveProfile(b.shortId, b.lineUserId, spec.allowDirectoryFallback === true);
        if (!resolved) throw new TxnAbort('player_not_found', String(b.shortId || b.lineUserId || ''));
        const wkey = resolved.lineUserId && String(resolved.lineUserId).startsWith('U') ? resolved.lineUserId : resolved.shortId;
        let w = working.get(wkey);
        if (!w) {
          w = { profile: resolved, before: resolved.balance };
          working.set(wkey, w);
          order.push(wkey);
        }
        const prev = Number(w.profile.balance) || 0;
        if (typeof b.set === 'number') {
          if (!Number.isFinite(b.set) || b.set < 0) throw new TxnAbort('bad_amount', String(b.set));
          w.profile.balance = money(b.set);
        } else {
          const d = Number(b.delta);
          if (!Number.isFinite(d)) throw new TxnAbort('bad_amount', String(b.delta));
          w.profile.balance = money(prev + d);
        }
        if (b.requireSufficient && w.profile.balance < 0) {
          throw new TxnAbort('insufficient', String(prev), { balance: prev });
        }
        if (b.displayName) w.profile.displayName = b.displayName;
      }

      // ── All checks passed: build the write set. ──
      const rows: Array<[string, string, number]> = [...claimRows];

      for (const [no, value] of orders) rows.push([`ORDER_${no}`, JSON.stringify(value), 0]);

      const balanceResults: TxnBalanceResult[] = [];
      if (order.length > 0) {
        const list = this.liveJson<any[]>('PLAYERS_LIST') || [];
        for (const wkey of order) {
          const w = working.get(wkey)!;
          w.profile.updatedAt = now;
          rows.push(...this.profileRows(w.profile));
          const entry = this.directoryEntry(w.profile);
          const i = list.findIndex((p) =>
            p && ((entry.lineUserId && p.lineUserId === entry.lineUserId) ||
                  (entry.shortId && (p.shortId === entry.shortId || p.id === entry.shortId)))
          );
          if (i >= 0) list[i] = { ...list[i], ...entry };
          else list.push(entry);
          balanceResults.push({
            shortId: w.profile.shortId,
            lineUserId: w.profile.lineUserId,
            displayName: w.profile.displayName,
            before: w.before,
            after: w.profile.balance,
          });
        }
        rows.push(['PLAYERS_LIST', JSON.stringify(list), 0]);
      }

      if (spec.lists && spec.lists.length > 0) {
        const lists = new Map<string, any[]>();
        for (const l of spec.lists) {
          let arr = lists.get(l.key);
          if (!arr) {
            arr = this.liveJson<any[]>(l.key) || [];
            if (!Array.isArray(arr)) arr = [];
            lists.set(l.key, arr);
          }
          const filtered = arr.filter((o) => o && o.orderNumber !== l.orderNumber);
          if (l.op === 'upsert') {
            const value = orders.get(l.orderNumber) ?? this.liveJson(`ORDER_${l.orderNumber}`);
            if (value) filtered.unshift(value);
          }
          const cap = UNCAPPED_LISTS.has(l.key) ? 0 : (Number(l.cap) || 0);
          lists.set(l.key, cap > 0 ? filtered.slice(0, cap) : filtered);
        }
        for (const [key, arr] of lists) rows.push([key, JSON.stringify(arr), 0]);
      }

      if (txList !== null) {
        let finals = 0;
        const trimmed = txList.filter((t) => {
          if (!t) return false;
          if (OPEN_TX_STATUSES.has(String(t.status))) return true;
          finals++;
          return finals <= TX_LIST_KEEP_FINAL;
        });
        rows.push(['TRANSACTIONS_LIST', JSON.stringify(trimmed), 0]);
      }

      this.commit(rows);

      const outOrders: Record<string, any> = {};
      for (const [no, value] of orders) outOrders[no] = value;
      const result: TxnResult = {
        ok: true,
        orders: outOrders,
        balances: balanceResults,
        transactions: txResults,
        writes: rows.map(([k, v]) => [k, v] as [string, string]),
      };
      return JSON.stringify(result);
    } catch (err) {
      if (err instanceof TxnAbort) {
        return JSON.stringify({ ...empty, reason: err.reason, detail: err.detail, current: err.current });
      }
      console.error('[RocketStateDO] txn error:', err);
      return JSON.stringify({ ...empty, reason: 'error', detail: String((err as Error)?.message || err) });
    }
  }

  /**
   * Move every still-matched order of the active board into a parked in-flight
   * round, in one step, so a match landing mid-park cannot end up attached to
   * the next rocket.
   */
  async parkMatched(metaJson: string, force: boolean): Promise<string> {
    await this.ready;
    const meta = JSON.parse(metaJson);
    const now = Date.now();
    const matched = this.liveJson<any[]>('MATCHED_ORDERS_LIST') || [];
    const rows: Array<[string, string, number]> = [];
    const stamped: any[] = [];
    for (const item of matched) {
      if (!item || !item.orderNumber) continue;
      const stored = this.liveJson<any>(`ORDER_${item.orderNumber}`) || item;
      if (stored.status !== 'matched') continue;
      const next = { ...stored, inFlightRoundId: meta.roundId, rocketName: stored.rocketName || meta.name };
      rows.push([`ORDER_${item.orderNumber}`, JSON.stringify(next), 0]);
      stamped.push(next);
    }
    if (stamped.length === 0 && !force) {
      return JSON.stringify({ parkedRound: null, writes: [] });
    }
    const entry = { ...meta, launchedAt: now, matchedOrders: stamped };
    const inFlight = this.liveJson<any[]>('IN_FLIGHT_ROUNDS') || [];
    rows.push(['IN_FLIGHT_ROUNDS', JSON.stringify([...inFlight, entry]), 0]);
    rows.push(['MATCHED_ORDERS_LIST', JSON.stringify([]), 0]);
    this.commit(rows);
    return JSON.stringify({ parkedRound: entry, writes: rows.map(([k, v]) => [k, v]) });
  }

  /** Remove one parked round; returns it, or null if it was already gone. */
  async removeInFlight(roundId: string): Promise<string | null> {
    await this.ready;
    const inFlight = this.liveJson<any[]>('IN_FLIGHT_ROUNDS') || [];
    const target = inFlight.find((r) => r && r.roundId === roundId);
    if (!target) return null;
    this.commit([['IN_FLIGHT_ROUNDS', JSON.stringify(inFlight.filter((r) => r && r.roundId !== roundId)), 0]]);
    return JSON.stringify(target);
  }

  /** Wipe every key (Factory Reset). */
  async clear(): Promise<void> {
    await this.ready;
    this.cache.clear();
    this.ctx.storage.sql.exec('DELETE FROM state;');
  }

  // ── Refund claims ─────────────────────────────────────────────────────────

  /**
   * Take an exclusive claim on a named key. Returns true for exactly ONE caller
   * per key (until the TTL lapses, if one is given).
   *
   * A Durable Object handles one request at a time, so the read-then-write below
   * is a real compare-and-set — the only primitive in the system that can say
   * "I am the one and only actor for this", regardless of which region the
   * caller was served from or what the eventually-consistent KV caches hold.
   *
   * It exists because two separate defects needed it:
   *
   *   • Refunds. An order's status lives in `KV_ORDERS`. Every cancellation path
   *     did its own read-modify-write of it — read status → "still cancellable"
   *     → refund — so a player cancelling seconds after an admin cancel could be
   *     served the pre-cancel `pending_match` and be refunded twice.
   *
   *   • Slip credits. The same slip image can arrive more than once (the player
   *     re-sends it, LINE redelivers, or two uploads race). Crediting per
   *     verified `transRef` must happen exactly once, ever.
   *
   * Callers namespace their own keys (e.g. `REFUND:2963@1750000000000`).
   */
  async claimExclusive(claimKey: string, payloadJson: string, ttlMs: number = 0): Promise<boolean> {
    await this.ready;
    const key = `CLAIM_${claimKey}`;
    const now = Date.now();

    const existing = this.cache.get(key);
    if (existing && (!existing.exp || existing.exp > now)) {
      return false; // already claimed — the loser of the race stops here
    }

    const exp = ttlMs > 0 ? now + ttlMs : 0;
    this.cache.set(key, { v: payloadJson, exp });
    this.ctx.storage.sql.exec(
      'INSERT INTO state (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp;',
      key,
      payloadJson,
      exp
    );
    return true;
  }

  /** Read a claim back — used to audit a disputed refund or slip credit. */
  async getClaim(claimKey: string): Promise<string | null> {
    await this.ready;
    const row = this.cache.get(`CLAIM_${claimKey}`);
    if (!row) return null;
    if (row.exp && row.exp <= Date.now()) return null;
    return row.v;
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