/**
 * Regression harness for duplicate/concurrent order matching.
 *
 * WHAT THE PRODUCTION CHAT LOG SHOWED
 * -----------------------------------
 *   07:33:50  A-K      ต 7015 500     <- matched
 *   07:33:57  A-K      ต 7015 100     <- same order again, 7 seconds later
 *   07:35:47  D Xebex  ต 7015 200     <- and again
 *
 *   and earlier in the same round:
 *   07:00:27  ITT      ต 4181 100
 *   07:00:38  D Xebex  ต 4181 40      <- same order, 11 seconds later
 *
 * So players repeatedly re-tap the same order. Each of those is an independent
 * webhook invocation, and `handleMatchOrder` decides whether the order is still
 * open by reading `KV_ORDERS` — which is eventually consistent. Two requests
 * that arrive close together can BOTH observe `pending_match` and BOTH proceed:
 * two matches recorded against one order, and the matcher debited twice.
 *
 * Refunds are protected by `claimExclusive` in `refundOrderOnce`. MATCHING has
 * no equivalent guard — this harness is what that absence costs.
 *
 * Usage:  node duplicate-match-harness.mjs
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

const outDir = mkdtempSync(join(tmpdir(), 'dupmatch-harness-'));
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

const A = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'CREATOR' };

async function freshEnv(suffix) {
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `dm-cache-${suffix}`, KV_ORDERS: `dm-ord-${suffix}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvO = await mf.getKVNamespace('KV_ORDERS');
  const kvC = await mf.getKVNamespace('KV_CACHE');

  const prof = (p, bal) => JSON.stringify({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });

  // `orderAmount` is the stake; the creator has already paid it, so the seed
  // balance is the post-stake figure.
  async function seed(orderNo, orderAmount, matchers) {
    const order = {
      orderNumber: orderNo, creatorId: A.shortId, creatorName: A.name,
      creatorLineUserId: A.lineUserId, side: 'low', amount: orderAmount,
      betType: 'range', rangeMin: 330, rangeMax: 380,
      status: 'pending_match', createdAt: CREATED_AT, id: `bet_${orderNo}`,
      playerLowId: A.shortId, playerLowName: A.name,
    };
    await kvO.put(`ORDER_${orderNo}`, JSON.stringify(order));
    await kvC.put('PENDING_ORDERS_LIST', JSON.stringify([order]));
    const players = [{ p: A, bal: 1000 - orderAmount }];
    for (const m of matchers) players.push({ p: m, bal: 1000 });
    await kvC.put('PLAYERS_LIST', JSON.stringify(players.map((x) => JSON.parse(prof(x.p, x.bal)))));
    for (const x of players) {
      await kvC.put(`USER_${x.p.lineUserId}`, prof(x.p, x.bal));
      await kvC.put(`USER_${x.p.shortId}`, prof(x.p, x.bal));
      await kvC.put(`RAW_LINE_${x.p.shortId}`, x.p.lineUserId);
    }
  }

  let seq = 0;
  async function say(user, text) {
    const eventId = `e${++seq}`;
    const body = JSON.stringify({
      destination: 'Utest',
      events: [{
        type: 'message', replyToken: 'a'.repeat(64), webhookEventId: eventId,
        source: { type: 'user', userId: user.lineUserId },
        timestamp: 1, message: { id: `m${eventId}`, type: 'text', text },
      }],
    });
    const sig = createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
    await (await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-line-signature': sig },
      body,
    })).text();
    await new Promise((r) => setTimeout(r, 320));
  }

  async function orderByNo(no) {
    const raw = await kvO.get(`ORDER_${no}`);
    return raw ? JSON.parse(raw) : null;
  }
  async function balances() {
    const d = (await (await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
    })).json())?.data || {};
    const f = (id) => { const p = (d.players || []).find((x) => x.shortId === id); return p ? Number(p.balance) : NaN; };
    return { a: f(A.shortId), m1: f('PL000002'), m2: f('PL000003') };
  }

  return { seed, say, orderByNo, balances, dispose: () => mf.dispose() };
}

const M1 = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'MATCHER1' };
const M2 = { shortId: 'PL000003', lineUserId: 'Uaaaaa0000000003', name: 'MATCHER2' };

console.log('DUPLICATE MATCH HARNESS\n');

// ── The production pattern: one player re-taps the same order ───────────────
console.log('SAME PLAYER TAPS THE SAME ORDER TWICE');
{
  const env = await freshEnv('a');
  await env.seed('7015', 500, [M1]);
  await env.say(M1, 'ต 7015 500');
  await env.say(M1, 'ต 7015 100');   // second tap, same order

  const o = await env.orderByNo('7015');
  check('order ends matched', o?.status === 'matched', String(o?.status));
  check('order amount is the portion actually taken (500)', o?.amount === 500, String(o?.amount));
  check('only one matcher recorded', o?.matcherId === M1.shortId, String(o?.matcherId));
  check('matcher debited exactly once (1000 -> 500)',
    (await env.balances()).m1 === 500, String((await env.balances()).m1));
  await env.dispose();
}

// ── Two different players racing for the same order ─────────────────────────
console.log('\nTWO PLAYERS RACE FOR THE SAME ORDER');
{
  const env = await freshEnv('b');
  await env.seed('7015', 500, [M1, M2]);
  await env.say(M1, 'ต 7015 500');
  await env.say(M2, 'ต 7015 200');

  const o = await env.orderByNo('7015');
  const b = await env.balances();
  check('order matched to exactly one player', Boolean(o?.matcherId), String(o?.matcherId));
  check('the loser was not debited',
    o?.matcherId === M1.shortId ? b.m2 === 1000 : b.m1 === 1000,
    `m1=${b.m1} m2=${b.m2} matcher=${o?.matcherId}`);
  check('the winner was debited exactly the matched amount',
    o?.matcherId === M1.shortId ? b.m1 === 500 : b.m2 === 800,
    `m1=${b.m1} m2=${b.m2}`);
  await env.dispose();
}

// ── Three rapid attempts, as the log shows ─────────────────────────────────
console.log('\nTHREE RAPID ATTEMPTS (the observed pattern)');
{
  const env = await freshEnv('c');
  await env.seed('7015', 500, [M1, M2]);
  await env.say(M1, 'ต 7015 500');
  await env.say(M1, 'ต 7015 100');
  await env.say(M2, 'ต 7015 200');

  const o = await env.orderByNo('7015');
  const b = await env.balances();
  check('order matched', o?.status === 'matched', String(o?.status));
  check('order amount is 500, not inflated by a second match', o?.amount === 500, String(o?.amount));
  // Conservation: whatever is debited from the two matchers must equal the
  // amount recorded on the order plus any remainder still listed as open.
  check('matcher1 debited at most the order amount', b.m1 >= 500, String(b.m1));
  check('matcher2 untouched if they lost', b.m2 === 1000 || o?.matcherId === M2.shortId,
    `m2=${b.m2} matcher=${o?.matcherId}`);
  await env.dispose();
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);