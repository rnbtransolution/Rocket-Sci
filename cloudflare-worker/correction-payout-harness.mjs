/**
 * Regression harness: correcting a wrong flight time re-settles the round
 * exactly, and the evening payout takes points off once.
 *
 * THE ROUND (6 duels, 3 players, ranges 350–400 / 300–340 / 340–350)
 *  The admin first types 345 (should be 395). Each pair is settled on 345,
 *  then corrected to 395, then corrected again to 320.
 *
 * ASSERTED
 *  * every balance after a correction equals settling once on the new time;
 *  * the platform keeps exactly Σ round(stake × 10%) of the decided duels;
 *  * a clawback may leave a balance negative (owner decision 2026-11-01);
 *  * the correction needs the danger PIN, and refuses the same time;
 *  * a round past its 20:00 payout cutoff is not offered for correction;
 *  * adminRecordPayout deducts once per request id, refuses more than the
 *    balance, and the payout sheet lists it;
 *  * "ถอน" no longer opens a withdrawal; a bank account typed in DM is saved.
 *
 * Usage:  node correction-payout-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const PIN = '4821';
const START = 10_000;
const RATE = 0.10;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'correction-harness-'));
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

const players = [1, 2, 3].map((n) => ({ shortId: `PL00000${n}`, lineUserId: `Ubbbbb000000000${n}`, name: `P${n}` }));
const prof = (p, bal) => ({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: 1, updatedAt: 1 });
const RANGES = [[350, 400], [300, 340], [340, 350]];
const STAKES = [500, 1000, 333, 2500, 700, 4000];
const NOW = Date.now();

const orders = STAKES.map((amount, i) => {
  const c = players[i % 3], m = players[(i + 1) % 3];
  const [rangeMin, rangeMax] = RANGES[i % 3];
  return {
    orderNumber: String(7101 + i), id: `bet_${7101 + i}`, roundId: 'R_FIX', rocketName: 'ลำทดสอบ',
    creatorId: c.shortId, creatorName: c.name, creatorLineUserId: c.lineUserId,
    matcherId: m.shortId, matcherName: m.name, matcherLineUserId: m.lineUserId,
    side: i % 2 ? 'high' : 'low', amount, betType: 'custom_range', rangeMin, rangeMax,
    status: 'matched', createdAt: NOW - 60_000 + i, matchedAt: NOW - 60_000 + i,
  };
});

/** Balances after settling every order once on `t`, from the confirmed rules. */
function expectedOn(t) {
  const bal = new Map(players.map((p) => [p.shortId, START]));
  let fee = 0;
  for (const o of orders) {
    bal.set(o.creatorId, bal.get(o.creatorId) - o.amount);
    bal.set(o.matcherId, bal.get(o.matcherId) - o.amount);
    const side = t < o.rangeMin ? 'low' : t > o.rangeMax ? 'high' : 'draw';
    if (side === 'draw') {
      bal.set(o.creatorId, bal.get(o.creatorId) + o.amount);
      bal.set(o.matcherId, bal.get(o.matcherId) + o.amount);
    } else {
      const f = Math.round(o.amount * RATE);
      const w = o.side === side ? o.creatorId : o.matcherId;
      bal.set(w, bal.get(w) + o.amount * 2 - f);
      fee += f;
    }
  }
  return { bal, fee };
}

const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'cp-c', KV_ORDERS: 'cp-o' },
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
  const r = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { status: r.status, data: body?.data ?? body };
};
const rpc = async (fn, args) => (await call(fn, args)).data;

const escrow = expectedOn(0).bal; // placeholder start; escrow = START − stakes
for (const p of players) escrow.set(p.shortId, START - orders.reduce((a, o) => a + (o.creatorId === p.shortId || o.matcherId === p.shortId ? o.amount : 0), 0));
for (const o of orders) await kvO.put(`ORDER_${o.orderNumber}`, JSON.stringify(o));
await kvC.put('MATCHED_ORDERS_LIST', JSON.stringify(orders));
await kvC.put('PLAYERS_LIST', JSON.stringify(players.map((p) => prof(p, escrow.get(p.shortId)))));
for (const p of players) {
  await kvC.put(`USER_${p.lineUserId}`, JSON.stringify(prof(p, escrow.get(p.shortId))));
  await kvC.put(`USER_${p.shortId}`, JSON.stringify(prof(p, escrow.get(p.shortId))));
  await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
}
await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId: 'R_FIX', name: 'ลำทดสอบ', targetMin: 350, targetMax: 400, status: 'ACTIVE' }));

