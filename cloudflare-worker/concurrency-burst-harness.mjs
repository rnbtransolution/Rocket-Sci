/**
 * Regression harness for burst traffic: many LINE messages arriving at once.
 *
 * Every other harness sends one message, waits ~300ms, then sends the next. Real
 * traffic does not look like that: a busy LINE group sends 20-30 messages in
 * one second, and LINE delivers each as its own webhook request, so the Worker
 * handles them at the same time. Each case below fires its requests together
 * and then checks the money:
 *
 *   * one player sending several bets at once must not spend more than their
 *     balance
 *   * many players betting at once must all appear on the board (no order may
 *     be dropped from the index while its stake is held)
 *   * a payout landing while the winner is betting must not be overwritten
 *   * an admin double-clicking "settle" or "approve" must pay once
 *   * an order that has settled can no longer be cancelled for a refund
 *
 * Usage:  node concurrency-burst-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const ADMIN_KEY = 'test_admin_key';
const CHANNEL_SECRET = 'test_channel_secret';
const CREATED_AT = 1750000000000;
const GROUP_ID = 'C' + '0123456789abcdef0123456789abcdef';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const outDir = mkdtempSync(join(tmpdir(), 'burst-harness-'));
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

const player = (n) => ({
  shortId: `PL${String(n).padStart(6, '0')}`,
  lineUserId: `Uaaaaa${String(n).padStart(10, '0')}`,
  name: `P${n}`,
});

let envSeq = 0;
async function freshEnv(players, startBalance = 1000) {
  const suffix = `${Date.now()}-${++envSeq}`;
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `bh-c-${suffix}`, KV_ORDERS: `bh-o-${suffix}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    // LINE replies/pushes must fail fast and locally, never reach the network.
    outboundService: () => new Response('{}', { status: 200 }),
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvC = await mf.getKVNamespace('KV_CACHE');
  const prof = (p, bal) => ({
    shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name,
    balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT,
  });
  await kvC.put('PLAYERS_LIST', JSON.stringify(players.map((p) => prof(p, startBalance))));
  for (const p of players) {
    await kvC.put(`USER_${p.lineUserId}`, JSON.stringify(prof(p, startBalance)));
    await kvC.put(`USER_${p.shortId}`, JSON.stringify(prof(p, startBalance)));
    await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
  }
  await kvC.put('ACTIVE_GROUP_ID', GROUP_ID);
  await kvC.put('ACTIVE_ROUND', JSON.stringify({
    name: 'TEST', targetMin: 330, targetMax: 380, status: 'ACTIVE',
    isChotoy: false, quoteReleased: true, updatedAt: CREATED_AT,
  }));

  let seq = 0;
  /** Send one LINE group message; resolves once the Worker has fully processed it. */
  async function say(user, text) {
    const eventId = `e${++seq}-${Math.random()}`;
    const body = JSON.stringify({
      destination: 'Utest',
      events: [{
        type: 'message', replyToken: 'a'.repeat(64), webhookEventId: eventId,
        source: { type: 'group', groupId: GROUP_ID, userId: user.lineUserId },
        timestamp: Date.now(), message: { id: `m${eventId}`, type: 'text', text },
      }],
    });
    const sig = createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
    await (await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-line-signature': sig },
      body,
    })).text();
  }
  async function rpc(functionName, args = []) {
    return (await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName, args }),
    })).json();
  }
  async function dashboard() {
    return (await rpc('getDashboardData'))?.data || {};
  }
  async function balanceOf(p) {
    const d = await dashboard();
    const row = (d.players || []).find((x) => x.shortId === p.shortId);
    return row ? Number(row.balance) : NaN;
  }
  async function listOrders() {
    return (await rpc('adminListOrders'))?.orders || (await rpc('adminListOrders'))?.data || [];
  }
  return { mf, kvC, say, rpc, dashboard, balanceOf, listOrders, dispose: () => mf.dispose() };
}

