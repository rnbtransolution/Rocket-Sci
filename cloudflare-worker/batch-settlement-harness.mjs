/**
 * Regression harness: settling a big round in batches pays exactly what
 * settling every order on its own would.
 *
 * WHY
 * ---
 * Settlement used one ledger step per order: a 100-duel round meant 100
 * sequential Worker→DO round trips and 100 awaited KV mirrors while the admin
 * waited on the button. It now settles up to 20 orders per atomic step. A step
 * is all-or-nothing, so one bad order aborts its whole batch — which is then
 * settled one by one. Money must come out identical either way.
 *
 * THE ROUND (45 matched duels across 5 players, final time 345s)
 *  * low wins / high wins / draws, mixed stakes, the same players winning and
 *    losing several pairs inside one batch;
 *  * #8030 is still on the matched board but its record is already
 *    `cancelled` (refunded) — it must be skipped, and its batch must still pay
 *    the other 19.
 *
 * ASSERTED
 *  * every balance equals start − escrowed stakes + the per-order formula;
 *  * the platform keeps exactly Σ round(stake × 10%) of the decided duels;
 *  * #8030 stays cancelled and pays nothing; the 44 others are settled once;
 *  * a second settle click pays nothing more;
 *  * batching really happened: each clean batch shares one settledAt.
 *
 * Usage:  node batch-settlement-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const CREATED_AT = 1750000000000;
const START = 100_000;
const FINAL = 345;
const RATE = 0.10;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'batchset-harness-'));
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

const players = [1, 2, 3, 4, 5].map((n) => ({
  shortId: `PL00000${n}`, lineUserId: `Uaaaaa000000000${n}`, name: `P${n}`,
}));
const prof = (p, bal) => ({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });

// Ranges against FINAL=345: below 350 → low wins; above 340 → high wins; 340–350 → draw.
const RANGES = [[350, 400], [300, 340], [340, 350]];
const STAKES = [100, 150, 200, 250, 333, 500, 1000];
const CANCELLED = '8030';

const orders = [];
for (let i = 0; i < 45; i++) {
  const c = players[i % 5];
  const m = players[(i * 2 + 1) % 5 === i % 5 ? (i + 1) % 5 : (i * 2 + 1) % 5];
  const [rangeMin, rangeMax] = RANGES[i % 3];
  orders.push({
    orderNumber: String(8001 + i), id: `bet_${8001 + i}`, roundId: 'R_BIG',
    creatorId: c.shortId, creatorName: c.name, creatorLineUserId: c.lineUserId,
    matcherId: m.shortId, matcherName: m.name, matcherLineUserId: m.lineUserId,
    side: i % 2 ? 'high' : 'low', amount: STAKES[i % STAKES.length],
    betType: 'custom_range', rangeMin, rangeMax,
    status: String(8001 + i) === CANCELLED ? 'cancelled' : 'matched',
    createdAt: CREATED_AT + i, matchedAt: CREATED_AT + i,
  });
}

// Expected balances, order by order, from the confirmed rules.
const expected = new Map(players.map((p) => [p.shortId, START]));
let expectedFee = 0;
for (const o of orders) {
  if (o.status !== 'matched') continue; // the cancelled one was refunded earlier: no escrow
  expected.set(o.creatorId, expected.get(o.creatorId) - o.amount);
  expected.set(o.matcherId, expected.get(o.matcherId) - o.amount);
}
const escrowed = new Map(expected);
for (const o of orders) {
  if (o.status !== 'matched') continue;
  const side = FINAL < o.rangeMin ? 'low' : FINAL > o.rangeMax ? 'high' : 'draw';
  if (side === 'draw') {
    expected.set(o.creatorId, expected.get(o.creatorId) + o.amount);
    expected.set(o.matcherId, expected.get(o.matcherId) + o.amount);
  } else {
    const fee = Math.round(o.amount * RATE);
    const winner = o.side === side ? o.creatorId : o.matcherId;
    expected.set(winner, expected.get(winner) + o.amount * 2 - fee);
    expectedFee += fee;
  }
}

const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'bs-c', KV_ORDERS: 'bs-o' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  outboundService: () => new Response('{}', { status: 200 }),
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
  },
});
const kvO = await mf.getKVNamespace('KV_ORDERS');
const kvC = await mf.getKVNamespace('KV_CACHE');
const rpc = async (functionName, args) => (await (await mf.dispatchFetch('http://localhost/api/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
  body: JSON.stringify({ functionName, args }),
})).json())?.data;

for (const o of orders) await kvO.put(`ORDER_${o.orderNumber}`, JSON.stringify(o));
// The stale index still lists #8030 as matched — the record says otherwise.
await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify(orders.map((o) => ({ ...o, status: 'matched' }))));
await kvC.put('PLAYERS_LIST', JSON.stringify(players.map((p) => prof(p, escrowed.get(p.shortId)))));
for (const p of players) {
  await kvC.put(`USER_${p.lineUserId}`, JSON.stringify(prof(p, escrowed.get(p.shortId))));
  await kvC.put(`USER_${p.shortId}`, JSON.stringify(prof(p, escrowed.get(p.shortId))));
  await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
}
await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId: 'R_BIG', name: 'BIG', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));

console.log('BATCH SETTLEMENT HARNESS\n');

const t0 = Date.now();
const res = await rpc('adminResolveBets', [FINAL, 350, 400]);
const ms = Date.now() - t0;
console.log(`  (settled in ${ms} ms)`);
check('settlement succeeds', res?.success === true, JSON.stringify(res));
check('44 orders settled, the cancelled one skipped', res?.resolvedCount === 44, `resolvedCount=${res?.resolvedCount}`);

const balances = async () => {
  const d = (await rpc('getDashboardData', [])) || {};
  return new Map((d.players || []).map((p) => [p.shortId, Number(p.balance)]));
};
const after = await balances();
for (const p of players) {
  check(`${p.name} balance is exact`, after.get(p.shortId) === expected.get(p.shortId),
    `got ${after.get(p.shortId)}, expected ${expected.get(p.shortId)}`);
}
const totalBefore = [...escrowed.values()].reduce((a, b) => a + b, 0);
const stakesHeld = orders.filter((o) => o.status === 'matched').reduce((a, o) => a + o.amount * 2, 0);
const totalAfter = [...after.values()].reduce((a, b) => a + b, 0);
check('the platform keeps exactly the 10% fees', totalBefore + stakesHeld - totalAfter === expectedFee,
  `kept ${totalBefore + stakesHeld - totalAfter}, fees ${expectedFee}`);

const stored = await Promise.all(orders.map(async (o) => JSON.parse(await kvO.get(`ORDER_${o.orderNumber}`))));
const cancelled = stored.find((o) => o.orderNumber === CANCELLED);
check('#8030 stays cancelled, no payout', cancelled.status === 'cancelled' && !cancelled.payout, JSON.stringify({ s: cancelled.status, p: cancelled.payout }));
check('the other 44 are settled', stored.filter((o) => o.status === 'settled').length === 44);
const fees = stored.filter((o) => o.status === 'settled').reduce((a, o) => a + (Number(o.commission) || 0), 0);
check('stored commissions add up to the fees', fees === expectedFee, `${fees} vs ${expectedFee}`);

// Batching: queue order is the matched list; #8030 is the 30th, so batch 2
// (orders 21–40) falls back to one-by-one, batches 1 and 3 commit whole.
const at = (from, to) => new Set(stored.slice(from, to).map((o) => o.settledAt));
check('batch 1 (20 orders) committed as one step', at(0, 20).size === 1, `${at(0, 20).size} distinct settledAt`);
check('batch 3 (5 orders) committed as one step', at(40, 45).size === 1, `${at(40, 45).size} distinct settledAt`);

const sum = await rpc('adminGetDailySummary', []);
check('daily summary lists all 44 duels', sum?.count === 44, `count=${sum?.count}`);

const again = await rpc('adminResolveBets', [FINAL, 350, 400]);
const afterAgain = await balances();
check('a second settle click pays nothing', players.every((p) => afterAgain.get(p.shortId) === after.get(p.shortId)) && (again?.resolvedCount ?? 0) === 0,
  JSON.stringify(again));

await mf.dispose();
rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
