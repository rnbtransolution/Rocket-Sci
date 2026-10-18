/**
 * Regression harness for settlement commission (10% platform rake).
 *
 * THE BUG
 * -------
 * Settlement credited the winner `amt * 2` with no deduction, so the rake was
 * never taken. A winner on a 500pt bet was credited the full 1000 instead of
 * 950, and the platform's 10% was retained by nobody. Players paid deposits
 * expecting the documented 1.9x and the platform absorbed the difference on
 * every settled round.
 *
 * THE MODEL
 * ---------
 * A stake leaves a player's balance when the bet opens and returns at
 * settlement, so a partial view of either step misleads. The fixture therefore
 * seeds POST-stake balances, exactly where the worker would be at the moment
 * settlement runs:
 *
 *     both players start at INITIAL each
 *     each stakes `amount`            -> both at INITIAL - amount
 *     settlement pays winner `payout` -> INITIAL - amount + payout
 *
 * With payout = amount + (amount - commission), the winner lands back at
 * INITIAL + amount - commission and the pair at 2*INITIAL - commission: the
 * system sheds EXACTLY the commission and nothing else. That identity is the
 * real assertion — an arithmetic check alone would pass against a formula
 * wired to the wrong amount.
 *
 * Usage:  node commission-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const CREATED_AT = 1750000000000;
const RATE = 0.10;
const INITIAL = 1000;   // each player's balance before staking
const RANGE_MIN = 300, RANGE_MAX = 400;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'commission-harness-'));
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

/**
 * Settle one decisive-or-drawn bet with both players staked `amount`.
 * Returns post-settlement balances plus the persisted order record.
 */
