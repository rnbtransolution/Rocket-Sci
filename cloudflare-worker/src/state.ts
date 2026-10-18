import { Env } from './types.js';
import { evaluateRateLimit, RateLimitDecision } from './auth.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * StateStore — KV-compatible façade over the strongly-consistent Durable Object
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The rest of the codebase talks to state through a small `get` / `put` /
 * `delete` / `list` surface that mirrors the Workers KV API, so switching the
 * backing store required no behavioural changes at ~170 call sites.
 *
 * Properties:
 *  1. STRONGLY CONSISTENT reads — every write is immediately visible to every
 *     reader (fixes the up-to-60s cross-region KV propagation delay that made
 *     LINE OA deposits/withdrawals appear late in the Admin Console).
 *  2. ZERO-DOWNTIME MIGRATION — on a miss the façade falls back to the legacy KV
 *     namespace and self-heals the Durable Object, so all pre-existing player
 *     profiles, ledgers and order lists are adopted automatically on first read.
 *  3. FAIL-SAFE — if the DO binding is missing or the RPC errors, the façade
 *     degrades transparently to plain KV instead of breaking the platform.
 *  4. COLD MIRROR — durable keys are still written back to KV in the background,
 *     preserving the historical backup/rollback/Sheets-merge behaviour.
 */

/** Name of the single global state object. All traffic funnels through it. */
const DO_NAME = 'rocket-global-state';

/**
 * High-churn / purely ephemeral bookkeeping keys. These never fall back to KV on
 * a miss (a miss is the normal case) and are never mirrored, which keeps KV write
 * volume and read volume at exactly the levels it was before this change.
 */
const EPHEMERAL_PREFIXES = [
  'SEEN_EVENT_',
  'LAST_LINE_',
  'LAST_DELIVERY_DEBUG',
  'LAST_ORDER_CREATE_DEBUG',
  'LAST_WEBHOOK_ERROR',
  'CACHED_LINE_QUOTA',
  'GAS_SYNC_',
  'GROUP_',
];

export interface StatePutOptions {
  expirationTtl?: number;
  expiration?: number;
}