const balances = async () => {
  const d = (await rpc('getDashboardData', [])) || {};
  return new Map((d.players || []).map((p) => [p.shortId, Number(p.balance)]));
};
const sameAs = (got, exp) => players.every((p) => got.get(p.shortId) === exp.get(p.shortId));
const show = (m) => players.map((p) => `${p.name}=${m.get(p.shortId)}`).join(' ');

console.log('CORRECTION + PAYOUT HARNESS\n');

check('PIN set', (await call('adminSetDangerPin', [PIN])).status === 200);

const res = await rpc('adminResolveBets', [345, 350, 400]);
check('first settlement (wrong time 345) succeeds', res?.success === true && res?.resolvedCount === 6, JSON.stringify(res));
const b345 = await balances();
check('balances match settling on 345', sameAs(b345, expectedOn(345).bal), `${show(b345)} vs ${show(expectedOn(345).bal)}`);

const list = await rpc('adminListCorrectableRounds', []);
const round = (list?.rounds || []).find((r) => r.key === 'R_FIX');
check('round is offered for correction', !!round && round.finalTime === 345 && round.pairs === 6, JSON.stringify(list));

const noPin = await call('adminCorrectFlightTime', ['R_FIX', 395, '0000']);
check('wrong PIN is refused', noPin.status === 403, `status ${noPin.status}`);
check('nothing moved after the refused PIN', sameAs(await balances(), b345));

const same = await rpc('adminCorrectFlightTime', ['R_FIX', 345, PIN]);
check('same time is refused', same?.success === false, JSON.stringify(same));

const fix1 = await rpc('adminCorrectFlightTime', ['R_FIX', 395, PIN]);
check('correction 345 → 395 succeeds', fix1?.success === true && fix1?.correctedCount === 6, JSON.stringify(fix1));
const b395 = await balances();
const e395 = expectedOn(395);
check('balances equal settling once on 395', sameAs(b395, e395.bal), `${show(b395)} vs ${show(e395.bal)}`);
const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
const stakes = orders.reduce((a, o) => a + o.amount * 2, 0);
check('platform keeps exactly the 395 fees', total(escrow) + stakes - total(b395) === e395.fee,
  `kept ${total(escrow) + stakes - total(b395)}, fees ${e395.fee}`);

const stored = await Promise.all(orders.map(async (o) => JSON.parse(await kvO.get(`ORDER_${o.orderNumber}`))));
check('orders record the corrected time and history', stored.every((o) => o.finalTime === 395 && o.corrections?.length === 1 && o.corrections[0].fromTime === 345),
  JSON.stringify(stored.map((o) => [o.finalTime, o.corrections])));

const sum = await rpc('adminGetDailySummary', []);
check('daily summary shows the corrected result', sum?.count === 6 && (sum.orders || []).every((o) => Number(o.finalTime ?? o.flightTime ?? 395) === 395), JSON.stringify((sum?.orders || []).map((o) => o.finalTime)));

const fix2 = await rpc('adminCorrectFlightTime', ['R_FIX', 320, PIN]);
const b320 = await balances();
check('second correction 395 → 320 equals settling once on 320', fix2?.success === true && sameAs(b320, expectedOn(320).bal), `${show(b320)} vs ${show(expectedOn(320).bal)}`);

// Negative balance: P2 spends almost everything, then a correction claws back.
const p2 = players[1];
await rpc('adminSetPlayerBalance', [p2.shortId, 10, p2.name]);
const before = await balances();
const fix3 = await rpc('adminCorrectFlightTime', ['R_FIX', 395, PIN]);
const b3 = await balances();
const exp3 = new Map([...expectedOn(395).bal].map(([k, v]) => [k, v - expectedOn(320).bal.get(k) + before.get(k)]));
check('clawback may go negative and is exact', fix3?.success === true && sameAs(b3, exp3), `${show(b3)} vs ${show(exp3)}`);
check('negative balances are reported to the admin', (fix3?.negative || []).every((n) => n.balance < 0) && (fix3?.negative || []).length === [...b3.values()].filter((v) => v < 0).length,
  JSON.stringify(fix3?.negative));

