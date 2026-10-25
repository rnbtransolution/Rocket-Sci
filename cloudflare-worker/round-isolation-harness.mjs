/**
 * Regression harness for rocket-round isolation and the daily summary.
 *
 * THE BUGS THIS LOCKS DOWN
 * ------------------------
 *  * LINE chat "ปิดรอบ" + "เปิดรอบ X" overwrote ACTIVE_ROUND in place: the
 *    previous rocket's matched orders stayed on the board and settled on the
 *    NEXT rocket's flight time.
 *  * Chat "ปิดรอบ" skipped cancelling matched pre-quote orders, which then took
 *    the next rocket's quote instead of being refunded to both sides.
 *  * Orders carried no round ID, so an order left over from a previous rocket
 *    could be matched into the current one.
 *  * Opening the next rocket after a RESOLVED round parked an empty round.
 *  * There was no daily summary, and SETTLED_ORDERS_LIST (latest 100, wiped by
 *    "ปิดรอบพอร์ทัล") could not back one.
 *
 * Usage:  node round-isolation-harness.mjs
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

const outDir = mkdtempSync(join(tmpdir(), 'round-iso-harness-'));
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
  kvNamespaces: { KV_CACHE: 'iso-c', KV_ORDERS: 'iso-o' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: CH, LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test', ADMIN_LINE_USER_IDS: ADM.lineUserId,
    PUBLIC_BASE_URL: 'https://rocket.example/',
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

const rpc = async (functionName, args = []) => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  });
  return (await res.json())?.data;
};
let seq = 0;
const say = async (user, text) => {
  const eventId = `ev_${++seq}`;
  const body = JSON.stringify({
    destination: 'G1',
    events: [{
      type: 'message', replyToken: 'a'.repeat(64), webhookEventId: eventId,
      source: { type: 'group', groupId: GID, userId: user.lineUserId },
      timestamp: Date.now(), message: { id: `m_${eventId}`, type: 'text', text },
    }],
  });
  const sig = createHmac('sha256', CH).update(body).digest('base64');
  await (await mf.dispatchFetch('http://localhost/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body,
  })).text();
  await new Promise((r) => setTimeout(r, 320));
};
const balance = async (p) => (await rpc('getDashboardData')).players.find((x) => x.shortId === p.shortId)?.balance;
const order = async (no) => (await rpc('adminInspectOrder', [no]))?.order;
const newestOrder = async (pred) => (await rpc('getDashboardData')).bets.filter(pred).sort((a, b) => b.createdAt - a.createdAt)[0];

console.log('ROUND ISOLATION & DAILY SUMMARY HARNESS\n');

// ── [1] Round binding ──────────────────────────────────────────────────────
console.log('[1] An order from a previous rocket cannot be matched into this one');
await say(P2, 'ต 7001 300');
check('#7001 (old rocket) stays unmatched', (await order('7001'))?.status === 'pending_match');
check('matcher was not charged for #7001', (await balance(P2)) === START, `P2=${await balance(P2)}`);
await say(P2, 'ต 7002 300');
check('#7002 (current rocket) matches normally', (await order('7002'))?.status === 'matched');
// Clear the seeded round so the next scenarios start from a resolved board.
await rpc('adminResolveBets', [400, 330, 380]); // 400 > 350 → high (P1) wins #7002

// ── [2] Chat "ปิดรอบ" + "เปิดรอบ" parks the previous rocket ────────────────
console.log('\n[2] Chat-opened rounds keep each rocket\'s orders apart');
await rpc('adminBroadcastQuote', ['ALL', 'ROCKET_A', 330, 380, false]);
await say(P1, 'ชล500');
const a = await newestOrder((b) => b.status === 'pending_match');
await say(P2, `ต ${a.orderNumber} 500`);
check('rocket A order is matched', (await order(a.orderNumber))?.status === 'matched');

// A matched order is locked for everyone, the admin included.
const p1Locked = await balance(P1), p2Locked = await balance(P2);
await say(P1, `ยกเลิก ${a.orderNumber}`);
await say(P2, `ยกเลิก ${a.orderNumber}`);
const adminCancel = await rpc('adminRequestCancelBet', [a.orderNumber]);
check('creator, matcher and admin cannot cancel a matched order', (await order(a.orderNumber))?.status === 'matched');
check('admin console is told the order is locked', adminCancel?.success === false && adminCancel?.locked === true, JSON.stringify(adminCancel));
check('no credit moved on the refused cancels', (await balance(P1)) === p1Locked && (await balance(P2)) === p2Locked);

const p1BeforeA = await balance(P1), p2BeforeA = await balance(P2);
await say(ADM, 'ปิดรอบ');
await say(ADM, 'เปิดรอบ ROCKET_B');
let dash = await rpc('getDashboardData');
const parkedA = (dash.inFlightRounds || []).find((r) => (r.matchedOrders || []).some((o) => o.orderNumber === a.orderNumber));
check('chat "เปิดรอบ" parked rocket A with its matched order', Boolean(parkedA), JSON.stringify((dash.inFlightRounds || []).map((r) => r.name)));
check('rocket B starts as a new ACTIVE round', dash.activeRound.name === 'ROCKET_B' && dash.activeRound.status === 'ACTIVE' && dash.activeRound.roundId && dash.activeRound.roundId !== 'RND_CURRENT', JSON.stringify(dash.activeRound));

await rpc('adminResolveBets', [400, 330, 380]); // rocket B's time
check('rocket B\'s flight time does NOT settle rocket A\'s order', (await order(a.orderNumber))?.status === 'matched');
await rpc('adminResolveInFlightRound', [parkedA.roundId, 300]); // A: 300 < 330 → low (P2) wins
const settledA = await order(a.orderNumber);
check('rocket A settles on its own time (low side wins)', settledA?.status === 'settled' && settledA?.winnerSide === 'low', JSON.stringify(settledA));
check('payout: winner +950 (500 + 500 − 10%)', (await balance(P2)) === p2BeforeA + 950 && (await balance(P1)) === p1BeforeA, `P1=${await balance(P1)} P2=${await balance(P2)}`);

// ── [3] Chat "ปิดรอบ" with no quote refunds matched pre-quote orders ──────
console.log('\n[3] No quote announced → matched pre-quote order refunded to both');
await say(ADM, 'เปิดรอบ ROCKET_C');
await say(P1, 'ชล300');
const c = await newestOrder((b) => b.betType === 'pre_quote');
check('ROCKET_C order is a pre-quote order', Boolean(c), 'no pre_quote order found');
await say(P2, `ต ${c.orderNumber} 300`);
check('pre-quote order matched before the quote', (await order(c.orderNumber))?.status === 'matched');
const p1C = await balance(P1), p2C = await balance(P2);
await say(ADM, 'ปิดรอบ');
check('chat Final Call cancels the unpriced matched order', (await order(c.orderNumber))?.status === 'cancelled');
check('both sides refunded 300', (await balance(P1)) === p1C + 300 && (await balance(P2)) === p2C + 300, `P1=${await balance(P1)} P2=${await balance(P2)}`);
await say(ADM, 'เปิดรอบ ROCKET_D');
await rpc('adminBroadcastQuote', ['ALL', 'ROCKET_D', 400, 450, false]);
const cAfter = await order(c.orderNumber);
check('next rocket\'s quote does not revive it', cAfter?.status === 'cancelled' && cAfter?.rangeMin === undefined, JSON.stringify(cAfter));

// ── [4] No empty parked round after a resolved one ─────────────────────────
console.log('\n[4] Opening the next rocket after a resolved round');
await rpc('adminResolveBets', [420, 400, 450]);
const before = (await rpc('getDashboardData')).inFlightRounds.length;
await rpc('adminOpenNextRocket', ['ALL', 'ROCKET_E', 'quote', 330, 380, false, false]);
const after = (await rpc('getDashboardData')).inFlightRounds.length;
check('no empty in-flight round is parked', after === before, `before=${before} after=${after}`);

// ── [5] Daily summary ──────────────────────────────────────────────────────
console.log('\n[5] Daily summary');
const sum = await rpc('adminGetDailySummary', []);
check('summary lists every duel settled today (#7002 + rocket A)', sum?.count === 2, `count=${sum?.count}`);
const bubbles = sum?.flex?.contents?.type === 'carousel' ? sum.flex.contents.contents : [sum?.flex?.contents];
check('one card per rocket round', bubbles.length === 2, `bubbles=${bubbles.length}`);
const text = JSON.stringify(sum?.flex);
check('cards name each rocket', text.includes('SEED') && text.includes('ROCKET_A'));
const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// One table row per pair: order, winner, then loser.
check('rocket A card shows winner and loser', new RegExp(`"text":"${esc(P2.name)}"[^\\]]*"text":"${esc(P1.name)}"`).test(text));
check('cards show no stake, payout, fee or volume', !/\bpt\b|ค่าธรรมเนียม|ยอด|ผู้ชนะรับ|คืนเงิน/.test(text), text.match(/[^"]*(\bpt\b|ค่าธรรมเนียม|ยอด|ผู้ชนะรับ|คืนเงิน)[^"]*/)?.[0]);
check('message is under LINE\'s 50KB limit', new TextEncoder().encode(JSON.stringify(sum.flex.contents)).length < 50_000);
const bc = await rpc('adminBroadcastDailySummary', []);
check('broadcast endpoint resolves the group and counts the duels', Array.isArray(bc?.targets) && bc.targets.length > 0 && bc.count === 2, JSON.stringify(bc && { targets: bc.targets, count: bc.count, error: bc.error }));

