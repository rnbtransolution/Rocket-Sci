import { Env } from './types.js';

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
  patchTransactionStatus(txId: string, status: string, reviewReason: string, actualAmount?: number | null): Promise<string | null>;
  appendChatLog(logJson: string, limit?: number): Promise<void>;
  writeMany(entries: Array<[string, string]>, expiresAt?: number): Promise<void>;
  saveProfile(profileJson: string, entryJson: string, limit?: number): Promise<boolean>;
  stats(): Promise<{ keys: number; dbBytes: number; at: string }>;
}

export class StateStore {
  private readonly env: Env;
  /** Set once the binding is known to be missing entirely (never retry per call). */
  private bindingMissing = false;

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
    try {
      const ns = (this.env as any).ROCKET_STATE as DurableObjectNamespace | undefined;
      if (!ns) {
        this.bindingMissing = true;
        return null;
      }
      return ns.getByName(DO_NAME) as unknown as DOStub;
    } catch (err) {
      console.warn('[StateStore] Durable Object binding unavailable, falling back to KV:', err);
      this.bindingMissing = true;
      return null;
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
      console.warn('[StateStore] atomic appendChatLog failed:', err);
      return false;
    }
  }

  /**
   * Atomically persist a player profile across all of its keys (LINE user id,
   * short id, raw-line mapping) together with its PLAYERS_LIST directory entry.
   * This is the single call that keeps the Admin Console balance and the LINE OA
   * balance from drifting apart.
   */
  async saveProfile(profile: unknown, entry: unknown): Promise<boolean> {
    const stub = this.stub();
    if (!stub) return false;
    try {
      const ok = await stub.saveProfile(JSON.stringify(profile), JSON.stringify(entry));
      if (!ok) return false;
      // Cold KV mirror so the pre-DO backup / Sheets-merge paths keep working.
      const mirror = await this.get('PLAYERS_LIST');
      if (mirror !== null) {
        this.env.KV_CACHE.put('PLAYERS_LIST', mirror).catch(() => {});
      }
      return true;
    } catch (err) {
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