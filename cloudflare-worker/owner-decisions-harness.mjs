/**
 * Regression harness for the owner-decision items closed on 15 Nov 2026.
 *
 *  1. A corrected price moves every ราคาช่าง order of the round, matched or
 *     open, and leaves a player's own range alone. A bare "NNN-NNN" typed by
 *     the admin does the same.
 *  2. The mirror half of an auto-matched pair closes with its partner, and an
 *     old mirror with no partner link is dropped by the 30-day sweep.
 *  3. A player who still holds points cannot be deleted.
 *  4. A verified slip that could not be credited carries its amount, and
 *     approving it uses the slip up.
 *
 * Usage:  node owner-decisions-harness.mjs
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

const outDir = mkdtempSync(join(tmpdir(), 'owner-decisions-harness-'));
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

const players = [1, 2, 3, 4].map((n) => ({
  shortId: `PL00000${n}`, lineUserId: `Uaaaaa000000000${n}`, name: `PLAYER ${n}`,
}));
const [P1, P2, P3, P4] = players;

console.log('OWNER DECISIONS HARNESS\n');

const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'od-cache', KV_ORDERS: 'od-orders' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
  },
});

const kvC = await mf.getKVNamespace('KV_CACHE');
const prof = (p, bal) => JSON.stringify({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });
for (const p of players) {
  await kvC.put(`USER_${p.lineUserId}`, prof(p, 5000));
  await kvC.put(`USER_${p.shortId}`, prof(p, 5000));
  await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
}
await kvC.put('PLAYERS_LIST', JSON.stringify(players.map((p) => ({ id: p.shortId, shortId: p.shortId, lineUserId: p.lineUserId, name: p.name, balance: 5000 }))));
await kvC.put('ACTIVE_GROUP_ID', 'C00000000000000000000000000000001');
await kvC.put('ACTIVE_ROUND', JSON.stringify({
  roundId: 'R_TEST_1', name: 'บั้งไฟทดสอบ', targetMin: 330, targetMax: 380,
  status: 'ACTIVE', isChotoy: false, quoteReleased: true, updatedAt: CREATED_AT,
}));
// Deposits waiting for the admin, as the slip handler leaves them.
const slipTx = (id, extra) => ({
  id, playerId: P2.shortId, lineUserId: P2.lineUserId, playerName: P2.name,
  requestedAmount: 0, actualAmount: 0, slipRef: 'REF700', status: 'escalated',
  reviewReason: 'test', timestamp: '10:00:00', type: 'deposit', createdAt: CREATED_AT, ...extra,
});
await kvC.put('TRANSACTIONS_LIST', JSON.stringify([
  slipTx('TXVERIFIED1', { requestedAmount: 700, slipVerified: true }),
  slipTx('TXVERIFIED2', { requestedAmount: 700, slipVerified: true }),
  slipTx('TXUNREAD', { slipRef: 'msg-1' }),
]));

const call = async (functionName, args = []) => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  });
  const j = await res.json();
  return { status: res.status, body: j?.data || j };
};
const rpc = async (fn, args) => (await call(fn, args)).body;
const say = (p, text) => rpc('simulateTextMessageFromDashboard', [text, p.lineUserId]);
const settle = () => new Promise((r) => setTimeout(r, 300));
const dash = async () => { await settle(); return rpc('getDashboardData'); };
const bal = (d, p) => Number((d.players || []).find((x) => x.id === p.shortId || x.shortId === p.shortId)?.balance);
const mine = (d, p, amount) => (d.bets || []).find((b) => b.creatorId === p.shortId && Number(b.amount) === amount);
const ns = await mf.getDurableObjectNamespace('ROCKET_STATE');
const stub = ns.get(ns.idFromName('rocket-global-state'));
const order = async (no) => JSON.parse((await stub.multi([`ORDER_${no}`]))[0] || 'null');
const band = (o) => `${o?.rangeMin}-${o?.rangeMax}`;

// ── 1. Corrected price ─────────────────────────────────────────────────────
console.log('CORRECTED PRICE');
await say(P1, 'ชล500');
await say(P2, 'ต');
await say(P1, 'ชถ300');
await say(P3, '300-350ล200');
await say(P3, 'ชล400');
await say(P4, 'ชถ400');
let d = await dash();
const duelNo = mine(d, P1, 500)?.orderNumber;
const openNo = mine(d, P1, 300)?.orderNumber;
const ownNo = mine(d, P3, 200)?.orderNumber;
const highNo = mine(d, P3, 400)?.orderNumber;
const lowNo = mine(d, P4, 400)?.orderNumber;
check('board set up at 330-380: one duel, four open orders',
  (await order(duelNo))?.status === 'matched' && band(await order(duelNo)) === '330-380' && [openNo, ownNo, highNo, lowNo].every(Boolean),
  JSON.stringify((d.bets || []).map((b) => [b.orderNumber, b.status, b.amount])));
check('stakes are held: P1 4200, P2 4500, P3 4400, P4 4600', bal(d, P1) === 4200 && bal(d, P2) === 4500 && bal(d, P3) === 4400 && bal(d, P4) === 4600, `${bal(d, P1)} ${bal(d, P2)} ${bal(d, P3)} ${bal(d, P4)}`);

const rq = await call('adminBroadcastQuote', ['ALL', 'ช่างทดสอบ', 340, 390, false]);
d = await dash();
check('the round keeps its id and takes the new price', d.activeRound?.roundId === 'R_TEST_1' && d.activeRound?.targetMin === 340 && d.activeRound?.targetMax === 390, JSON.stringify(d.activeRound));
check('the matched duel moves to 340-390', band(await order(duelNo)) === '340-390' && (await order(duelNo))?.status === 'matched', band(await order(duelNo)));
check('the open order moves to 340-390', band(await order(openNo)) === '340-390' && (await order(openNo))?.status === 'pending_match', band(await order(openNo)));
check("a player's own range 300-350 is not touched", band(await order(ownNo)) === '300-350', band(await order(ownNo)));
check('the reply reports what moved', rq.body?.reRanged?.matched === 1 && rq.body?.reRanged?.pending === 3, JSON.stringify(rq.body?.reRanged));
check('no credit moved', bal(d, P1) === 4200 && bal(d, P2) === 4500 && bal(d, P3) === 4400 && bal(d, P4) === 4600, `${bal(d, P1)} ${bal(d, P2)} ${bal(d, P3)} ${bal(d, P4)}`);

// ── 2. Auto-matched pair ───────────────────────────────────────────────────
console.log('\nAUTO-MATCHED PAIR');
let low = await order(lowNo), high = await order(highNo);
check('the two 400 pt orders were paired on the new price', low?.status === 'matched' && high?.status === 'matched_paired' && band(low) === '340-390' && band(high) === '340-390', `${low?.status} ${high?.status} ${band(low)}`);
check('each half names the other', String(low?.pairedOrderNumber) === String(highNo) && String(high?.pairedOrderNumber) === String(lowNo), `${low?.pairedOrderNumber} ${high?.pairedOrderNumber}`);

await rpc('sendAdminMessageToLine', ['ALL', '350-400']);
d = await dash();
low = await order(lowNo); high = await order(highNo);
check('a bare "350-400" from the admin moves the duels again', band(await order(duelNo)) === '350-400' && band(low) === '350-400' && band(high) === '350-400', `${band(await order(duelNo))} ${band(low)} ${band(high)}`);

// 395 s: a draw on 350-400. On 340-390 or 330-380 the high side would have won.
const s1 = await call('adminResolveBets', [395, 350, 400]);
d = await dash();
check('settle succeeds', s1.status === 200 && s1.body.success === true, JSON.stringify(s1.body).slice(0, 160));
check('395 s is a draw on the corrected band: everyone back to 5000', [P1, P2, P3, P4].every((p) => bal(d, p) === 5000), `${bal(d, P1)} ${bal(d, P2)} ${bal(d, P3)} ${bal(d, P4)}`);
low = await order(lowNo); high = await order(highNo);
check('the mirror closes with its partner', low?.status === 'settled' && high?.status === 'resolved' && String(high?.closedWithOrder) === String(lowNo), `${low?.status} ${high?.status}`);

const OLD = Date.now() - 40 * 24 * 60 * 60 * 1000;
await stub.writeMany([
  ['ORDER_91001', JSON.stringify({ orderNumber: '91001', status: 'matched_paired', amount: 100, side: 'high', creatorId: P1.shortId, createdAt: OLD, matchedAt: OLD })],
  ['ORDER_91002', JSON.stringify({ orderNumber: '91002', status: 'matched_paired', amount: 100, side: 'high', creatorId: P1.shortId, createdAt: Date.now(), matchedAt: Date.now() })],
  ['ORDER_91003', JSON.stringify({ orderNumber: '91003', status: 'matched', amount: 100, side: 'low', creatorId: P1.shortId, createdAt: OLD, matchedAt: OLD })],
]);
await stub.sweepRetention();
check('a 40-day-old mirror with no partner link is swept', (await order('91001')) === null);
check('a fresh mirror and an old MATCHED order are kept', (await order('91002')) !== null && (await order('91003')) !== null);

// ── 3. Delete a player who holds points ────────────────────────────────────
console.log('\nDELETE WITH A BALANCE');
const del1 = await call('adminDeletePlayer', [P4.shortId]);
d = await dash();
check('refused while the player holds 5000 pt', del1.status === 409 && bal(d, P4) === 5000, `${del1.status} ${JSON.stringify(del1.body).slice(0, 120)}`);
await call('adminSetPlayerBalance', [P4.shortId, 0, P4.name]);
const del2 = await call('adminDeletePlayer', [P4.shortId]);
check('allowed once the balance is 0', del2.status === 200 && del2.body.success === true, JSON.stringify(del2.body).slice(0, 120));

// ── 4. Verified slip that could not be credited ────────────────────────────
console.log('\nVERIFIED SLIP, MANUAL APPROVAL');
const a1 = await call('adminApproveTransaction', ['TXVERIFIED1']);
d = await dash();
check('approving credits the amount the slip proves (+700)', a1.body.success === true && bal(d, P2) === 5700, `${JSON.stringify(a1.body).slice(0, 120)} P2 ${bal(d, P2)}`);
const a2 = await call('adminApproveTransaction', ['TXVERIFIED2']);
d = await dash();
check('the same slip cannot be approved a second time', a2.body.success === false && bal(d, P2) === 5700, `${JSON.stringify(a2.body).slice(0, 160)} P2 ${bal(d, P2)}`);
check('  and that entry stays open for the admin to reject', (d.transactions || []).find((t) => t.id === 'TXVERIFIED2')?.status === 'escalated');
const a3 = await call('adminApproveTransaction', ['TXUNREAD']);
d = await dash();
check('an unread slip (amount 0) cannot be approved without an amount', a3.body.success === false && bal(d, P2) === 5700 && (d.transactions || []).find((t) => t.id === 'TXUNREAD')?.status === 'escalated', JSON.stringify(a3.body).slice(0, 160));
const a4 = await call('adminApproveTransaction', ['TXVERIFIED2', 999]);
d = await dash();
check('a verified slip refuses a different typed amount', a4.body.success === false && bal(d, P2) === 5700, JSON.stringify(a4.body).slice(0, 160));
const a5 = await call('adminApproveTransaction', ['TXUNREAD', 'abc']);
check('a non-numeric typed amount is refused', a5.body.success === false);
const a6 = await call('adminApproveTransaction', ['TXUNREAD', 500]);
d = await dash();
const unread = (d.transactions || []).find((t) => t.id === 'TXUNREAD');
check('the admin-typed amount (500) is credited once and recorded', a6.body.success === true && bal(d, P2) === 6200 && unread?.status === 'success' && unread?.requestedAmount === 500 && unread?.actualAmount === 500, `${JSON.stringify(a6.body).slice(0, 120)} P2 ${bal(d, P2)}`);
const a7 = await call('adminApproveTransaction', ['TXUNREAD', 500]);
d = await dash();
check('  and a second click does not credit again', a7.body.success === false && bal(d, P2) === 6200);
const r1 = await call('adminRescanSlip', ['TXVERIFIED2']);
check('rescan of an entry with no slip image is refused', r1.body.success === false, JSON.stringify(r1.body).slice(0, 160));
const r2 = await call('adminRescanSlip', ['TXUNREAD']);
check('rescan of a finished entry is refused', r2.body.success === false && bal(await dash(), P2) === 6200, JSON.stringify(r2.body).slice(0, 160));

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
await mf.dispose();
try { rmSync(outDir, { recursive: true }); } catch (_) {}
if (fail > 0) process.exit(1);
