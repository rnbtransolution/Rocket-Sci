/**
 * Regression harness for void-round refunds (โมฆะรอบ).
 *
 * THE REPORT
 * ----------
 *   A creates a 500pt order.
 *   B matches it for 500pt.
 *   Admin voids the round, so both sides get their stake back.
 *   B was credited 1000pt instead of 500pt.
 *
 * A void must return each player exactly what they staked and nothing more.
 * The failure mode is not "credited a little" but "credited twice", which is
 * the more dangerous shape: the claim that makes this idempotent is
 * `orderNumber@createdAt`, so anything that produces a SECOND order for the
 * same bet — or a second pass over the same order with a different key — pays
 * the matcher again.
 *
 * This drives the real void RPC against the real worker and asserts the exact
 * post-void balance for both sides.
 *
 * Usage:  node void-round-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
/** Voiding a round takes the danger PIN; each scenario sets it first. */
const VOID_PIN = '7391';
const setVoidPin = async (mf) => (await mf.dispatchFetch('http://localhost/api/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
  body: JSON.stringify({ functionName: 'adminSetDangerPin', args: [VOID_PIN] }),
})).text();
const CREATED_AT = 1750000000000;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'void-harness-'));
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

const A = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'PLAYER A' };
const B = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'PLAYER B' };

/**
 * Seed a matched order for `amount` with both players already debited, then
 * void the round and return the resulting balances.
 *
 * `extraOrders` seeds additional orders so multi-order rounds are covered.
 */
