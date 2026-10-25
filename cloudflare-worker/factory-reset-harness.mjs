/**
 * Regression harness for the Factory Reset (resetGoogleSheetsDatabase).
 *
 * A reset is meant to leave nothing of the test period behind. It used to
 * clear players, transactions and the open board but keep every order record,
 * the matched and settled lists and the daily summaries, so orders naming
 * deleted players stayed visible to the admin tools — and a DO miss would
 * re-adopt an order straight from KV_ORDERS.
 *
 * Run: node factory-reset-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const ADMIN_KEY = 'test_admin_key';
const CH = 'test_secret';
const GID = 'C0123456789abcdef0123456789abcdef';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'factory-reset-harness-'));
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

const P1 = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'เสือใหญ่' };
const P2 = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'สิงห์เหนือ' };
const ADM = { shortId: 'PL000009', lineUserId: 'Uaaaaa0000000009', name: 'แอดมิน' };
const START = 5000;

const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'fr-c', KV_ORDERS: 'fr-o' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: CH, LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test', ADMIN_LINE_USER_IDS: ADM.lineUserId,
  },
});

// Seed players, plus a round and two open orders for the round-binding test:
// #7001 belongs to an OLD rocket, #7002 to the current one.
const kvC = await mf.getKVNamespace('KV_CACHE');
const kvO = await mf.getKVNamespace('KV_ORDERS');
const everyone = [P1, P2, ADM];
for (const p of everyone) {
  const prof = JSON.stringify({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: START, registeredAt: 1, updatedAt: 1 });
  await kvC.put(`USER_${p.lineUserId}`, prof);
  await kvC.put(`USER_${p.shortId}`, prof);
  await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
}
await kvC.put('PLAYERS_LIST', JSON.stringify(everyone.map((p) => ({ id: p.shortId, shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: START }))));
await kvC.put('ACTIVE_GROUP_ID', GID);
await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId: 'RND_CURRENT', name: 'SEED', targetMin: 330, targetMax: 380, status: 'ACTIVE', isChotoy: false, quoteReleased: true, updatedAt: 1 }));
const seedOrder = (no, roundId) => ({
  orderNumber: no, creatorId: P1.shortId, creatorName: P1.name, creatorLineUserId: P1.lineUserId,
  side: 'high', amount: 300, betType: 'custom_range', rangeMin: 300, rangeMax: 350, status: 'pending_match',
  groupId: GID, rocketName: 'SEED', roundId, createdAt: 1750000000000 + Number(no), id: `bet_${no}`,
  playerHighId: P1.shortId, playerHighName: P1.name,
});
const o7001 = seedOrder('7001', 'RND_OLD');
const o7002 = seedOrder('7002', 'RND_CURRENT');
await kvO.put('ORDER_7001', JSON.stringify(o7001));
await kvO.put('ORDER_7002', JSON.stringify(o7002));
await kvC.put('PENDING_ORDERS_LIST', JSON.stringify([o7001, o7002]));

// A matched order, a settled day and a used slip, as the test period leaves them.
const matched = { ...o7002, orderNumber: '7003', id: 'bet_7003', status: 'matched', matcherId: P2.shortId, matcherName: P2.name };
await kvO.put('ORDER_7003', JSON.stringify(matched));
await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify([matched]));
await kvC.put('SETTLED_ORDERS_LIST', JSON.stringify([{ ...matched, status: 'settled' }]));
await kvC.put('SETTLED_DAY_2026-10-25', JSON.stringify([{ ...matched, status: 'settled', settledAt: 1 }]));

const rpc = async (functionName, args = []) => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  });
  return (await res.json())?.data;
};

console.log('\nFACTORY RESET HARNESS\n');

// Touch the orders through the Worker so the DO holds its own copies too.
for (const no of ['7001', '7002', '7003']) await rpc('adminInspectOrder', [no]);
const before = await rpc('adminListOrders', []);
check('seeded orders are visible before the reset', before?.count === 3, `count=${before?.count}`);

const refused = await rpc('resetGoogleSheetsDatabase', ['000000']);
check('reset without the right PIN is refused', !refused?.success, JSON.stringify(refused));

await rpc('adminSetDangerPin', ['583920']);
const res = await rpc('resetGoogleSheetsDatabase', ['583920']);
check('reset with the PIN succeeds', res?.success === true, JSON.stringify(res));
check('reset reports the orders it cleared', Number(res?.ordersCleared) >= 3, `ordersCleared=${res?.ordersCleared}`);

const after = await rpc('adminListOrders', []);
check('no order records remain', after?.count === 0, `count=${after?.count}`);
for (const no of ['7001', '7002', '7003']) {
  const r = await rpc('adminInspectOrder', [no]);
  check(`order #${no} is gone from DO and KV (not re-adopted)`, r?.found === false, JSON.stringify(r)?.slice(0, 120));
}
const dash = await rpc('getDashboardData', []);
check('players, transactions and board are empty', dash?.players?.length === 0 && dash?.transactions?.length === 0 && dash?.bets?.length === 0,
  JSON.stringify({ p: dash?.players?.length, t: dash?.transactions?.length, b: dash?.bets?.length }));
check('active LINE group is kept', dash?.activeGroupId === GID, dash?.activeGroupId);
const sum = await rpc('adminGetDailySummary', ['2026-10-25']);
check('daily summary for the test period is empty', sum?.count === 0, `count=${sum?.count}`);
const pin = await rpc('adminGetDangerPinStatus', []);
check('reset PIN stays configured', pin?.configured === true, JSON.stringify(pin));

console.log(`\n${pass} passed, ${fail} failed`);
await mf.dispose();
process.exit(fail ? 1 : 0);