/** Wait for background (waitUntil) work started by the webhook to finish. */
const settle = () => sleep(1500);

console.log('CONCURRENCY BURST HARNESS\n');

// ── 1. One player fires three bets at once with only enough for two ─────────
console.log('ONE PLAYER, THREE SIMULTANEOUS BETS, BALANCE FOR TWO');
{
  const P = player(1);
  const env = await freshEnv([P], 1000);
  await Promise.all([env.say(P, 'ชล500'), env.say(P, 'ชถ500'), env.say(P, 'ชล500')]);
  await settle();
  const d = await env.dashboard();
  const mine = (d.bets || []).filter((b) => b.creatorId === P.shortId && String(b.status).startsWith('pending'));
  const bal = await env.balanceOf(P);
  const locked = mine.reduce((s, b) => s + Number(b.amount || 0), 0);
  check('balance never goes negative', bal >= 0, `balance=${bal}`);
  check('at most two 500pt orders were accepted', mine.length <= 2, `orders=${mine.length}`);
  check('balance + stakes on the board = 1000 (no money created)', bal + locked === 1000,
    `balance=${bal} locked=${locked} orders=${mine.length}`);
  await env.dispose();
}

// ── 2. Twenty players bet in the same second ───────────────────────────────
console.log('\nTWENTY PLAYERS BET IN THE SAME SECOND');
{
  const ps = Array.from({ length: 20 }, (_, i) => player(100 + i));
  const env = await freshEnv(ps, 1000);
  await Promise.all(ps.map((p, i) => env.say(p, `${i % 2 ? 'ชล' : 'ชถ'}${100 + i * 10}`)));
  await settle();
  const d = await env.dashboard();
  const pending = (d.bets || []).filter((b) => String(b.status).startsWith('pending'));
  const totalBal = (d.players || []).reduce((s, p) => s + Number(p.balance || 0), 0);
  const locked = pending.reduce((s, b) => s + Number(b.amount || 0), 0);
  check('all 20 orders are on the board', pending.length === 20, `board=${pending.length}`);
  check('every order number is unique', new Set(pending.map((b) => String(b.id || b.orderNumber))).size === pending.length);
  check('balances + stakes = 20,000 (no stake held off-board)', totalBal + locked === 20000,
    `balances=${totalBal} locked=${locked}`);
  await env.dispose();
}

// ── 3. Payout lands while the winner is placing new bets ───────────────────
console.log('\nSETTLEMENT PAYOUT RACING THE WINNER\'S NEW BETS');
{
  const W = player(201), L = player(202);
  const env = await freshEnv([W, L], 1000);
  await env.say(W, 'ชถ500');           // W: 500 low on 330-380
  await settle();
  const d0 = await env.dashboard();
  const ord = (d0.bets || [])[0];
  const no = String(ord?.id || ord?.orderNumber || '').replace(/^bet_/, '');
  await env.say(L, `ต ${no} 500`);      // L takes it
  await settle();
  // Rocket lands at 300s -> low (W) wins: W gets 500 + 450 = 950.
  // At the same moment W sends more bets in the new round.
  await Promise.all([
    env.rpc('adminResolveBets', [300, 330, 380]),
    env.say(W, 'ชล100'), env.say(W, 'ชล100'), env.say(W, 'ชล100'),
  ]);
  await settle();
  const d = await env.dashboard();
  const wBal = Number((d.players || []).find((x) => x.shortId === W.shortId)?.balance);
  const wLocked = (d.bets || []).filter((b) => b.creatorId === W.shortId && String(b.status).startsWith('pending'))
    .reduce((s, b) => s + Number(b.amount || 0), 0);
  // 1000 - 500 stake + 950 payout = 1450, whatever is now riding on new bets.
  check('winner\'s payout survives the concurrent bets (balance + new stakes = 1450)',
    wBal + wLocked === 1450, `balance=${wBal} newStakes=${wLocked}`);
  await env.dispose();
}