async function runVoid({ amount = 500, extraOrders = [], before = null }) {
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `void-cache-${amount}-${extraOrders.length}`, KV_ORDERS: `void-ord-${amount}-${extraOrders.length}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvO = await mf.getKVNamespace('KV_ORDERS');
  const kvC = await mf.getKVNamespace('KV_CACHE');

  // Balances as they stand AFTER both players staked: each had 1000, now 500.
  const postStake = 1000 - amount;
  const prof = (p, bal) => JSON.stringify({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });

  const order = {
    orderNumber: '7500', creatorId: A.shortId, creatorName: A.name,
    creatorLineUserId: A.lineUserId, side: 'low', amount,
    betType: 'range', rangeMin: 350, rangeMax: 400,
    status: 'matched', createdAt: CREATED_AT, id: 'bet_7500',
    playerLowId: A.shortId, playerLowName: A.name,
    playerHighId: B.shortId, playerHighName: B.name,
    matcherId: B.shortId, matcherName: B.name, matcherLineUserId: B.lineUserId,
    matchedAt: CREATED_AT,
  };
  await kvO.put('ORDER_7500', JSON.stringify(order));
  const all = [order];

  for (const ex of extraOrders) {
    const o = {
      orderNumber: ex.orderNumber, creatorId: ex.creatorId, creatorName: ex.creatorName || 'X',
      creatorLineUserId: ex.creatorLineUserId || 'UX', side: ex.side || 'low',
      amount: ex.amount, betType: 'range', rangeMin: 350, rangeMax: 400,
      status: ex.status || 'matched', createdAt: CREATED_AT, id: `bet_${ex.orderNumber}`,
      playerLowId: ex.creatorId, playerLowName: ex.creatorName || 'X',
      playerHighId: null, playerHighName: null,
      matcherId: ex.matcherId || null, matcherName: ex.matcherName || null,
      matcherLineUserId: ex.matcherLineUserId || null,
    };
    await kvO.put(`ORDER_${ex.orderNumber}`, JSON.stringify(o));
    all.push(o);
  }

  // Matched orders live in the matched index; pending ones in the pending index.
  const matched = all.filter((o) => o.status === 'matched');
  const pending = all.filter((o) => o.status !== 'matched');
  await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify(matched));
  await kvC.put('PENDING_ORDERS_LIST', JSON.stringify(pending));

  const players = [
    { p: A, bal: before?.a ?? postStake },
    { p: B, bal: before?.b ?? postStake },
    ...extraOrders.filter((o) => o.creatorId && ![A.shortId, B.shortId].includes(o.creatorId))
      .map((o) => ({ p: { shortId: o.creatorId, lineUserId: o.creatorLineUserId || 'UX', name: o.creatorName || 'X' }, bal: 1000 - o.amount })),
  ];
  await kvC.put('PLAYERS_LIST', JSON.stringify(players.map((x) => JSON.parse(prof(x.p, x.bal)))));
  for (const x of players) {
    await kvC.put(`USER_${x.p.lineUserId}`, prof(x.p, x.bal));
    await kvC.put(`USER_${x.p.shortId}`, prof(x.p, x.bal));
    await kvC.put(`RAW_LINE_${x.p.shortId}`, x.p.lineUserId);
  }
  await kvC.put('ACTIVE_ROUND', JSON.stringify({ name: 'R', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));
  await setVoidPin(mf);

  await (await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName: 'adminBroadcastVoidRound', args: ['ALL', VOID_PIN] }),
  })).text();
  await new Promise((r) => setTimeout(r, 400));

  const dash = (await (await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
  })).json())?.data || {};
  const bal = (id) => {
    const p = (dash.players || []).find((x) => x.shortId === id);
    return p ? Number(p.balance) : NaN;
  };
  const out = { a: bal(A.shortId), b: bal(B.shortId), dash };
  await mf.dispose();
  return out;
}

console.log('VOID ROUND HARNESS\n');

// ── The exact reported scenario ──────────────────────────────────────────────
console.log('REPORTED CASE — A stakes 500, B matches 500, admin voids');
{
  const r = await runVoid({ amount: 500 });
  check('creator A returned to 1000', r.a === 1000, `got ${r.a}`);
  check('matcher B returned to 1000', r.b === 1000, `got ${r.b}`);
  check('B received 500 back, not 1000', r.b - 500 === 500, `B was credited ${r.b - 500} from a 500pt stake`);
  check('no points created: 1000 + 1000 total', r.a + r.b === 2000, `total ${r.a + r.b}`);
}

// ── Varying the stake ───────────────────────────────────────────────────────
console.log('\nOTHER STAKES');
for (const amount of [100, 200, 1000, 5000]) {
  const r = await runVoid({ amount });
  check(`stake ${amount}: both sides returned in full`,
    r.a === 1000 && r.b === 1000, `A=${r.a} B=${r.b}`);
}

// ── A pending (unmatched) order must refund only the creator ────────────────
console.log('\nPENDING ORDER — creator only');
{
  const r = await runVoid({
    amount: 500,
    extraOrders: [{ orderNumber: '7501', creatorId: A.shortId, creatorName: A.name, creatorLineUserId: A.lineUserId, amount: 300, status: 'pending_match' }],
    before: { a: 200, b: 500 }, // A staked 500 + 300 = 800 of 1000
  });
  check('A gets both stakes back (500 + 300)', r.a === 1000, `got ${r.a}`);
  check('B gets only their own stake back', r.b === 1000, `got ${r.b}`);
  check('no double refund for A', r.a === 1000, `got ${r.a}`);
}

// ── Voiding twice must not pay twice ────────────────────────────────────────
console.log('\nIDEMPOTENCE — voiding an already-voided round');
{
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: 'void-idem-cache', KV_ORDERS: 'void-idem-ord' },
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
  const order = {
    orderNumber: '7500', creatorId: A.shortId, creatorName: A.name, creatorLineUserId: A.lineUserId,
    side: 'low', amount: 500, betType: 'range', rangeMin: 350, rangeMax: 400,
    status: 'matched', createdAt: CREATED_AT, id: 'bet_7500',
    playerLowId: A.shortId, playerLowName: A.name,
    playerHighId: B.shortId, playerHighName: B.name,
    matcherId: B.shortId, matcherName: B.name, matcherLineUserId: B.lineUserId, matchedAt: CREATED_AT,
  };
  await kvO.put('ORDER_7500', JSON.stringify(order));
  await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify([order]));
  await kvC.put('PLAYERS_LIST', JSON.stringify([JSON.parse(prof(A, 500)), JSON.parse(prof(B, 500))]));
  for (const p of [A, B]) {
    await kvC.put(`USER_${p.lineUserId}`, prof(p, 500));
    await kvC.put(`USER_${p.shortId}`, prof(p, 500));
    await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
  }
  await setVoidPin(mf);
  const voidOnce = async () => {
    await (await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName: 'adminBroadcastVoidRound', args: ['ALL', VOID_PIN] }),
    })).text();
    await new Promise((r) => setTimeout(r, 350));
    const d = (await (await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
    })).json())?.data || {};
    const f = (id) => Number((d.players || []).find((x) => x.shortId === id)?.balance);
    return { a: f(A.shortId), b: f(B.shortId) };
  };
  const first = await voidOnce();
  check('first void refunds both once', first.a === 1000 && first.b === 1000, JSON.stringify(first));
  // Put the order back the way production would leave it, then void again.
  await kvO.put('ORDER_7500', JSON.stringify({ ...order, status: 'matched' }));
  await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify([{ ...order, status: 'matched' }]));
  const second = await voidOnce();
  check('second void pays nothing further', second.a === 1000 && second.b === 1000, JSON.stringify(second));
  await mf.dispose();
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);