/**
 * Regression harness for the 15 Nov 2026 audit fixes.
 *
 *  1. Taking a whole order is allowed below the 100 pt partial-take floor
 *     (orders open from 50 pt; the card's full button sends "ต <no> <amount>").
 *  2. "ต NNNN" is an order number only while that order is live; a finished
 *     order with the same number no longer swallows "take NNNN points".
 *  3. An announcement is not a command: text that merely contains
 *     "เปิดรับดวล" / "ปิดรับดวล" or a NNN-NNN no longer closes or re-prices the round.
 *  4. A second settle on a finished round is refused.
 *  5. A balance that is not a number is refused instead of becoming 0.
 *  6. A player with a live order cannot be deleted.
 *
 * Usage:  node audit-fixes-harness.mjs
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

const outDir = mkdtempSync(join(tmpdir(), 'audit-fixes-harness-'));
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

const players = [1, 2, 3].map((n) => ({
  shortId: `PL00000${n}`, lineUserId: `Uaaaaa000000000${n}`, name: `PLAYER ${n}`,
}));
const [P1, P2, P3] = players;

console.log('AUDIT FIXES HARNESS\n');

const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'af-cache', KV_ORDERS: 'af-orders' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
  },
});

const kvC = await mf.getKVNamespace('KV_CACHE');
const kvO = await mf.getKVNamespace('KV_ORDERS');
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
// A finished order from an earlier day that happens to be numbered 1000.
await kvO.put('ORDER_1000', JSON.stringify({
  orderNumber: '1000', creatorId: 'PL999999', creatorName: 'OLD', side: 'low', amount: 300,
  betType: 'range', rangeMin: 330, rangeMax: 380, status: 'settled', createdAt: CREATED_AT - 86400000, settledAt: CREATED_AT - 86000000,
}));

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
const findBet = (d, pred) => (d.bets || []).find(pred);

// ── 1. Whole-order take under 100 pt ───────────────────────────────────────
console.log('WHOLE-ORDER TAKE UNDER 100 PT');
await say(P1, 'ชล50');
let d = await dash();
const small = findBet(d, (b) => b.creatorId === P1.shortId);
check('"ชล50" opens a 50 pt order', small?.amount === 50, JSON.stringify(small));
await say(P2, `ต ${small?.orderNumber} 50`);
d = await dash();
check('"ต <no> 50" (the card\'s full button) takes it', findBet(d, (b) => b.orderNumber === small?.orderNumber)?.status === 'matched' && bal(d, P2) === 4950, `P2 ${bal(d, P2)}`);

await say(P1, 'ชล500');
d = await dash();
const big = findBet(d, (b) => b.creatorId === P1.shortId && b.status === 'pending_match');
await say(P2, `ต ${big?.orderNumber} 50`);
d = await dash();
check('a 50 pt PARTIAL take of a 500 pt order is still refused', findBet(d, (b) => b.orderNumber === big?.orderNumber)?.status === 'pending_match' && bal(d, P2) === 4950, `P2 ${bal(d, P2)}`);

// ── 2. "ต 1000" with a finished #1000 on record ────────────────────────────
console.log('\n"ต NNNN" AND A FINISHED ORDER WITH THAT NUMBER');
await say(P1, 'ชถ2000');
d = await dash();
const two = findBet(d, (b) => b.creatorId === P1.shortId && b.amount === 2000);
check('P1 opens a 2000 pt order (the newest on the board)', Boolean(two), JSON.stringify(d.bets));
await say(P3, 'ต 1000');
d = await dash();
const taken = findBet(d, (b) => b.orderNumber === two?.orderNumber);
check('"ต 1000" takes 1000 pt of the newest order, not old #1000', taken?.status === 'matched' && taken?.amount === 1000 && bal(d, P3) === 4000, `${JSON.stringify(taken)} P3 ${bal(d, P3)}`);

// ── 3. Announcements are not commands ──────────────────────────────────────
console.log('\nANNOUNCEMENTS ARE NOT COMMANDS');
await rpc('sendAdminMessageToLine', ['ALL', 'ประกาศจากสนาม: พักเบรก 15 นาที จะเริ่มเปิดรับดวลรอบถัดไปเร็ว ๆ นี้ครับ']);
d = await dash();
check('break notice containing "เปิดรับดวล" leaves the round ACTIVE', d.activeRound?.status === 'ACTIVE', d.activeRound?.status);
check('  and the open order stays on the board', findBet(d, (b) => b.orderNumber === big?.orderNumber)?.status === 'pending_match');
await rpc('sendAdminMessageToLine', ['ALL', 'ติดต่อแอดมิน 081-234-5678 ได้ตลอด']);
d = await dash();
check('a phone number in a notice does not change the price', d.activeRound?.targetMin === 330 && d.activeRound?.targetMax === 380, `${d.activeRound?.targetMin}-${d.activeRound?.targetMax}`);
await rpc('sendAdminMessageToLine', ['ALL', 'ปิดรับดวล']);
d = await dash();
check('the exact command "ปิดรับดวล" still closes the round', d.activeRound?.status === 'CLOSED', d.activeRound?.status);
check('  and refunds the unmatched order (P1 back +500)', !findBet(d, (b) => b.orderNumber === big?.orderNumber), JSON.stringify(d.bets.map((b) => b.orderNumber)));

// ── 6. Delete guard (while P2 still has a matched order) ───────────────────
console.log('\nDELETE GUARD');
const del = await call('adminDeletePlayer', [P2.shortId]);
d = await dash();
check('deleting a player with a matched order is refused', del.status === 409 && Number.isFinite(bal(d, P2)), `${del.status} ${JSON.stringify(del.body).slice(0, 120)}`);

// ── 4. Repeat settle ───────────────────────────────────────────────────────
console.log('\nREPEAT SETTLE');
const s1 = await call('adminResolveBets', [400, 330, 380]);
check('first settle succeeds', s1.status === 200 && s1.body.success === true && s1.body.resolvedCount === 2, JSON.stringify(s1.body).slice(0, 160));
d = await dash();
const afterP1 = bal(d, P1), afterP2 = bal(d, P2), afterP3 = bal(d, P3);
// 50 high (P1) vs P2: 400 > 380, high wins: P1 +95. 2000 low (P1, 1000 taken by P3): high wins: P3 +1900.
check('payouts: P1 5000-50-500-2000+500+1000+95 = 4045, P2 4950, P3 5900', afterP1 === 4045 && afterP2 === 4950 && afterP3 === 5900, `${afterP1} ${afterP2} ${afterP3}`);
const s2 = await call('adminResolveBets', [360, 330, 380]);
d = await dash();
check('second settle on the finished round is refused', s2.status === 409 && s2.body.success === false, `${s2.status} ${JSON.stringify(s2.body).slice(0, 120)}`);
check('  recorded flight time is still 400', Number(d.activeRound?.finalTime) === 400 && d.activeRound?.status === 'RESOLVED', JSON.stringify(d.activeRound));
check('  no balance moved', bal(d, P1) === afterP1 && bal(d, P2) === afterP2 && bal(d, P3) === afterP3);

// ── 5. Balance input ───────────────────────────────────────────────────────
console.log('\nBALANCE INPUT');
const b1 = await call('adminSetPlayerBalance', [P2.shortId, '', P2.name]);
const b2 = await call('adminSetPlayerBalance', [P2.shortId, 'abc', P2.name]);
const b3 = await call('adminSetPlayerBalance', [P2.shortId, -5, P2.name]);
d = await dash();
check('empty / text / negative balance refused, P2 unchanged', b1.status === 400 && b2.status === 400 && b3.status === 400 && bal(d, P2) === afterP2, `${b1.status} ${b2.status} ${b3.status} ${bal(d, P2)}`);
await call('adminSetPlayerBalance', [P2.shortId, 0, P2.name]);
d = await dash();
check('an explicit 0 is still accepted', bal(d, P2) === 0, `got ${bal(d, P2)}`);
const del2 = await call('adminDeletePlayer', [P2.shortId]);
check('with no live order the player can be deleted', del2.status === 200 && del2.body.success === true, JSON.stringify(del2.body).slice(0, 120));

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
await mf.dispose();
try { rmSync(outDir, { recursive: true }); } catch (_) {}
if (fail > 0) process.exit(1);