// ── [5b] Card watermark icons are served by the Worker ─────────────────────
{
  const icon = await mf.dispatchFetch('http://localhost/icons/rocket.png?v=1');
  const bytes = new Uint8Array(await icon.arrayBuffer());
  check('icon route serves a PNG', icon.status === 200 && icon.headers.get('content-type') === 'image/png' && bytes[1] === 0x50 && bytes[2] === 0x4e, `status=${icon.status}`);
  const missing = await mf.dispatchFetch('http://localhost/icons/nope.png');
  await missing.arrayBuffer();
  check('unknown icon is 404', missing.status === 404, `status=${missing.status}`);
  const iconUrls = JSON.stringify(sum?.flex).match(/\/icons\/([a-z]+)\.png/g) || [];
  check('summary card carries a header icon', iconUrls.length > 0);
  check('icon URL uses PUBLIC_BASE_URL, not a hard-coded host',
    /"url":"https:\/\/rocket\.example\/icons\/[a-z]+\.png/.test(JSON.stringify(sum?.flex)) && !JSON.stringify(sum?.flex).includes('workers.dev'));
}

// ── [6] Unauthenticated callers see the public board only ──────────────────
console.log('\n[6] No player data without a login');
await rpc('adminBroadcastQuote', ['ALL', 'ROCKET_F', 330, 380, false]);
await say(P1, 'ชล400');
const f = await newestOrder((b) => b.status === 'pending_match');
await say(P2, `ต ${f.orderNumber} 400`);
await say(P1, 'ชถ250'); // stays open on the board
await rpc('adminOpenNextRocket', ['ALL', 'ROCKET_G', 'quote', 330, 380, false, false]); // parks F
await say(P1, 'ชถ250');
const anon = async (functionName, args = []) => mf.dispatchFetch('http://localhost/api/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ functionName, args }),
});
const pub = (await (await anon('getDashboardData', [P1.shortId])).json())?.data;
const pubText = JSON.stringify(pub);
check('a PL code no longer unlocks that player\'s balance, transactions or chat',
  pub && pub.players.length === 0 && pub.transactions.length === 0 && pub.chatLogs.length === 0, JSON.stringify({ players: pub?.players, tx: pub?.transactions?.length }));
check('public board still lists open orders', (pub?.bets || []).length > 0);
const parkedF = (pub?.inFlightRounds || []).find((r) => (r.matchedOrders || []).some((o) => o.orderNumber === f.orderNumber));
check('public in-flight round still shows the parked duel', Boolean(parkedF));
check('no LINE user ID, player ID or group ID in the public response',
  !pubText.includes(P1.lineUserId) && !pubText.includes(P2.lineUserId) && !pubText.includes(P1.shortId) && !pubText.includes(P2.shortId) && !pubText.includes(GID),
  pubText.slice(0, 300));
check('getP2PResults requires a login', (await anon('getP2PResults')).status === 401);
const adminView = await rpc('getDashboardData');
check('admin still gets the full dashboard', adminView.players.length === everyone.length && adminView.activeGroupId === GID);

await mf.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
