/**
 * Regression harness: the Durable Object's memory no longer grows with every
 * order, and finished history older than 30 days is swept.
 *
 * THE BUG (review finding F-01)
 * ----------------------------
 * The DO loaded the whole `state` table into an in-memory Map on every cold
 * start, and kept every write there forever. ORDER_*, SETTLED_DAY_* and CLAIM_*
 * have no expiry, so memory and start-up time grew with total history until
 * the object hit its 128 MB limit.
 *
 * ASSERTED HERE
 *  * cold keys (ORDER_, SETTLED_DAY_, CLAIM_) are readable and writable but
 *    never held in memory — not after writes, not after a restart;
 *  * a ledger txn still settles an order and pays the winner (reads go to SQLite);
 *  * prefix scans (Factory Reset uses them) still see cold keys;
 *  * the hourly sweep drops finished orders and daily summaries older than 30
 *    days, and keeps: recent ones, anything still pending / matched (a stake is
 *    held), claims (they prevent double credit), and unreadable rows.
 *
 * Usage:  node do-retention-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = NOW - 40 * DAY;
const RECENT = NOW - 5 * DAY;
const dayKey = (t) => `SETTLED_DAY_${new Date(t).toISOString().slice(0, 10)}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'retention-harness-'));
const persistDir = join(outDir, 'do');
const bundlePath = join(outDir, 'worker.mjs');
await build({
  entryPoints: ['src/index.ts'],
  bundle: true, format: 'esm', platform: 'neutral',
  mainFields: ['module', 'main'], conditions: ['worker', 'browser'],
  external: ['cloudflare:workers'], outfile: bundlePath,
  banner: {
    js: `{ const __s=function(n){return this.get(this.idFromName(n));};
          Object.defineProperty(Object.prototype,'getByName',
            {value:__s,configurable:true,writable:true,enumerable:false}); }`,
  },
  logLevel: 'error',
});

const boot = () => new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'rt-c', KV_ORDERS: 'rt-o' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  durableObjectsPersist: persistDir,
  outboundService: () => new Response('{}', { status: 200 }),
  bindings: {
    ADMIN_API_KEY: 'k', SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', ENVIRONMENT: 'test',
  },
});
const stubOf = async (mf) => {
  const ns = await mf.getDurableObjectNamespace('ROCKET_STATE');
  return ns.get(ns.idFromName('rocket-global-state'));
};
// From Node, a stub's get/put/delete are HTTP verbs, not RPC — read via multi().
const read = async (stub, key) => (await stub.multi([key]))[0];

const A = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'ALPHA' };
const B = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'BRAVO' };
const prof = (p, bal) => JSON.stringify({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: OLD, updatedAt: OLD });
const ord = (n, status, extra = {}) => [`ORDER_${n}`, JSON.stringify({
  orderNumber: String(n), status, amount: 100, side: 'low', rangeMin: 350, rangeMax: 400,
  creatorId: A.shortId, creatorLineUserId: A.lineUserId, creatorName: A.name,
  matcherId: B.shortId, matcherLineUserId: B.lineUserId, matcherName: B.name,
  createdAt: OLD, ...extra,
})];

console.log('DO RETENTION HARNESS\n');

let mf = boot();
let stub = await stubOf(mf);

console.log('[1] Cold keys are not held in memory');
const baseline = (await stub.stats()).keys;
const bulk = [];
for (let i = 0; i < 300; i++) bulk.push(ord(10000 + i, 'settled', { settledAt: RECENT }));
await stub.writeMany(bulk);
await stub.writeMany([[dayKey(RECENT), '[]'], ['CLAIM_REFUND:1@1', '{}']]);
check('300 order writes add nothing to memory', (await stub.stats()).keys === baseline, `keys ${baseline} -> ${(await stub.stats()).keys}`);
check('a cold key reads back from SQLite', JSON.parse(await read(stub, 'ORDER_10042') || 'null')?.orderNumber === '10042');
check('batched read serves cold keys', (await stub.multi(['ORDER_10001', 'ORDER_10299', 'ORDER_NOPE'])).map((v) => (v ? JSON.parse(v).orderNumber : null)).join() === '10001,10299,');
check('prefix scan sees cold keys', (await stub.keys('ORDER_')).length === 300, `${(await stub.keys('ORDER_')).length}`);
check('prefix scan of a hot prefix skips them', (await stub.keys('USER_')).every((k) => k.startsWith('USER_')));
check('a claim is still exclusive', (await stub.claimExclusive('SLIP:abc', '{}')) === true && (await stub.claimExclusive('SLIP:abc', '{}')) === false);

console.log('\n[2] Ledger txn reads cold orders from SQLite');
await stub.writeMany([
  [`USER_${A.lineUserId}`, prof(A, 900)], [`USER_${A.shortId}`, prof(A, 900)], [`RAW_LINE_${A.shortId}`, A.lineUserId],
  [`USER_${B.lineUserId}`, prof(B, 900)], [`USER_${B.shortId}`, prof(B, 900)], [`RAW_LINE_${B.shortId}`, B.lineUserId],
  ord(20001, 'matched'),
]);
const txn = JSON.parse(await stub.txn(JSON.stringify({
  orders: [{ orderNumber: '20001', expectStatus: ['matched'], settle: { finalSeconds: 300, tMin: 350, tMax: 400, commissionRate: 0.1 } }],
})));
check('txn settles the order', txn.ok === true && txn.orders['20001']?.status === 'settled', JSON.stringify({ ok: txn.ok, reason: txn.reason }));
check('winner paid 100 + 90', txn.balances.find((b) => b.shortId === A.shortId)?.after === 1090, JSON.stringify(txn.balances));
const again = JSON.parse(await stub.txn(JSON.stringify({
  orders: [{ orderNumber: '20001', expectStatus: ['matched'], settle: { finalSeconds: 300, tMin: 350, tMax: 400, commissionRate: 0.1 } }],
})));
check('settling it again is refused (status read from SQLite)', again.ok === false && again.reason === 'order_status', again.reason);

console.log('\n[3] Restart: memory still excludes cold keys');
await mf.dispose();
mf = boot();
stub = await stubOf(mf);
const afterRestart = (await stub.stats()).keys;
check('cold start loads no orders into memory', afterRestart < 20, `keys=${afterRestart}`);
check('orders survive the restart', JSON.parse(await read(stub, 'ORDER_20001') || 'null')?.status === 'settled');
check('balances survive the restart', JSON.parse(await read(stub, `USER_${A.lineUserId}`) || 'null')?.balance === 1090);

console.log('\n[4] 30-day sweep');
await stub.writeMany([
  ord(30001, 'settled', { settledAt: OLD }),
  ord(30002, 'cancelled', { refundedAt: OLD }),
  ord(30003, 'settled', { settledAt: RECENT }),
  ord(30004, 'matched'),               // created 40 days ago, stake still held
  ord(30005, 'pending_match'),
  ord(30006, 'void'),                  // no finish time: falls back to createdAt (old)
  ['ORDER_30007', 'not json {{{'],
  [dayKey(OLD), '[]'],
  [dayKey(RECENT), '[]'],
  ['CLAIM_REFUND:old@1', JSON.stringify({ at: OLD })],
]);
const swept = await stub.sweepRetention(); // what the hourly alarm runs
check('sweep reports what it dropped', swept.orders === 3 && swept.days === 1, JSON.stringify(swept));
const has = async (k) => (await read(stub, k)) !== null;
check('old settled order dropped', !(await has('ORDER_30001')));
check('old cancelled order dropped', !(await has('ORDER_30002')));
check('old void order dropped (by createdAt)', !(await has('ORDER_30006')));
check('recent settled order kept', await has('ORDER_30003'));
check('old MATCHED order kept (stake held)', await has('ORDER_30004'));
check('old PENDING order kept (stake held)', await has('ORDER_30005'));
check('unreadable order row left alone', await has('ORDER_30007'));
check('old daily summary dropped', !(await has(dayKey(OLD))));
check('recent daily summary kept', await has(dayKey(RECENT)));
check('claims are never swept', await has('CLAIM_REFUND:old@1'));
check('players untouched', await has(`USER_${A.lineUserId}`));

await mf.dispose();
rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
