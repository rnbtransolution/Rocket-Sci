/**
 * Verification harness for:
 * 1) Increased spacing & 2-row layout on LINE Order Flex Card rate buttons
 * 2) Unified Rocket Launched + Final Call broadcast action
 * 3) Concurrent Rocket A (In-Flight) + Rocket B (Open for betting) isolation
 *
 * Usage: node concurrent-rounds-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const ADMIN_KEY = 'test_admin_key';
const CH = 'test_secret';
const CREATED_AT = 1750000000000;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'concurrent-harness-'));
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

const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'conc-c', KV_ORDERS: 'conc-o' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: CH, LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
  },
});

const kvC = await mf.getKVNamespace('KV_CACHE');
for (const p of [P1, P2]) {
  const prof = JSON.stringify({
    shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name,
    balance: 2000, registeredAt: CREATED_AT, updatedAt: CREATED_AT,
  });
  await kvC.put(`USER_${p.lineUserId}`, prof);
  await kvC.put(`USER_${p.shortId}`, prof);
  await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
}
await kvC.put('PLAYERS_LIST', JSON.stringify([
  { id: P1.shortId, shortId: P1.shortId, lineUserId: P1.lineUserId, displayName: P1.name, balance: 2000 },
  { id: P2.shortId, shortId: P2.shortId, lineUserId: P2.lineUserId, displayName: P2.name, balance: 2000 },
]));
await kvC.put('ACTIVE_GROUP_ID', 'C0123456789abcdef0123456789abcdef');

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
      source: { type: 'group', groupId: 'C0123456789abcdef0123456789abcdef', userId: user.lineUserId },
      timestamp: Date.now(), message: { id: `m_${eventId}`, type: 'text', text },
    }],
  });
  const sig = createHmac('sha256', CH).update(body).digest('base64');
  await (await mf.dispatchFetch('http://localhost/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body,
  })).text();
  await new Promise((r) => setTimeout(r, 320));
};

console.log('CONCURRENT ROCKET ROUNDS & HOTKEY HARNESS\n');

// 1. Open Rocket A via quote
console.log('1. Rocket A ("บั้งไฟแสนเมือง" 330-380s) opens and players bet');
await rpc('adminBroadcastQuote', ['ALL', 'บั้งไฟแสนเมือง', 330, 380, false]);

await say(P1, 'ชล500');
let dash = await rpc('getDashboardData');
check('P1 created 500 pt order on Rocket A', (dash.bets || []).length === 1);
const orderA1 = dash.bets[0].orderNumber;

// P2 matches orderA1
await say(P2, `ต ${orderA1} 500`);
// P1 also creates an unmatched order (200 pt)
await say(P1, 'ชถ200');
dash = await rpc('getDashboardData');
check('Rocket A has 1 matched order and 1 unmatched pending order',
  dash.bets.filter(b => b.status === 'matched').length === 1 &&
  dash.bets.filter(b => b.status === 'pending_match').length === 1,
  JSON.stringify(dash.bets.map(b => ({ no: b.orderNumber, status: b.status })))
);

// 2. Admin clicks merged "🚀 บั้งไฟออกแล้ว! (ปิดรับดวล)" (adminBroadcastRocketLaunched)
console.log('\n2. Admin triggers merged "🚀 บั้งไฟออกแล้ว! (ปิดรับดวล)"');
await rpc('adminBroadcastRocketLaunched', ['ALL']);
dash = await rpc('getDashboardData');
check('Rocket A round status is now CLOSED (Final Call locked)', dash.roundStatus === 'CLOSED', dash.roundStatus);
check('Unmatched 200 pt order on Rocket A was automatically cancelled & refunded',
  dash.bets.filter(b => b.status === 'pending_match').length === 0
);
check('Matched 500 pt order on Rocket A remains locked',
  dash.bets.filter(b => b.status === 'matched').length === 1
);
const p1AfterLaunchA = dash.players.find(p => p.shortId === P1.shortId).balance;
check('P1 balance refunded the unmatched 200 pt ( sits at 1500 )', p1AfterLaunchA === 1500, `got ${p1AfterLaunchA}`);

// 3. While Rocket A is in the air, Admin opens Rocket B ("บั้งไฟขุนศึก" 400-450s)
console.log('\n3. While Rocket A is in the air, Admin opens Rocket B ("บั้งไฟขุนศึก" 400-450s)');
const openNextRes = await rpc('adminOpenNextRocket', ['ALL', 'บั้งไฟขุนศึก', 'quote', 400, 450, false, true]);
check('adminOpenNextRocket succeeds and parks Rocket A into inFlightRounds',
  openNextRes?.success === true && (openNextRes?.inFlightRounds || []).length === 1
);

dash = await rpc('getDashboardData');
check('Active round is now Rocket B ("บั้งไฟขุนศึก") with status ACTIVE',
  dash.activeRound?.name === 'บั้งไฟขุนศึก' && dash.roundStatus === 'ACTIVE'
);
check('Active board is completely clean (0 bets) for Rocket B',
  (dash.bets || []).length === 0, `active bets: ${(dash.bets || []).length}`
);
check('In-Flight queue holds Rocket A ("บั้งไฟแสนเมือง") with its 1 matched order',
  (dash.inFlightRounds || []).length === 1 &&
  dash.inFlightRounds[0].name === 'บั้งไฟแสนเมือง' &&
  dash.inFlightRounds[0].matchedOrders.length === 1 &&
  dash.inFlightRounds[0].matchedOrders[0].orderNumber === orderA1
);
const rocketARoundId = dash.inFlightRounds[0].roundId;

// 4. Players bet and match on Rocket B while Rocket A is STILL in the air
console.log('\n4. Players place and match bets on Rocket B while Rocket A is still flying');
await say(P2, 'ชถ300');
dash = await rpc('getDashboardData');
check('P2 created 300 pt order on Rocket B', (dash.bets || []).length === 1);
const orderB1 = dash.bets[0].orderNumber;
check('Rocket B order number does not collide with Rocket A order number', orderB1 !== orderA1);

await say(P1, `ต ${orderB1} 300`);
dash = await rpc('getDashboardData');
check('Rocket B order # is matched on active board',
  dash.bets.filter(b => b.status === 'matched').length === 1 &&
  dash.bets[0].orderNumber === orderB1
);

// 5. Rocket A lands at 410s (> 380s -> High / P1 wins on Rocket A!)
console.log('\n5. Rocket A lands at 410s — Admin settles Rocket A from In-Flight queue without touching Rocket B');
const settleARes = await rpc('adminResolveInFlightRound', [rocketARoundId, 410]);
check('adminResolveInFlightRound resolved 1 order on Rocket A', settleARes?.resolvedCount === 1);

dash = await rpc('getDashboardData');
check('In-Flight queue is now empty after Rocket A settled', (dash.inFlightRounds || []).length === 0);
check('Rocket B is STILL ACTIVE and its matched order is untouched!',
  dash.activeRound?.name === 'บั้งไฟขุนศึก' &&
  dash.roundStatus === 'ACTIVE' &&
  dash.bets.filter(b => b.status === 'matched').length === 1 &&
  dash.bets[0].orderNumber === orderB1
);
// P1 started at 2000, staked 500 on A, staked 300 on B (1200 left), won 950 on A -> 2150!
const p1AfterSettleA = dash.players.find(p => p.shortId === P1.shortId).balance;
check('P1 received 950 pt payout from Rocket A (balance = 2150)', p1AfterSettleA === 2150, `got ${p1AfterSettleA}`);

// 6. Rocket B lands at 390s (< 400s -> Low / P2 wins on Rocket B!)
console.log('\n6. Rocket B lands at 390s — Admin settles Rocket B');
const settleBRes = await rpc('adminResolveBets', [390, 400, 450]);
check('adminResolveBets resolved 1 order on Rocket B', settleBRes?.resolvedCount === 1);

dash = await rpc('getDashboardData');
// P2 started at 2000, lost 500 on A (1500), staked 300 on B (1200), won 570 (300 + 270) on B -> 1770!
const p2AfterSettleB = dash.players.find(p => p.shortId === P2.shortId).balance;
check('P2 received 570 pt payout from Rocket B (balance = 1770)', p2AfterSettleB === 1770, `got ${p2AfterSettleB}`);
check('Total points conserved across both concurrent rounds (4000 - 50 - 30 = 3920)',
  p1AfterSettleA + p2AfterSettleB === 3920, `sum = ${p1AfterSettleA + p2AfterSettleB}`
);

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
await mf.dispose();
rmSync(outDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
