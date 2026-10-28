/**
 * Regression harness: the group's result card after a partial settlement.
 *
 * THE BUG
 * -------
 * When some orders of a round failed to settle, the round correctly stayed
 * CLOSED for a retry — but the result card was still pushed to the group with
 * only the pairs that had been paid. The group read the round as over while
 * players were unpaid, and the retry then pushed a SECOND card listing only
 * the pairs that were left.
 *
 * ASSERTED HERE, for both the active round and a parked in-flight round:
 *  * a partial failure pushes no result card to the group;
 *  * the retry pushes exactly one card, listing every pair of the round;
 *  * the pair paid by the first attempt is not paid again;
 *  * a round with no matched pair still settles and reports its flight time.
 *
 * The failure is real, not mocked: one order's matcher has no profile anywhere,
 * so the ledger refuses it (player_not_found) until the profile is added.
 *
 * Usage:  node settlement-broadcast-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const CREATED_AT = 1750000000000;
const GROUP = 'C' + '0'.repeat(32);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'setbc-harness-'));
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

const P1 = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'ALPHA' };
const P2 = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'BRAVO' };
const GHOST = { shortId: 'PL000009', lineUserId: 'Uaaaaa0000000009', name: 'GHOST' };
const STAKE = 200;
const prof = (p, bal) => ({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });

const matched = (orderNumber, creator, matcher, roundId) => ({
  orderNumber, id: `bet_${orderNumber}`, roundId,
  creatorId: creator.shortId, creatorName: creator.name, creatorLineUserId: creator.lineUserId,
  matcherId: matcher.shortId, matcherName: matcher.name, matcherLineUserId: matcher.lineUserId,
  playerLowId: creator.shortId, playerLowName: creator.name,
  playerHighId: matcher.shortId, playerHighName: matcher.name,
  side: 'low', amount: STAKE, betType: 'custom_range', rangeMin: 350, rangeMax: 400,
  status: 'matched', createdAt: CREATED_AT, matchedAt: CREATED_AT,
});

async function scenario(label, { inFlight }) {
  const pushes = [];
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `sb-c-${label}`, KV_ORDERS: `sb-o-${label}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    outboundService: async (req) => {
      if (req.url.includes('/v2/bot/message/push')) pushes.push(await req.json());
      return new Response('{}', { status: 200 });
    },
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
  const resultCards = () => pushes
    .filter((p) => p.to === GROUP)
    .flatMap((p) => p.messages || [])
    .filter((m) => String(m.altText || '').startsWith('ผลการแข่งขัน'));

  // 9001 settles; 9002's winner (the low-side creator) has no profile, so it
  // cannot be credited and its settlement fails.
  const roundId = `R_${label}`;
  const okOrder = matched('9001', P1, P2, roundId);
  const badOrder = matched('9002', GHOST, P1, roundId);
  for (const o of [okOrder, badOrder]) await kvO.put(`ORDER_${o.orderNumber}`, JSON.stringify(o));
  await kvC.put('PLAYERS_LIST', JSON.stringify([prof(P1, 1000 - 2 * STAKE), prof(P2, 1000 - STAKE)]));
  for (const [p, bal] of [[P1, 1000 - 2 * STAKE], [P2, 1000 - STAKE]]) {
    await kvC.put(`USER_${p.lineUserId}`, JSON.stringify(prof(p, bal)));
    await kvC.put(`USER_${p.shortId}`, JSON.stringify(prof(p, bal)));
    await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
  }
  await kvC.put('ACTIVE_GROUP_ID', GROUP);
  if (inFlight) {
    await kvC.put('IN_FLIGHT_ROUNDS', JSON.stringify([{
      roundId, name: 'PARKED', targetMin: 350, targetMax: 400, isChotoy: false,
      quoteReleased: true, launchedAt: CREATED_AT, matchedOrders: [okOrder, badOrder],
    }]));
    await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId: 'R_NEXT', name: 'NEXT', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));
  } else {
    await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify([okOrder, badOrder]));
    await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId, name: 'ACTIVE', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));
  }
  const settle = (time = 300, tMin = 350, tMax = 400) => inFlight
    ? rpc('adminResolveInFlightRound', [roundId, time])
    : rpc('adminResolveBets', [time, tMin, tMax]);

  // ── attempt 1: partial failure ──
  const first = await settle();
  await new Promise((r) => setTimeout(r, 300));
  check('first attempt reports the failed order', first?.success === false && first?.failed?.[0]?.orderNumber === '9002', JSON.stringify(first));
  check('first attempt settled the good order', first?.resolvedCount === 1, `resolvedCount=${first?.resolvedCount}`);
  check('NO result card was pushed to the group', resultCards().length === 0, `${resultCards().length} card(s)`);
  if (!inFlight) {
    const round = (await rpc('getDashboardData', []))?.activeRound;
    check('round stays CLOSED for the retry', round?.status === 'CLOSED', round?.status);
  }

  // ── the cause is fixed, then the admin retries ──
  // The DO never reads KV back after its first boot, so the missing player is
  // created the way an admin would: through the console.
  await kvC.put(`RAW_LINE_${GHOST.shortId}`, GHOST.lineUserId);
  const fix = await rpc('adminSetPlayerBalance', [GHOST.lineUserId, 1000 - STAKE, GHOST.name]);
  check('missing player created via the console', fix?.success === true, JSON.stringify(fix));
  // ── a retry on a different flight time (or range) is refused ──
  const p1Before = Number(((await rpc('getDashboardData', [])).players || []).find((x) => x.shortId === P1.shortId)?.balance);
  const wrongTime = await settle(450);
  check('retry with a different flight time is refused', wrongTime?.success === false && wrongTime?.lockedFinalTime === 300, JSON.stringify(wrongTime));
  if (!inFlight) {
    const wrongRange = await settle(300, 330, 380);
    check('retry with a different range is refused', wrongRange?.success === false && wrongRange?.lockedFinalTime === 300, JSON.stringify(wrongRange));
  }
  const p1After = Number(((await rpc('getDashboardData', [])).players || []).find((x) => x.shortId === P1.shortId)?.balance);
  check('a refused retry moves no money', p1Before === p1After, `${p1Before} -> ${p1After}`);
  check('a refused retry pushes no card', resultCards().length === 0, `${resultCards().length} card(s)`);

  const second = await settle();
  await new Promise((r) => setTimeout(r, 300));
  check('retry succeeds', second?.success === true, JSON.stringify(second));
  const cards = resultCards();
  check('exactly one result card was pushed in total', cards.length === 1, `${cards.length} card(s)`);
  const text = JSON.stringify(cards[0] || {});
  check('the card lists the pair paid by the FIRST attempt', text.includes('#9001'));
  check('the card lists the pair paid by the retry', text.includes('#9002'));
  check('the card counts both pairs', /ตัดสินผล 2 คู่/.test(text), text.match(/ตัดสินผล \d+ คู่/)?.[0]);

  // 300s is below the range, so the low side wins: P1 takes 9001, loses 9002.
  const dash = (await rpc('getDashboardData', [])) || {};
  const bal = (id) => Number((dash.players || []).find((x) => x.shortId === id)?.balance);
  const win = STAKE + STAKE - Math.round(STAKE * 0.10);
  check('the first-attempt pair was not paid twice', bal(P1.shortId) === 1000 - 2 * STAKE + win, `P1=${bal(P1.shortId)}`);
  check('the retried pair was paid once', bal(GHOST.shortId) === 1000 - STAKE + win, `GHOST=${bal(GHOST.shortId)}`);

  await mf.dispose();
}

// The admin reports a flight time even when nobody matched in that round.
async function emptyRound(label, { inFlight }) {
  const pushes = [];
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `sb-c-${label}`, KV_ORDERS: `sb-o-${label}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    outboundService: async (req) => {
      if (req.url.includes('/v2/bot/message/push')) pushes.push(await req.json());
      return new Response('{}', { status: 200 });
    },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvC = await mf.getKVNamespace('KV_CACHE');
  const rpc = async (functionName, args) => (await (await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  })).json())?.data;
  const roundId = `R_${label}`;
  await kvC.put('ACTIVE_GROUP_ID', GROUP);
  if (inFlight) {
    await kvC.put('IN_FLIGHT_ROUNDS', JSON.stringify([{
      roundId, name: 'EMPTY', targetMin: 350, targetMax: 400, isChotoy: false,
      quoteReleased: true, launchedAt: CREATED_AT, matchedOrders: [],
    }]));
    await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId: 'R_NEXT', name: 'NEXT', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));
  } else {
    await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId, name: 'EMPTY', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));
  }
  const res = inFlight
    ? await rpc('adminResolveInFlightRound', [roundId, 372])
    : await rpc('adminResolveBets', [372, 350, 400]);
  await new Promise((r) => setTimeout(r, 300));
  check('empty round settles', res?.success === true && res?.resolvedCount === 0, JSON.stringify(res));
  const cards = pushes.filter((p) => p.to === GROUP).flatMap((p) => p.messages || [])
    .filter((m) => String(m.altText || '').startsWith('ผลการแข่งขัน'));
  const text = JSON.stringify(cards[0] || {});
  check('one result card reaches the group', cards.length === 1, `${cards.length} card(s)`);
  check('the card shows the flight time', text.includes('เวลาบิน 372 วิ'));
  check('the card says there was no duel', text.includes('ไม่มีคู่ดวล') && !text.includes('0 คู่'));
  if (inFlight) {
    check('the parked round leaves the queue', (res?.inFlightRounds || []).length === 0, JSON.stringify(res?.inFlightRounds));
  } else {
    const round = (await rpc('getDashboardData', []))?.activeRound;
    check('round is RESOLVED', round?.status === 'RESOLVED', round?.status);
  }
  await mf.dispose();
}

console.log('SETTLEMENT BROADCAST HARNESS\n');
console.log('[1] Active round: partial failure, then retry');
await scenario('active', { inFlight: false });
console.log('\n[2] Parked in-flight round: partial failure, then retry');
await scenario('inflight', { inFlight: true });
console.log('\n[3] Active round with no matched pair');
await emptyRound('empty-active', { inFlight: false });
console.log('\n[4] Parked in-flight round with no matched pair');
await emptyRound('empty-inflight', { inFlight: true });

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