// ── 4. Admin double-clicks "settle" ─────────────────────────────────────────
console.log('\nADMIN DOUBLE-CLICKS SETTLE');
{
  const W = player(301), L = player(302);
  const env = await freshEnv([W, L], 1000);
  await env.say(W, 'ชถ500');
  await settle();
  const ord = ((await env.dashboard()).bets || [])[0];
  const no = String(ord?.id || ord?.orderNumber || '').replace(/^bet_/, '');
  await env.say(L, `ต ${no} 500`);
  await settle();
  await Promise.all([
    env.rpc('adminResolveBets', [300, 330, 380]),
    env.rpc('adminResolveBets', [300, 330, 380]),
  ]);
  await settle();
  const wb = await env.balanceOf(W), lb = await env.balanceOf(L);
  check('winner paid exactly once (1450)', wb === 1450, `winner=${wb}`);
  check('loser stays at 500', lb === 500, `loser=${lb}`);
  await env.dispose();
}

// ── 5. Admin double-clicks "approve" on a deposit ──────────────────────────
console.log('\nADMIN DOUBLE-CLICKS APPROVE ON A DEPOSIT');
{
  const P = player(401);
  const env = await freshEnv([P], 0);
  await env.kvC.put('TRANSACTIONS_LIST', JSON.stringify([{
    id: 'TX123456', playerId: P.shortId, lineUserId: P.lineUserId, playerName: P.name,
    requestedAmount: 1000, actualAmount: 0, status: 'escalated', type: 'deposit',
    timestamp: '00:00', createdAt: CREATED_AT,
  }]));
  await Promise.all([
    env.rpc('adminApproveTransaction', ['TX123456']),
    env.rpc('adminApproveTransaction', ['TX123456']),
  ]);
  await settle();
  const b = await env.balanceOf(P);
  check('deposit credited exactly once (1000)', b === 1000, `balance=${b}`);
  await env.dispose();
}

// ── 6. A settled order cannot be cancelled for a refund ────────────────────
console.log('\nCANCELLING A SETTLED ORDER');
{
  const W = player(501), L = player(502);
  const env = await freshEnv([W, L], 1000);
  await env.say(W, 'ชถ500');
  await settle();
  const ord = ((await env.dashboard()).bets || [])[0];
  const no = String(ord?.id || ord?.orderNumber || '').replace(/^bet_/, '');
  await env.say(L, `ต ${no} 500`);
  await settle();
  await env.rpc('adminResolveBets', [300, 330, 380]);
  await settle();
  await env.rpc('adminRequestCancelBet', [no]);
  await settle();
  const wb = await env.balanceOf(W), lb = await env.balanceOf(L);
  check('winner not refunded on top of the payout', wb === 1450, `winner=${wb}`);
  check('loser not refunded after losing', lb === 500, `loser=${lb}`);
  await env.dispose();
}

// ── 7. A player cancels while someone takes the order ──────────────────────
console.log('\nCANCEL RACING A MATCH ON THE SAME ORDER');
{
  const C = player(601), M = player(602);
  let bad = 0;
  for (let i = 0; i < 5; i++) {
    const env = await freshEnv([C, M], 1000);
    await env.say(C, 'ชถ500');
    await settle();
    const ord = ((await env.dashboard()).bets || [])[0];
    const no = String(ord?.id || ord?.orderNumber || '').replace(/^bet_/, '');
    await Promise.all([env.say(M, `ต ${no} 500`), env.say(C, `ยกเลิก ${no}`)]);
    await settle();
    const cb = await env.balanceOf(C), mb = await env.balanceOf(M);
    // Either the cancel won (1000/1000) or the match won (500/500, order live).
    const ok = (cb === 1000 && mb === 1000) || (cb === 500 && mb === 500);
    if (!ok) { bad++; console.log(`    run ${i}: creator=${cb} matcher=${mb}`); }
    await env.dispose();
  }
  check('cancel and match never both succeed', bad === 0, `${bad}/5 runs inconsistent`);
}

