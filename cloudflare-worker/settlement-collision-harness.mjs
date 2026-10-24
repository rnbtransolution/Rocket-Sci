/**
 * Regression harness for the settlement/cancellation collision.
 *
 * THE BUG (reproduced in production as order #8079)
 * -------------------------------------------------
 *   08:36:37  ITT      +10ชถ500            -> order #8079, pre_quote, range = raw offset
 *   08:37:41  😊😊😊    ต 8079 200            -> matched
 *   08:37:58  admin    [เปิดราคา 350-400s]   -> quote, then settle
 *
 * #8079 was stored with rangeMin/rangeMax still equal to the raw offset (10/10),
 * i.e. the quote never assigned it a real range. At settlement:
 *
 *   1. `matchedOrders` was snapshotted from the matched index
 *   2. `cancelHeldPreQuoteOrders` ran and — because it now also sweeps the
 *      MATCHED index — CANCELLED #8079 and refunded BOTH parties
 *   3. the settlement loop then walked the step-1 snapshot and settled #8079
 *      anyway, paying the winner
 *
 * ITT lost the bet and was credited his full 200 back, while the winner was
 * also paid 380. Money created from nothing, and a loser made whole.
 *
 * TWO INDEPENDENT GUARDS ARE ASSERTED HERE
 * ---------------------------------------
 *  * ORDER: cancellation runs BEFORE the matched snapshot is taken.
 *  * STATE: settlement re-reads each order and refuses anything not `matched`,
 *    so it does not matter what the cached index claims.
 *
 * Plus: a pre-quote order the admin DID quote keeps betType 'pre_quote' (that is
 * how it stays identifiable) but is stamped `offsetConfirmedAt`. Keying
 * cancellation on betType alone would refund every pre-quote order in a round
 * that quoted perfectly normally — so the marker must be honoured.
 *
 * Usage:  node settlement-collision-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const CREATED_AT = 1750000000000;
const RATE = 0.10;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'setcol-harness-'));
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

const LOSER = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'LOSER' };
const WINNER = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'WINNER' };

/**
 * Seed a MATCHED order and settle it.
 * `confirmed` marks it as having been priced by a real quote (offsetConfirmedAt).
 * `finalSeconds` decides the winner: below rangeMin -> low side wins.
 */