// A round past its cutoff (settled 2 days ago) is not offered.
const old = { ...orders[0], orderNumber: '7199', roundId: 'R_OLD', status: 'settled', finalTime: 360, winnerSide: 'draw', payout: 0, settledAt: NOW - 3 * 86400_000, createdAt: NOW - 3 * 86400_000 };
const oldDay = new Date(NOW - 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
await kvO.put('ORDER_7199', JSON.stringify(old));
await kvC.put(`SETTLED_DAY_${oldDay}`, JSON.stringify([old]));
const list2 = await rpc('adminListCorrectableRounds', []);
check('round past its 20:00 cutoff is not offered', !(list2?.rounds || []).some((r) => r.key === 'R_OLD'), JSON.stringify(list2?.rounds?.map((r) => r.key)));
const lateFix = await rpc('adminCorrectFlightTime', ['R_OLD', 300, PIN]);
check('correcting it is refused', lateFix?.success === false, JSON.stringify(lateFix));

// ── Payout ──
const p1 = players[0];
const bal1 = (await balances()).get(p1.shortId);
const pay = await rpc('adminRecordPayout', [p1.shortId, 1000, 'req_abc123']);
check('payout recorded', pay?.success === true && pay?.balance === bal1 - 1000, JSON.stringify(pay));
const dup = await rpc('adminRecordPayout', [p1.shortId, 1000, 'req_abc123']);
check('same request id does not deduct twice', dup?.success === true && dup?.duplicate === true && (await balances()).get(p1.shortId) === bal1 - 1000, JSON.stringify(dup));
const tooMuch = await rpc('adminRecordPayout', [p1.shortId, 10_000_000, 'req_big999']);
check('payout above the balance is refused', tooMuch?.success === false, JSON.stringify(tooMuch));
const sheet = await rpc('adminListPayouts', []);
check('payout sheet lists today\'s payout', (sheet?.paidToday || []).some((t) => t.playerId === p1.shortId && t.amount === 1000), JSON.stringify(sheet?.paidToday));
check('payout sheet lists players with points', (sheet?.players || []).some((r) => r.playerId === p1.shortId), JSON.stringify(sheet?.players));

// ── LINE: no withdrawal, bank account capture ──
const dm = async (text) => rpc('adminSimulatePrivateUserMessage', [text, p1.lineUserId]);
const grp = async (text) => rpc('simulateTextMessageFromDashboard', [text, p1.lineUserId]);
const balW = (await balances()).get(p1.shortId);
await dm('ถอน 500');
check('"ถอน 500" no longer deducts anything', (await balances()).get(p1.shortId) === balW);
const txs = (await rpc('getDashboardData', []))?.transactions || [];
check('"ถอน 500" opens no WD request', !txs.some((t) => String(t.id).startsWith('WD')));

await grp('กสิกร 0123456789 คนอื่น พิมพ์ในกลุ่ม');
const inGroup = JSON.parse(await kvC.get(`USER_${p1.lineUserId}`) || '{}');
check('an unprefixed account typed in the group is ignored', !inGroup.accountNumber, JSON.stringify(inGroup));
await grp('ถอน 500');
check('"ถอน 500" in the group deducts nothing', (await balances()).get(p1.shortId) === balW);
await dm('กสิกร 012-3-45678-9 สมชาย ใจดี');
const prof1 = JSON.parse(await kvC.get(`USER_${p1.lineUserId}`) || '{}');
const dir = ((await rpc('getDashboardData', []))?.players || []).find((p) => p.shortId === p1.shortId) || {};
const acct = prof1.accountNumber || dir.accountNumber || dir.bankAccount;
check('bank account typed in DM is saved', acct === '0123456789' && (prof1.bankName || dir.bankName) === 'กสิกรไทย', JSON.stringify({ prof1, dir }));

await mf.dispose();
rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