// ── 8. Two withdrawals at once with credit for one ─────────────────────────
console.log('\nTWO SIMULTANEOUS WITHDRAWALS, CREDIT FOR ONE');
{
  const P = player(701);
  const env = await freshEnv([P], 1000);
  const prof = JSON.parse(await env.kvC.get(`USER_${P.lineUserId}`));
  Object.assign(prof, { bankName: 'KBANK', accountNumber: '1234567890', accountName: 'P701' });
  await env.kvC.put(`USER_${P.lineUserId}`, JSON.stringify(prof));
  await env.kvC.put(`USER_${P.shortId}`, JSON.stringify(prof));
  await Promise.all([env.say(P, 'ถอน 800'), env.say(P, 'ถอน 800')]);
  await settle();
  const d = await env.dashboard();
  const wds = (d.transactions || []).filter((t) => t.type === 'withdraw' && t.playerId === P.shortId);
  const bal = await env.balanceOf(P);
  check('only one withdrawal request opened', wds.length === 1, `requests=${wds.length}`);
  check('balance is 200, never negative', bal === 200, `balance=${bal}`);

  // Admin double-clicks REJECT: the 800 comes back exactly once.
  const id = wds[0]?.id;
  await Promise.all([
    env.rpc('adminRejectTransaction', [id, 'test']),
    env.rpc('adminRejectTransaction', [id, 'test']),
  ]);
  await settle();
  const after = await env.balanceOf(P);
  check('rejected withdrawal refunded exactly once (1000)', after === 1000, `balance=${after}`);
  await env.dispose();
}

// ── 9. A new LINE user whose id ends like an existing player's ─────────────
console.log('\nSHORT-ID COLLISION: NEWCOMER MUST NOT INHERIT ANOTHER ACCOUNT');
{
  const OLD = { shortId: 'PLABCDEF', lineUserId: 'U1111111111111111111111111abcdef', name: 'OLD' };
  const NEW = { shortId: 'PLABCDEF', lineUserId: 'U2222222222222222222222222abcdef', name: 'NEW' };
  const env = await freshEnv([OLD], 5000);
  await env.say(NEW, 'ยอด');
  await settle();
  await env.say(NEW, 'ชล500');            // must be refused: newcomer has 0 credit
  await settle();
  const d = await env.dashboard();
  const oldRow = (d.players || []).find((p) => p.lineUserId === OLD.lineUserId);
  const newRow = (d.players || []).find((p) => p.lineUserId === NEW.lineUserId);
  check('existing player keeps 5000', Number(oldRow?.balance) === 5000, JSON.stringify(oldRow));
  check('newcomer has their own record with 0 credit', newRow && Number(newRow.balance) === 0 && newRow.shortId !== OLD.shortId, JSON.stringify(newRow));
  check('newcomer could not bet with the other player\'s credit',
    !(d.bets || []).some((b) => b.creatorLineUserId === NEW.lineUserId), JSON.stringify((d.bets || []).map((b) => b.creatorLineUserId)));
  await env.dispose();
}

// ── 10. Settlement with no flight time entered ────────────────────────────
console.log('\nSETTLE WITH A BLANK FLIGHT TIME');
{
  const W = player(801), L = player(802);
  const env = await freshEnv([W, L], 1000);
  await env.say(W, 'ชล500');
  await settle();
  const ord = ((await env.dashboard()).bets || [])[0];
  const no = String(ord?.id || ord?.orderNumber || '').replace(/^bet_/, '');
  await env.say(L, `ต ${no} 500`);
  await settle();
  const r = await env.rpc('adminResolveBets', ['', 330, 380]);
  await settle();
  const wb = await env.balanceOf(W), lb = await env.balanceOf(L);
  check('blank time is refused', r?.success === false, JSON.stringify(r));
  check('nobody is paid on a blank time', wb === 500 && lb === 500, `w=${wb} l=${lb}`);
  await env.dispose();
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