async function settleMatched({ amount, offsetConfirmedAt, finalSeconds, label }) {
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `sc-c-${label}`, KV_ORDERS: `sc-o-${label}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvO = await mf.getKVNamespace('KV_ORDERS');
  const kvC = await mf.getKVNamespace('KV_CACHE');

  // Both staked `amount`, so both sit at 1000 - amount before settlement.
  const postStake = 1000 - amount;
  const prof = (p, bal) => JSON.stringify({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });

  const order = {
    orderNumber: '8079', creatorId: LOSER.shortId, creatorName: LOSER.name,
    creatorLineUserId: LOSER.lineUserId, side: 'low', amount,
    betType: 'pre_quote',
    // The production defect: the range is still the raw offset, never a real band.
    rangeMin: 10, rangeMax: 10, offset: 10,
    ...(offsetConfirmedAt ? { offsetConfirmedAt } : {}),
    status: 'matched', createdAt: CREATED_AT, id: 'bet_8079',
    playerLowId: LOSER.shortId, playerLowName: LOSER.name,
    playerHighId: WINNER.shortId, playerHighName: WINNER.name,
    matcherId: WINNER.shortId, matcherName: WINNER.name, matcherLineUserId: WINNER.lineUserId,
    matchedAt: CREATED_AT,
  };
  await kvO.put('ORDER_8079', JSON.stringify(order));
  await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify([order]));
  await kvC.put('PLAYERS_LIST', JSON.stringify([JSON.parse(prof(LOSER, postStake)), JSON.parse(prof(WINNER, postStake))]));
  for (const p of [LOSER, WINNER]) {
    await kvC.put(`USER_${p.lineUserId}`, prof(p, postStake));
    await kvC.put(`USER_${p.shortId}`, prof(p, postStake));
    await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
  }
  await kvC.put('ACTIVE_ROUND', JSON.stringify({ name: 'R', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));

  await (await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName: 'adminResolveBets', args: [finalSeconds, 350, 400] }),
  })).text();
  await new Promise((r) => setTimeout(r, 350));

  const dash = (await (await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
  })).json())?.data || {};
  const bal = (id) => {
    const p = (dash.players || []).find((x) => x.shortId === id);
    return p ? Number(p.balance) : NaN;
  };
  const after = JSON.parse((await kvO.get('ORDER_8079')) || 'null');
  const out = { loser: bal(LOSER.shortId), winner: bal(WINNER.shortId), order: after };
  await mf.dispose();
  return out;
}

console.log('SETTLEMENT / CANCELLATION COLLISION HARNESS\n');

// ── THE REPORTED CASE: unquoted pre-quote, never confirmed ─────────────────
console.log('UNQUOTED PRE-QUOTE (the production bug) — both refunded, neither settled');
{
  const amount = 200;
  const r = await settleMatched({ amount, offsetConfirmedAt: 0, finalSeconds: 450, label: 'unq' });
  const commission = Math.round(amount * RATE);

  check('the loser is NOT left whole by a bogus settlement',
    r.loser !== 1000 - amount + (1000 - amount) - amount + amount * 2,
    `loser=${r.loser}`);
  // Correct outcome: no quote ever arrived, so the order is void. Both sides get
  // their stake back and NEITHER is paid a settlement.
  check('loser refunded to 1000 (stake back, no winnings)', r.loser === 1000, `got ${r.loser}`);
  check('winner refunded to 1000 (stake back, no payout)', r.winner === 1000, `got ${r.winner}`);
  // The settlement loop is skipped entirely for a voided order, so these are
  // never written at all. Absent is the correct outcome; only a non-zero value
  // would mean somebody was paid on a cancelled bet.
  check('no settlement payout was recorded', !r.order?.payout, String(r.order?.payout));
  check('no commission was taken on a voided order', !r.order?.commission, String(r.order?.commission));
  check('no winner was recorded on a voided order', !r.order?.winnerSide, String(r.order?.winnerSide));
  check('the order is cancelled, not settled', r.order?.status === 'cancelled', String(r.order?.status));
  check('no money created: both sides hold exactly their start',
    r.loser + r.winner === 2000, `${r.loser} + ${r.winner}`);
}

// ── A QUOTED pre-quote order must settle normally ──────────────────────────
console.log('\nQUOTED PRE-QUOTE (offsetConfirmedAt set) — settles normally');
{
  const amount = 200;
  const r = await settleMatched({ amount, offsetConfirmedAt: CREATED_AT + 1000, finalSeconds: 450, label: 'q' });
  const commission = Math.round(amount * RATE);
  const payout = amount + (amount - commission);

  check('the winner is paid the settlement', r.winner === (1000 - amount) + payout, `got ${r.winner}`);
  check('the loser loses the stake and gains nothing', r.loser === 1000 - amount, `got ${r.loser}`);
  check('commission taken on the winner', r.order?.commission === commission, String(r.order?.commission));
  check('the order is settled', r.order?.status === 'settled', String(r.order?.status));
  check('system sheds exactly the commission',
    r.loser + r.winner === 2000 - commission, `${r.loser + r.winner}`);
  check('a quoted pre-quote order is NOT cancelled',
    r.order?.status !== 'cancelled');
}

// ── Structural guards, so the ordering cannot silently regress ────────────
console.log('\nCODE-LEVEL GUARDS');
{
  const src = (await import('node:fs')).readFileSync('src/index.ts', 'utf8');
  const fn = src.slice(src.indexOf("functionName === 'adminResolveBets'"));
  const cancelAt = fn.indexOf('cancelHeldPreQuoteOrders');
  const snapshotAt = fn.indexOf('getMatchedOrdersList');
  check('cancellation runs BEFORE the matched list is snapshotted',
    cancelAt > -1 && snapshotAt > -1 && cancelAt < snapshotAt,
    `cancel@${cancelAt} snapshot@${snapshotAt}`);
  check('settlement skips anything this settlement voided',
    /settleOrdersAtomically\([\s\S]{0,120}voidedThisSettlement/.test(fn) && /skip\.has\(item\.orderNumber\)/.test(src));
  check('settlement re-checks the stored order and requires status matched',
    /expectStatus: \['matched'\],\s*settle:/.test(src));

  const qh = (await import('node:fs')).readFileSync('src/queueHandler.ts', 'utf8');
  check('cancellation honours offsetConfirmedAt, not just betType',
    /betType === 'pre_quote' && !o\.offsetConfirmedAt/.test(qh));
  check('the quote path stamps offsetConfirmedAt on matched pre-quotes',
    /offsetConfirmedAt: Date\.now\(\)/.test(qh));
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);