async function settle({ amount, finalSeconds }) {
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `cm-cache-${amount}-${finalSeconds}`, KV_ORDERS: `cm-orders-${amount}-${finalSeconds}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvO = await mf.getKVNamespace('KV_ORDERS');
  const kvC = await mf.getKVNamespace('KV_CACHE');

  const postStake = INITIAL - amount;
  const prof = (id, lu, n, b) => JSON.stringify({ shortId: id, lineUserId: lu, displayName: n, balance: b, registeredAt: CREATED_AT, updatedAt: CREATED_AT });

  const order = {
    orderNumber: '1', creatorId: 'PL000001', creatorName: 'CREATOR',
    creatorLineUserId: 'U1', side: 'low', amount,
    betType: 'range', rangeMin: RANGE_MIN, rangeMax: RANGE_MAX,
    status: 'matched', createdAt: CREATED_AT, id: 'bet_1',
    playerLowId: 'PL000001', playerLowName: 'CREATOR',
    playerHighId: 'PL000002', playerHighName: 'MATCHER',
    matcherId: 'PL000002', matcherName: 'MATCHER', matcherLineUserId: 'U2',
    matchedAt: CREATED_AT,
  };
  await kvO.put('ORDER_1', JSON.stringify(order));
  await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify([order]));
  await kvC.put('PLAYERS_LIST', JSON.stringify([
    JSON.parse(prof('PL000001', 'U1', 'CREATOR', postStake)),
    JSON.parse(prof('PL000002', 'U2', 'MATCHER', postStake)),
  ]));
  for (const [id, lu, n] of [['PL000001', 'U1', 'CREATOR'], ['PL000002', 'U2', 'MATCHER']]) {
    await kvC.put(`USER_${lu}`, prof(id, lu, n, postStake));
    await kvC.put(`USER_${id}`, prof(id, lu, n, postStake));
    await kvC.put(`RAW_LINE_${id}`, lu);
  }
  await kvC.put('ACTIVE_ROUND', JSON.stringify({ name: 'R', targetMin: RANGE_MIN, targetMax: RANGE_MAX, status: 'ACTIVE' }));

  await (await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName: 'adminResolveBets', args: [finalSeconds, RANGE_MIN, RANGE_MAX] }),
  })).text();
  await new Promise((r) => setTimeout(r, 250));

  const dash = (await (await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
  })).json())?.data || {};
  const pick = (id) => {
    const p = (dash.players || []).find((x) => x.shortId === id);
    return p ? Number(p.balance) : NaN;
  };
  // Read the settled record straight out of KV_ORDERS: getDashboardData only
  // lists pending and matched orders, so a settled one would be invisible.
  const settled = JSON.parse((await kvO.get('ORDER_1')) || 'null');

  const out = { creator: pick('PL000001'), matcher: pick('PL000002'), settled };
  await mf.dispose();
  return out;
}

console.log('COMMISSION HARNESS — 10% platform rake\n');

// ── Arithmetic and conservation across realistic stakes ─────────────────────
console.log('DECISIVE RESULT — creator (low) wins when time is below the range');
for (const amount of [100, 200, 500, 1000, 1234, 333]) {
  const r = await settle({ amount, finalSeconds: 250 });
  const commission = Math.round(amount * RATE);
  const payout = amount + (amount - commission);
  const expectedWinner = (INITIAL - amount) + payout;

  check(`stake ${amount}: stored commission = ${commission}`,
    r.settled?.commission === commission, `got ${r.settled?.commission}`);
  check(`stake ${amount}: stored payout = ${payout}`,
    r.settled?.payout === payout, `got ${r.settled?.payout}`);
  check(`stake ${amount}: winner credited ${expectedWinner}`,
    r.creator === expectedWinner, `got ${r.creator}`);
  check(`stake ${amount}: loser credited nothing`,
    r.matcher === INITIAL - amount, `got ${r.matcher}`);
  check(`stake ${amount}: system sheds exactly the commission`,
    r.creator + r.matcher === 2 * INITIAL - commission,
    `total ${r.creator + r.matcher}, expected ${2 * INITIAL - commission}`);
}

// ── The exact example from the report ───────────────────────────────────────
console.log('\nREPORTED CASE — a winner wins a 500pt bet');
{
  const r = await settle({ amount: 500, finalSeconds: 250 });
  check('commission is 50 (10% of 500)', r.settled?.commission === 50, String(r.settled?.commission));
  check('winner is banked 450 of winnings, not 500', 500 - r.settled.commission === 450, String(500 - r.settled.commission));
  check('winner total credited is 950, not 1000', r.settled?.payout === 950, String(r.settled?.payout));
}

// ── The other side winning must behave identically ──────────────────────────
console.log('\nMATCHER WINS — same rake applies regardless of side');
{
  const r = await settle({ amount: 500, finalSeconds: 450 }); // above range -> 'high' wins -> matcher wins
  check('commission charged to the matcher\'s win', r.settled?.commission === 50, String(r.settled?.commission));
  check('matcher credited 950', r.matcher === (INITIAL - 500) + 950, String(r.matcher));
  check('creator (loser) credited nothing', r.creator === INITIAL - 500, String(r.creator));
}

// ── A draw refunds both stakes and takes nothing ────────────────────────────
console.log('\nDRAW — both stakes returned, no commission');
{
  const r = await settle({ amount: 500, finalSeconds: 350 }); // inside the range
  check('creator refunded in full', r.creator === INITIAL, String(r.creator));
  check('matcher refunded in full', r.matcher === INITIAL, String(r.matcher));
  check('no commission recorded', r.settled?.commission === 0, String(r.settled?.commission));
  check('no payout recorded', r.settled?.payout === 0, String(r.settled?.payout));
  check('system total unchanged', r.creator + r.matcher === 2 * INITIAL, String(r.creator + r.matcher));
}

// ── Balances must stay whole numbers ────────────────────────────────────────
console.log('\nINTEGRALITY — no fractional points reach a balance');
for (const amount of [333, 777, 1234, 55]) {
  const r = await settle({ amount, finalSeconds: 250 });
  check(`stake ${amount}: commission is a whole number`,
    Number.isInteger(r.settled?.commission), String(r.settled?.commission));
  check(`stake ${amount}: winner balance is a whole number`,
    Number.isInteger(r.creator), String(r.creator));
  check(`stake ${amount}: nothing created from nothing`,
    r.creator + r.matcher === 2 * INITIAL - Math.round(amount * RATE),
    `total ${r.creator + r.matcher}`);
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);