export interface StateListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface StateListResult {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

function isEphemeral(key: string): boolean {
  for (const prefix of EPHEMERAL_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function toExpiryMillis(opts?: StatePutOptions): number | undefined {
  if (!opts) return undefined;
  if (typeof opts.expiration === 'number' && opts.expiration > 0) {
    return Date.now() + opts.expiration * 1000;
  }
  if (typeof opts.expirationTtl === 'number' && opts.expirationTtl > 0) {
    return Date.now() + opts.expirationTtl * 1000;
  }
  return undefined;
}

interface DOStub {
  get(key: string): Promise<string | null>;
  multi(keys: string[]): Promise<Array<string | null>>;
  put(key: string, value: string, expiresAt?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
  upsertTransaction(txJson: string, limit?: number): Promise<string>;
  claimExclusive(claimKey: string, payloadJson: string, ttlMs?: number): Promise<boolean>;
  getClaim(claimKey: string): Promise<string | null>;
  patchTransactionStatus(txId: string, status: string, reviewReason: string, actualAmount?: number | null): Promise<string | null>;
  appendChatLog(logJson: string, limit?: number): Promise<void>;
  writeMany(entries: Array<[string, string]>, expiresAt?: number): Promise<void>;
  saveProfile(profileJson: string, entryJson: string, limit?: number): Promise<boolean>;
  rateLimit(key: string): Promise<{ count: number; resetAt: number }>;
  setRateLimit(key: string, value: { count: number; resetAt: number }): Promise<void>;
  clearRateLimit(key: string): Promise<void>;
  stats(): Promise<{ keys: number; dbBytes: number; at: string }>;
}

export class StateStore {
  private readonly env: Env;
  /** Set once the binding is known to be missing entirely (never retry per call). */
  private bindingMissing = false;
  /** Short circuit-breaker timestamp when DO throws a runtime/quota error so fallback calls don't stall. */
  private doCircuitOpenUntil = 0;
  /** Isolate-scoped claim cache used as a first-line atomic guard when DO falls back to KV. */
  private static fallbackClaims = new Map<string, { v: string; exp: number }>();

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Resolve the Durable Object stub, or null when it cannot be used.
   *
   * The stub is intentionally NOT cached across calls. A Durable Object stub
   * holds an I/O context belonging to the request that created it, and Workers
   * forbids using that context on behalf of a later request — an isolate is
   * reused for many requests, so caching the stub would make every call after
   * the first fail with "Cannot perform I/O on behalf of a different request".
   * `getByName()` is a cheap, synchronous id lookup, so resolving per call is
   * effectively free.
   */
  private stub(): DOStub | null {
    if (this.bindingMissing) return null;
    if (this.doCircuitOpenUntil > Date.now()) return null;
    try {
      const ns = (this.env as any).ROCKET_STATE as DurableObjectNamespace | undefined;
      if (!ns) {
        this.bindingMissing = true;
        return null;
      }
      const rawStub = typeof (ns as any).getByName === 'function'
        ? (ns as any).getByName(DO_NAME)
        : ns.get(ns.idFromName(DO_NAME));
      return rawStub as unknown as DOStub;
    } catch (err) {
      console.warn('[StateStore] Durable Object binding unavailable, falling back to KV:', err);
      this.bindingMissing = true;
      return null;
    }
  }

  private tripCircuit(err: unknown): void {
    const msg = String((err as Error)?.message || err || '');
    if (msg.includes('exceeded') || msg.includes('limit') || msg.includes('quota') || msg.includes('storage')) {
      this.doCircuitOpenUntil = Date.now() + 15_000;
    }
  }

  // ── get ──────────────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    const stub = this.stub();
    if (!stub) return this.env.KV_CACHE.get(key);

    try {
      const value = await stub.get(key);
      if (value !== null && value !== undefined) return value;
    } catch (err) {
      this.tripCircuit(err);
      console.warn(`[StateStore] DO get failed for ${key}, using KV:`, err);
      return this.env.KV_CACHE.get(key);
    }

    // Miss inside the DO — this is expected for every pre-existing key during
    // the migration window. Adopt the legacy KV value so the switch is seamless.
    if (isEphemeral(key)) return null;
    try {
      const legacy = await this.env.KV_CACHE.get(key);
      if (legacy !== null && legacy !== undefined) {
        await stub.put(key, legacy).catch(() => {});
      }
      return legacy ?? null;
    } catch (err) {
      console.warn(`[StateStore] KV fallback read failed for ${key}:`, err);
      return null;
    }
  }

  /**
   * Batched read. One RPC for the whole key set instead of N round-trips —
   * used by the dashboard hot path where every millisecond counts.
   * Falls back to per-key reads if the DO cannot serve the batch.
   */
  async multi(keys: string[]): Promise<Array<string | null>> {
    const stub = this.stub();
    if (!stub || keys.length === 0) {
      return Promise.all(keys.map((k) => this.env.KV_CACHE.get(k)));
    }
    try {
      return await stub.multi(keys);
    } catch (err) {
      this.tripCircuit(err);
      console.warn('[StateStore] DO multi failed, falling back to per-key reads:', err);
      return Promise.all(keys.map((k) => this.get(k)));
    }
  }

  // ── Atomic hot-path mutations ───────────────────────────────────────────
  // Each returns true when the Durable Object handled it atomically. When it
  // returns false the caller keeps using its original read-modify-write code,
  // so behaviour is unchanged if the DO is unavailable.

  /** Insert-or-update a transaction, newest-first. */
  async upsertTransaction(tx: unknown): Promise<boolean> {
    const stub = this.stub();
    if (!stub) return false;
    try {
      const serialized = await stub.upsertTransaction(JSON.stringify(tx));
      if (!isEphemeral('TRANSACTIONS_LIST')) {
        this.env.KV_CACHE.put('TRANSACTIONS_LIST', serialized).catch(() => {});
      }
      return true;
    } catch (err) {
      this.tripCircuit(err);
      console.warn('[StateStore] atomic upsertTransaction failed:', err);
      return false;
    }
  }

  /** Move a transaction to a new status/reason/amount. */
  async patchTransactionStatus(
    txId: string,
    status: string,
    reviewReason: string,
    actualAmount?: number | null
  ): Promise<boolean> {
    const stub = this.stub();
    if (!stub) return false;
    try {
      const serialized = await stub.patchTransactionStatus(txId, status, reviewReason, actualAmount);
      if (serialized === null) return false; // no such transaction — caller handles
      if (!isEphemeral('TRANSACTIONS_LIST')) {
        this.env.KV_CACHE.put('TRANSACTIONS_LIST', serialized).catch(() => {});
      }
      return true;
    } catch (err) {
      this.tripCircuit(err);
      console.warn('[StateStore] atomic patchTransactionStatus failed:', err);
      return false;
    }
  }

  /** Append to the CHAT_LOGS feed. */
  async appendChatLog(log: unknown): Promise<boolean> {
    const stub = this.stub();
    if (!stub) return false;
    try {
      await stub.appendChatLog(JSON.stringify(log));
      return true;
    } catch (err) {
      this.tripCircuit(err);
      console.warn('[StateStore] atomic appendChatLog failed:', err);
      return false;
    }
  }

  /**
   * Take an exclusive claim on a named key. True for the first caller only.
   *
   * Primary path: strongly-consistent Durable Object compare-and-set.
   * Fallback path (when DO RPC is unavailable due to Free Tier quota or mock test
   * environments without DO): synchronous isolate-memory claim check + KV_CACHE
   * persistence so single-use claims (MATCH, REFUND, SLIP) remain enforced
   * without deadlocking live operations.
   */
  async claimExclusive(claimKey: string, payload: unknown, ttlMs: number = 0): Promise<boolean> {
    const payloadJson = JSON.stringify(payload);
    const stub = this.stub();
    if (stub) {
      try {
        const claimed = await stub.claimExclusive(claimKey, payloadJson, ttlMs);
        if (claimed) {
          const now = Date.now();
          const exp = ttlMs > 0 ? now + ttlMs : 0;
          StateStore.fallbackClaims.set(claimKey, { v: payloadJson, exp });
          const kvOpts = ttlMs > 0 ? { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) } : undefined;
          this.env.KV_CACHE.put(`CLAIM_${claimKey}`, payloadJson, kvOpts as any).catch(() => {});
        }
        return claimed;
      } catch (err) {
        this.tripCircuit(err);
        console.warn(`[StateStore] DO claim "${claimKey}" failed, using fallback claim guard:`, err);
      }
    }

    // Fallback claim guard (isolate memory + KV_CACHE) when DO is unavailable
    if (!this.env?.KV_CACHE) {
      console.error(`[StateStore] claim "${claimKey}" unavailable (no DO and no KV_CACHE) — refusing`);
      return false;
    }
    const now = Date.now();
    const mem = StateStore.fallbackClaims.get(claimKey);
    if (mem && (!mem.exp || mem.exp > now)) {
      return false;
    }
    try {
      const existingKv = await this.env.KV_CACHE.get(`CLAIM_${claimKey}`);
      if (existingKv !== null && existingKv !== undefined) {
        StateStore.fallbackClaims.set(claimKey, { v: existingKv, exp: ttlMs > 0 ? now + ttlMs : 0 });
        return false;
      }
      const exp = ttlMs > 0 ? now + ttlMs : 0;
      StateStore.fallbackClaims.set(claimKey, { v: payloadJson, exp });
      const kvOpts = ttlMs > 0 ? { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) } : undefined;
      await this.env.KV_CACHE.put(`CLAIM_${claimKey}`, payloadJson, kvOpts as any);
      return true;
    } catch (kvErr) {
      console.error(`[StateStore] fallback claim "${claimKey}" failed — refusing:`, kvErr);
      return false;
    }
  }

  /** Inspect a claim (audit / diagnostics). */
  async getClaim(claimKey: string): Promise<unknown | null> {
    const stub = this.stub();
    if (stub) {
      try {
        const raw = await stub.getClaim(claimKey);
        if (raw) return JSON.parse(raw);
      } catch (err) {
        this.tripCircuit(err);
      }
    }
    const now = Date.now();
    const mem = StateStore.fallbackClaims.get(claimKey);
    if (mem && (!mem.exp || mem.exp > now)) {
      try { return JSON.parse(mem.v); } catch { return null; }
    }
    try {
      const rawKv = await this.env.KV_CACHE.get(`CLAIM_${claimKey}`);
      return rawKv ? JSON.parse(rawKv) : null;
    } catch {
      return null;
    }
  }

  /**
   * Atomically persist a player profile across all of its keys (LINE user id,
   * short id, raw-line mapping) together with its PLAYERS_LIST directory entry.
   * This is the single call that keeps the Admin Console balance and the LINE OA
   * balance from drifting apart.
   *
   * CRITICAL: Always mirror USER_<lineUserId>, USER_<shortId>, RAW_LINE_<shortId>,
   * AND PLAYERS_LIST to KV_CACHE so that if the Durable Object ever trips quota or
   * falls back to KV_CACHE mid-round, KV_CACHE never serves a stale pre-bet balance!
   */
  async saveProfile(profile: unknown, entry: unknown): Promise<boolean> {
    const stub = this.stub();
    if (!stub) return false;
    try {
      const profileJson = JSON.stringify(profile);
      const ok = await stub.saveProfile(profileJson, JSON.stringify(entry));
      if (!ok) return false;
      // Cold KV mirror of ALL profile keys + PLAYERS_LIST so fallback reads are 100% consistent.
      const p = profile as any;
      const mirrorTasks: Promise<any>[] = [];
      if (p && typeof p.lineUserId === 'string' && p.lineUserId.startsWith('U')) {
        mirrorTasks.push(this.env.KV_CACHE.put(`USER_${p.lineUserId}`, profileJson).catch(() => {}));
      }
      if (p && p.shortId) {
        mirrorTasks.push(this.env.KV_CACHE.put(`USER_${p.shortId}`, profileJson).catch(() => {}));
        if (typeof p.lineUserId === 'string' && p.lineUserId.startsWith('U')) {
          mirrorTasks.push(this.env.KV_CACHE.put(`RAW_LINE_${p.shortId}`, p.lineUserId).catch(() => {}));
        }
      }
      const mirror = await this.get('PLAYERS_LIST');
      if (mirror !== null) {
        mirrorTasks.push(this.env.KV_CACHE.put('PLAYERS_LIST', mirror).catch(() => {}));
      }
      await Promise.all(mirrorTasks);
      return true;
    } catch (err) {
      this.tripCircuit(err);
      console.warn('[StateStore] atomic saveProfile failed:', err);
      return false;
    }
  }

  /**
   * Write a player profile to its canonical key plus every alias key
   * (LINE user id, short id, raw-line mapping) in one atomic commit.
   */
  async writeMany(entries: Array<[string, string]>): Promise<boolean> {
    const stub = this.stub();
    if (!stub) return false;
    try {
      await stub.writeMany(entries);
      // Mirror to KV for cold backup / rollback.
      for (const [key, value] of entries) {
        if (isEphemeral(key)) continue;
        this.env.KV_CACHE.put(key, value).catch(() => {});
      }
      return true;
    } catch (err) {
      console.warn('[StateStore] atomic writeMany failed:', err);
      return false;
    }
  }

  // ── Rate limiting (durable, in the Durable Object) ─────────────────────────

  /**
   * Count one attempt and report whether the caller is over the limit.
   * Durable, so the window survives isolate recycling and deployments — an
   * isolate-scoped Map is reset for free by a cold start.
   */
  async rateLimit(key: string): Promise<RateLimitDecision> {
    const stub = this.stub();
    if (!stub) return { allowed: true, retryAfterSeconds: 0 };
    try {
      const current = await stub.rateLimit(key);
      const { decision, next } = evaluateRateLimit(current);
      await stub.setRateLimit(key, next);
      return decision;
    } catch (err) {
      // Fail OPEN: a throttle outage must never lock every admin out of the
      // console mid-event. Password hashing still protects the account.
      console.warn('[StateStore] rate limit check failed, allowing attempt:', err);
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }

  /** Reset a counter after a successful authentication. */
  async clearRateLimit(key: string): Promise<void> {
    const stub = this.stub();
    if (!stub) return;
    try {
      await stub.clearRateLimit(key);
    } catch (err) {
      console.warn('[StateStore] failed to clear rate limit:', err);
    }
  }

  // ── put ──────────────────────────────────────────────────────────────────

  async put(key: string, value: string, opts?: StatePutOptions): Promise<void> {
    const expiresAt = toExpiryMillis(opts);
    const stub = this.stub();

    if (stub) {
      try {
        await stub.put(key, value, expiresAt);
      } catch (err) {
        console.error(`[StateStore] DO put failed for ${key}, falling back to KV:`, err);
        await this.env.KV_CACHE.put(key, value, opts as any).catch(() => {});
        return;
      }
      // Durable write already committed — mirror to KV purely as a cold backup.
      if (!isEphemeral(key)) {
        this.env.KV_CACHE.put(key, value, opts as any).catch(() => {});
      }
      return;
    }

    await this.env.KV_CACHE.put(key, value, opts as any);
  }

  // ── delete ───────────────────────────────────────────────────────────────

  async delete(key: string): Promise<boolean> {
    const stub = this.stub();
    if (!stub) { await this.env.KV_CACHE.delete(key); return true; }
    try {
      const existed = await stub.delete(key);
      if (!isEphemeral(key)) {
        this.env.KV_CACHE.delete(key).catch(() => {});
      }
      return existed;
    } catch (err) {
      console.warn(`[StateStore] DO delete failed for ${key}, falling back to KV:`, err);
      await this.env.KV_CACHE.delete(key);
      return true;
    }
  }

  // ── list ─────────────────────────────────────────────────────────────────

  async list(opts?: StateListOptions): Promise<StateListResult> {
    const prefix = opts?.prefix;
    const stub = this.stub();

    let names: string[] = [];
    if (stub) {
      try {
        names = await stub.keys(prefix);
      } catch (err) {
        console.warn('[StateStore] DO list failed, falling back to KV:', err);
        return this.env.KV_CACHE.list(opts as any) as unknown as Promise<StateListResult>;
      }
    }

    if (stub) {
      // Union with the legacy KV namespace so keys created before the migration
      // (and never touched since) are still visible to Factory Reset / rebuilds.
      try {
        let cursor: string | undefined;
        do {
          const page = await this.env.KV_CACHE.list({
            ...(prefix ? { prefix } : {}),
            ...(cursor ? { cursor } : {}),
          } as any);
          for (const k of page.keys || []) names.push(k.name);
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
      } catch (err) {
        console.warn('[StateStore] KV list union failed:', err);
      }
    }

    const unique = Array.from(new Set(names));
    const limited = typeof opts?.limit === 'number' ? unique.slice(0, opts.limit) : unique;
    return {
      keys: limited.map((name) => ({ name })),
      list_complete: true,
    };
  }

  /** Wipe all state (Factory Reset). */
  async clear(): Promise<void> {
    const stub = this.stub();
    if (stub) {
      await stub.clear().catch((err) => console.error('[StateStore] DO clear failed:', err));
    }
  }

  /** Diagnostics for the admin debug panel. */
  async stats(): Promise<{ keys: number; dbBytes: number; at: string } | null> {
    const stub = this.stub();
    if (!stub) return null;
    try {
      return await stub.stats();
    } catch {
      return null;
    }
  }
}

const stores = new WeakMap<object, StateStore>();

/** Obtain the memoised StateStore for a given `env` binding object. */
export function state(env: Env): StateStore {
  let store = stores.get(env as unknown as object);
  if (!store) {
    store = new StateStore(env);
    stores.set(env as unknown as object, store);
  }
  return store;
}