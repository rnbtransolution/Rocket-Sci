/**
 * Regression harness: voiding a round requires the danger PIN, server-side.
 *
 * Voiding refunds every duel of a round and cannot be undone. The console used
 * to guard it by making the admin type the round's Thai name — slow on a phone
 * and only a client-side speed bump; anyone able to call /api/run could void
 * directly. Both void RPCs now take the danger PIN (the Factory Reset PIN) and
 * verify it in the Worker, failing closed when none is set.
 *
 * ASSERTED HERE, for the active round and a parked in-flight round:
 *  * no PIN configured  → refused (409), nothing refunded;
 *  * missing / wrong PIN → refused (403), nothing refunded, round untouched;
 *  * correct PIN        → voided and both stakes refunded exactly once.
 *
 * Usage:  node void-pin-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const CREATED_AT = 1750000000000;
const PIN = '7391';
const STAKE = 300;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'voidpin-harness-'));
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

const A = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'ALPHA' };
const B = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'BRAVO' };
const prof = (p, bal) => ({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });
const order = (roundId) => ({
  orderNumber: '9101', id: 'bet_9101', roundId,
  creatorId: A.shortId, creatorName: A.name, creatorLineUserId: A.lineUserId,
  matcherId: B.shortId, matcherName: B.name, matcherLineUserId: B.lineUserId,
  playerLowId: A.shortId, playerLowName: A.name, playerHighId: B.shortId, playerHighName: B.name,
  side: 'low', amount: STAKE, betType: 'custom_range', rangeMin: 350, rangeMax: 400,
  status: 'matched', createdAt: CREATED_AT, matchedAt: CREATED_AT,
});

async function scenario(label, { inFlight, setPin }) {
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `vp-c-${label}`, KV_ORDERS: `vp-o-${label}` },
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
  const call = async (functionName, args) => {
    const res = await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName, args }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const roundId = `R_${label}`;
  const o = order(roundId);
  await kvO.put('ORDER_9101', JSON.stringify(o));
  await kvC.put('PLAYERS_LIST', JSON.stringify([prof(A, 1000 - STAKE), prof(B, 1000 - STAKE)]));
  for (const p of [A, B]) {
    await kvC.put(`USER_${p.lineUserId}`, JSON.stringify(prof(p, 1000 - STAKE)));
    await kvC.put(`USER_${p.shortId}`, JSON.stringify(prof(p, 1000 - STAKE)));
    await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
  }
  await kvC.put('ACTIVE_GROUP_ID', 'C' + '0'.repeat(32));
  if (inFlight) {
    await kvC.put('IN_FLIGHT_ROUNDS', JSON.stringify([{
      roundId, name: 'PARKED', targetMin: 350, targetMax: 400, isChotoy: false,
      quoteReleased: true, launchedAt: CREATED_AT, matchedOrders: [o],
    }]));
    await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId: 'R_NEXT', name: 'NEXT', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));
  } else {
    await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify([o]));
    await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId, name: 'ACTIVE', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));
  }
  if (setPin) check('PIN set', (await call('adminSetDangerPin', [PIN])).status === 200);

  const doVoid = (pin) => inFlight
    ? call('adminVoidInFlightRound', [roundId, 'ALL', ...(pin === undefined ? [] : [pin])])
    : call('adminBroadcastVoidRound', ['ALL', ...(pin === undefined ? [] : [pin])]);
  const snapshot = async () => {
    const d = (await call('getDashboardData', [])).body?.data || {};
    const bal = (id) => Number((d.players || []).find((x) => x.shortId === id)?.balance);
    return { a: bal(A.shortId), b: bal(B.shortId), status: d.activeRound?.status, parked: (d.inFlightRounds || []).length };
  };
  const untouched = (s) => s.a === 1000 - STAKE && s.b === 1000 - STAKE
    && (inFlight ? s.parked === 1 : s.status === 'ACTIVE');

  if (!setPin) {
    const r = await doVoid(PIN);
    check('no PIN configured: refused with 409', r.status === 409, `status=${r.status} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    check('no PIN configured: nothing refunded, round untouched', untouched(s), JSON.stringify(s));
    await mf.dispose();
    return;
  }

  for (const [why, pin] of [['missing PIN', undefined], ['wrong PIN', '1029']]) {
    const r = await doVoid(pin);
    check(`${why}: refused with 403`, r.status === 403, `status=${r.status} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    check(`${why}: nothing refunded, round untouched`, untouched(s), JSON.stringify(s));
  }

  const r = await doVoid(PIN);
  check('correct PIN: accepted', r.status === 200 && r.body?.data?.success !== false, `status=${r.status} ${JSON.stringify(r.body)}`);
  await new Promise((res) => setTimeout(res, 300));
  const s = await snapshot();
  check('correct PIN: both stakes refunded exactly once', s.a === 1000 && s.b === 1000, JSON.stringify(s));
  check(inFlight ? 'correct PIN: parked round removed' : 'correct PIN: round is VOID',
    inFlight ? s.parked === 0 : s.status === 'VOID', JSON.stringify(s));

  await mf.dispose();
}

console.log('VOID PIN HARNESS\n');
console.log('[1] Active round');
await scenario('active', { inFlight: false, setPin: true });
console.log('\n[2] Parked in-flight round');
await scenario('inflight', { inFlight: true, setPin: true });
console.log('\n[3] Fails closed when no PIN is configured');
await scenario('nopin-active', { inFlight: false, setPin: false });
await scenario('nopin-inflight', { inFlight: true, setPin: false });

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
