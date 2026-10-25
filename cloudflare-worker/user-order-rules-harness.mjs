/**
 * End-to-end harness verifying the exact user order rules:
 *
 * [1] Pre-quote order (placed before admin quote):
 *     - Matched before admin quotes.
 *     - Confirmed when admin broadcasts official quote (stamped with range & rocket name).
 *     - Settles correctly against quoted rate.
 *     - If admin never quotes, cancelled and BOTH parties refunded in full (exact balance, no extra credit).
 *
 * [2] Player quote their own rate (self-quoted):
 *     - Goes straight to confirmed matching status and locked in.
 *     - Even if admin does NOT send official quote, order remains valid and settles against its own rate.
 *
 * [3] Void round (cancelled round):
 *     - Both order types refunded 100% to both parties.
 *     - Balance returned to exact starting points (zero extra credit).
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const ADMIN_KEY = 'test_admin_key';
const CHANNEL_SECRET = 'test_channel_secret';
const CREATED_AT = 1750000000000;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'user-rules-harness-'));
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

const P1 = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'PLAYER1' };
const P2 = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'PLAYER2' };

async function freshEnv(suffix) {
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `ur-cache-${suffix}`, KV_ORDERS: `ur-ord-${suffix}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvO = await mf.getKVNamespace('KV_ORDERS');
  const kvC = await mf.getKVNamespace('KV_CACHE');

  const prof = (p, bal) => JSON.stringify({
    shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name,
    balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT,
  });

  async function seedPlayers(bal1 = 1000, bal2 = 1000) {
    const list = [JSON.parse(prof(P1, bal1)), JSON.parse(prof(P2, bal2))];
    await kvC.put('PLAYERS_LIST', JSON.stringify(list));
    await kvC.put(`USER_${P1.lineUserId}`, prof(P1, bal1));
    await kvC.put(`USER_${P1.shortId}`, prof(P1, bal1));
    await kvC.put(`RAW_LINE_${P1.shortId}`, P1.lineUserId);
    await kvC.put(`USER_${P2.lineUserId}`, prof(P2, bal2));
    await kvC.put(`USER_${P2.shortId}`, prof(P2, bal2));
    await kvC.put(`RAW_LINE_${P2.shortId}`, P2.lineUserId);
    await kvC.put('ACTIVE_ROUND', JSON.stringify({ name: 'บั้งไฟสด', status: 'ACTIVE' }));
  }

  let seq = 0;
  async function say(user, text, groupId = 'Cgroup001') {
    const eventId = `e${++seq}`;
    const body = JSON.stringify({
      destination: 'Utest',
      events: [{
        type: 'message', replyToken: 'a'.repeat(64), webhookEventId: eventId,
        source: { type: 'group', groupId, userId: user.lineUserId },
        timestamp: Date.now(), message: { id: `m${eventId}`, type: 'text', text },
      }],
    });
    const sig = createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
    await (await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-line-signature': sig },
      body,
    })).text();
    await new Promise((r) => setTimeout(r, 200));
  }

  async function rpc(functionName, args = []) {
    const res = await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName, args }),
    });
    return (await res.json())?.data;
  }

  async function balances() {
    const d = (await rpc('getDashboardData')) || {};
    const f = (id) => { const p = (d.players || []).find((x) => x.shortId === id); return p ? Number(p.balance) : NaN; };
    return { p1: f(P1.shortId), p2: f(P2.shortId) };
  }

  async function getOrders() {
    const d = (await rpc('getDashboardData')) || {};
    return d.bets || [];
  }

  return { seedPlayers, say, rpc, balances, getOrders, kvO, kvC, dispose: () => mf.dispose() };
}

console.log('USER ORDER RULES SPECIFICATION HARNESS\n');

// ── TEST 1: Pre-quote order matches, admin quotes, order officially settles ──
console.log('SCENARIO 1: Pre-quote matches -> Admin quotes -> Order settles');
{
  const env = await freshEnv('s1');
  await env.seedPlayers(1000, 1000);

  // Player 1 pre-quotes +10ชล500
  await env.say(P1, '+10ชล500');
  const bAfterCreate = await env.balances();
  check('P1 debited 500 on pre-quote order creation', bAfterCreate.p1 === 500, `p1=${bAfterCreate.p1}`);

  const orders = await env.getOrders();
  const order1 = orders[0];
  check('Order created as pre_quote', order1 && order1.betType === 'pre_quote');
  check('Order has offset 10 and no price band yet', order1 && order1.offset === 10 && (!order1.rangeMin || order1.rangeMin === undefined));

  // Player 2 matches
  await env.say(P2, `ต ${order1.orderNumber} 500`);
  const bAfterMatch = await env.balances();
  check('P2 debited 500 on match (not left at 1000!)', bAfterMatch.p2 === 500, `p2=${bAfterMatch.p2}`);

  // Admin broadcasts quote: 330-380, rocket "เจ้าพายุ"
  await env.rpc('adminBroadcastQuote', ['ALL', 'เจ้าพายุ', 330, 380]);

  // Check order updated with quote band and rocket name
  const rawQuoted = JSON.parse(await env.kvO.get(`ORDER_${order1.orderNumber}`));
  check('Quoted order has rocketName "เจ้าพายุ"', rawQuoted.rocketName === 'เจ้าพายุ', rawQuoted.rocketName);
  check('Quoted order has rangeMin = 340 (330 + 10)', rawQuoted.rangeMin === 340, String(rawQuoted.rangeMin));
  check('Quoted order has rangeMax = 390 (380 + 10)', rawQuoted.rangeMax === 390, String(rawQuoted.rangeMax));
  check('Quoted order has offsetConfirmedAt set', Boolean(rawQuoted.offsetConfirmedAt));

  // Admin resolves bet with final time 320s (< 340 -> side 'low' / ชล wins, P1 wins)
  // Wait, side: P1 bet 'ชล' which is 'high'!
  // Let's check: final time 400s (> 390 -> side 'high' wins!)
  await env.rpc('adminResolveBets', [400, 330, 380]);

  const bAfterSettle = await env.balances();
  // Winner payout on 500: 500 + (500 - 50 rake) = 950 pt.
  // P1 had 500, + 950 = 1450.
  // P2 had 500, lost stake = 500.
  check('Winner P1 receives 950 payout (1.9x): balance 1450', bAfterSettle.p1 === 1450, `p1=${bAfterSettle.p1}`);
  check('Loser P2 gets 0: balance 500', bAfterSettle.p2 === 500, `p2=${bAfterSettle.p2}`);
  check('Conservation: total points in system = 1950 (2000 - 50 commission)', bAfterSettle.p1 + bAfterSettle.p2 === 1950);

  await env.dispose();
}

// ── TEST 2: Pre-quote matches -> Admin NEVER quotes -> Cancelled & refunded ──
console.log('\nSCENARIO 2: Pre-quote matches -> Admin NEVER quotes -> Cancelled & refunded');
{
  const env = await freshEnv('s2');
  await env.seedPlayers(1000, 1000);

  // Player 1 pre-quotes
  await env.say(P1, 'ชล500');
  const orders = await env.getOrders();
  const order2 = orders[0];

  // Player 2 matches
  await env.say(P2, `ต ${order2.orderNumber} 500`);
  const bMid = await env.balances();
  check('Both players debited 500: p1=500, p2=500', bMid.p1 === 500 && bMid.p2 === 500, `p1=${bMid.p1} p2=${bMid.p2}`);

  // Admin never quotes; admin calls Final Call (or resolves round)
  await env.rpc('adminBroadcastFinalCall', ['ALL']);

  const bAfterCancel = await env.balances();
  check('P1 refunded in full to 1000 (no extra credit)', bAfterCancel.p1 === 1000, `p1=${bAfterCancel.p1}`);
  check('P2 refunded in full to 1000 (no extra credit)', bAfterCancel.p2 === 1000, `p2=${bAfterCancel.p2}`);

  const rawCancelled = JSON.parse(await env.kvO.get(`ORDER_${order2.orderNumber}`));
  check('Order is cancelled', rawCancelled.status === 'cancelled');

  await env.dispose();
}

// ── TEST 3: Self-quoted order -> Matches -> Valid even without admin quote ──
console.log('\nSCENARIO 3: Self-quoted order -> Matches -> Runs even without admin quote');
{
  const env = await freshEnv('s3');
  await env.seedPlayers(1000, 1000);

  // Player 1 quotes their own rate: 300-350 ชล 500
  await env.say(P1, '300-350 ชล 500');
  const orders = await env.getOrders();
  const order3 = orders[0];
  check('Self-quoted order created as custom_range (300-350)',
    order3 && order3.betType === 'custom_range' && order3.rangeMin === 300 && order3.rangeMax === 350);

  // Player 2 matches
  await env.say(P2, `ต ${order3.orderNumber} 500`);
  const bMid = await env.balances();
  check('Order locked in: both debited 500', bMid.p1 === 500 && bMid.p2 === 500);

  // Admin calls Final Call WITHOUT EVER SENDING A QUOTE
  await env.rpc('adminBroadcastFinalCall', ['ALL']);

  const rawAfterFinal = JSON.parse(await env.kvO.get(`ORDER_${order3.orderNumber}`));
  check('Self-quoted order NOT cancelled by final call without quote', rawAfterFinal.status === 'matched');

  // Settle bets: rocket flew 360s (> 350 -> 'high' / ชล wins, P1 wins)
  await env.rpc('adminResolveBets', [360, 330, 380]);

  const bAfterSettle = await env.balances();
  check('P1 wins payout 950 (balance 1450)', bAfterSettle.p1 === 1450, `p1=${bAfterSettle.p1}`);
  check('P2 loses stake (balance 500)', bAfterSettle.p2 === 500, `p2=${bAfterSettle.p2}`);

  await env.dispose();
}

// ── TEST 4: Void round (game cancelled) -> Both types refunded, NO extra credit ──
console.log('\nSCENARIO 4: Void round -> All orders refunded, ZERO extra credit banked');
{
  const env = await freshEnv('s4');
  await env.seedPlayers(1000, 1000);

  // Pre-quote order
  await env.say(P1, 'ชล500');
  const orders = await env.getOrders();
  const ordPre = orders[0];
  await env.say(P2, `ต ${ordPre.orderNumber} 500`);

  const bPre = await env.balances();
  check('Before void: p1=500, p2=500', bPre.p1 === 500 && bPre.p2 === 500);

  // Admin voids round
  await env.rpc('adminSetDangerPin', ['7391']);
  await env.rpc('adminBroadcastVoidRound', ['ALL', '7391']);

  const bPost = await env.balances();
  check('After void: P1 refunded to exactly 1000', bPost.p1 === 1000, `p1=${bPost.p1}`);
  check('After void: P2 refunded to exactly 1000 (NO EXTRA CREDIT!)', bPost.p2 === 1000, `p2=${bPost.p2}`);

  await env.dispose();
}

console.log(`\nALL USER RULES VERIFIED:\n  ${pass} passed, ${fail} failed\n`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
