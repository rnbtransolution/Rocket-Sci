/**
 * Regression harness for adminCloseRound ("ปิดรอบพอร์ทัล").
 *
 * Usage: node close-round-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const CREATED_AT = 1750000000000;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'close-round-harness-'));
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

const P1 = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'PLAYER 1' };
const P2 = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'PLAYER 2' };
const P3 = { shortId: 'PL000003', lineUserId: 'Uaaaaa0000000003', name: 'PLAYER 3' };

console.log('ADMIN CLOSE ROUND HARNESS ("ปิดรอบพอร์ทัล")\n');

const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'cr-cache', KV_ORDERS: 'cr-orders' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
  },
});

const kvO = await mf.getKVNamespace('KV_ORDERS');
const kvC = await mf.getKVNamespace('KV_CACHE');

const prof = (p, bal) => JSON.stringify({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });

for (const x of [
  { p: P1, bal: 500 },
  { p: P2, bal: 600 },
  { p: P3, bal: 600 },
]) {
  await kvC.put(`USER_${x.p.lineUserId}`, prof(x.p, x.bal));
  await kvC.put(`USER_${x.p.shortId}`, prof(x.p, x.bal));
  await kvC.put(`RAW_LINE_${x.p.shortId}`, x.p.lineUserId);
}

await kvC.put('PLAYERS_LIST', JSON.stringify([
  { id: P1.shortId, shortId: P1.shortId, lineUserId: P1.lineUserId, name: P1.name, balance: 500 },
  { id: P2.shortId, shortId: P2.shortId, lineUserId: P2.lineUserId, name: P2.name, balance: 600 },
  { id: P3.shortId, shortId: P3.shortId, lineUserId: P3.lineUserId, name: P3.name, balance: 600 },
]));

await kvC.put('TRANSACTIONS_LIST', JSON.stringify([
  { txId: 'TX1', playerId: P1.shortId, amount: 1000, status: 'approved' },
]));

await kvC.put('ACTIVE_GROUP_ID', 'C00000000000000000000000000000001');

// Orders
const pendingOrder = {
  orderNumber: '1001', creatorId: P1.shortId, creatorName: P1.name,
  creatorLineUserId: P1.lineUserId, side: 'low', amount: 500,
  betType: 'range', rangeMin: 330, rangeMax: 380,
  status: 'pending_match', createdAt: CREATED_AT, id: 'bet_1001',
};
await kvO.put('ORDER_1001', JSON.stringify(pendingOrder));

const matchedOrder = {
  orderNumber: '2001', creatorId: P2.shortId, creatorName: P2.name,
  creatorLineUserId: P2.lineUserId, side: 'low', amount: 400,
  betType: 'range', rangeMin: 330, rangeMax: 380,
  status: 'matched', createdAt: CREATED_AT, id: 'bet_2001',
  matcherId: P3.shortId, matcherName: P3.name, matcherLineUserId: P3.lineUserId,
};
await kvO.put('ORDER_2001', JSON.stringify(matchedOrder));

const settledOrder = {
  orderNumber: '3001', creatorId: P1.shortId, creatorName: P1.name,
  creatorLineUserId: P1.lineUserId, side: 'low', amount: 200,
  betType: 'range', rangeMin: 330, rangeMax: 380,
  status: 'settled', createdAt: CREATED_AT, id: 'bet_3001',
  matcherId: P2.shortId, matcherName: P2.name,
  winnerSide: 'low', winnerName: P1.name, settledAt: CREATED_AT,
};
await kvO.put('ORDER_3001', JSON.stringify(settledOrder));

await kvC.put('PENDING_ORDERS_LIST', JSON.stringify([pendingOrder]));
await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify([matchedOrder]));
await kvC.put('SETTLED_ORDERS_LIST', JSON.stringify([settledOrder]));

await kvC.put('ACTIVE_ROUND', JSON.stringify({
  name: 'สามารถ',
  targetMin: 300,
  targetMax: 350,
  status: 'VOID',
  isChotoy: false,
  quoteReleased: true,
  updatedAt: CREATED_AT,
}));

// Call adminCloseRound RPC
const res = await mf.dispatchFetch('http://localhost/api/run', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-key': ADMIN_KEY,
  },
  body: JSON.stringify({
    functionName: 'adminCloseRound',
    args: [],
  }),
});

check('adminCloseRound HTTP status is 200', res.status === 200);
const rawJson = await res.json();
const resData = rawJson?.data || rawJson;
check('adminCloseRound returns success: true', resData.success === true);
check('adminCloseRound refunded open orders', resData.clearedOrders === 2 || resData.clearedPending === 2);

await new Promise((r) => setTimeout(r, 400));

// Check Dashboard data
const dashRes = await mf.dispatchFetch('http://localhost/api/run', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-key': ADMIN_KEY,
  },
  body: JSON.stringify({
    functionName: 'getDashboardData',
    args: [],
  }),
});
const dash = (await dashRes.json())?.data || {};

check('Active Round name reset to บั้งไฟสด', dash.activeRound?.name === 'บั้งไฟสด');
check('Active Round status reset to ACTIVE', dash.activeRound?.status === 'ACTIVE');
check('Active Round quoteReleased reset to false', dash.activeRound?.quoteReleased === false);
check('Pending duel board is empty', (dash.bets || []).length === 0);

// Check P2P results
const p2pRes = await mf.dispatchFetch('http://localhost/api/run', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-key': ADMIN_KEY,
  },
  body: JSON.stringify({
    functionName: 'getP2PResults',
    args: [],
  }),
});
const p2p = (await p2pRes.json())?.data || {};
check('Settled / P2P list is reset to empty', (p2p.p2pResults || []).length === 0);

// Check Balances and Users ("except user and credit")
const bal = (id) => {
  const p = (dash.players || []).find((x) => x.id === id || x.shortId === id);
  return p ? Number(p.balance) : NaN;
};

check('P1 refunded 500pt from pending order -> balance 1000', bal(P1.shortId) === 1000, `got ${bal(P1.shortId)}`);
check('P2 refunded 400pt from matched order -> balance 1000', bal(P2.shortId) === 1000, `got ${bal(P2.shortId)}`);
check('P3 refunded 400pt from matched order -> balance 1000', bal(P3.shortId) === 1000, `got ${bal(P3.shortId)}`);

// Check preservation of Players list and Transactions
check('Players roster preserved (3 players)', (dash.players || []).length === 3);
check('Transactions list preserved (1 transaction)', (dash.transactions || []).length === 1);
check('Active group preserved', dash.activeGroupId === 'C00000000000000000000000000000001');

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);

await mf.dispose();
try { rmSync(outDir, { recursive: true }); } catch (_) {}

if (fail > 0) process.exit(1);
