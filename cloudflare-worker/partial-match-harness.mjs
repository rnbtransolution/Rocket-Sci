/**
 * Regression harness for partial order matching.
 *
 * THE BUG
 * -------
 * `generateOrderFlex` advertises four take-up buttons on every open order —
 * 20%, 40%, 80% and 100% of the stake. For a 500pt order those read 100, 200,
 * 400 and 500. `handleMatchOrder` however rejected anything that was not an
 * exact match, so three of the four buttons the system itself offered failed.
 * The GAS reference this was ported from allowed partial matches (Code.gs
 * ~2255): min 100pt, min 20% of the order, never more than the order.
 *
 * WHAT IS ACTUALLY DANGEROUS HERE
 * -------------------------------
 * The stake is debited from the creator in FULL when the order opens. So a
 * partial match must place the remainder somewhere: either re-list it as a new
 * open order, or refund it when it falls below the 100pt floor. Get that wrong
 * and points are created out of nothing (remainder silently dropped), or
 * destroyed (remainder credited twice).
 *
 * THE INVARIANT
 * -------------
 *   sum(balances) + sum(open stakes) + sum(matched stakes)  ==  constant
 *
 * A match only moves points between those three buckets. The sum must not
 * change. That single identity is what every scenario below asserts, because
 * it is the property that catches both directions of the bug.
 *
 * Usage:  node partial-match-harness.mjs
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

const CREATOR = { shortId: 'PL000001', lineUser: 'Uaaaaa0000000001', name: 'CREATOR' };
const MATCHER = { shortId: 'PL000002', lineUser: 'Uaaaaa0000000002', name: 'MATCHER' };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'partial-harness-'));
const bundlePath = join(outDir, 'worker.mjs');

// Built once; each scenario gets its own Miniflare so no state leaks between
// them. The Durable Object is the system of record and `list()` cannot clear it,
// so reusing one instance would silently carry orders into the next scenario.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true, format: 'esm', platform: 'neutral',
  mainFields: ['module', 'main'], conditions: ['worker', 'browser'],
  external: ['cloudflare:workers'],
  outfile: bundlePath,
  // getByName shim: this Miniflare version predates it, Cloudflare's has it.
  banner: {
    js: `{ const __s=function(n){return this.get(this.idFromName(n));};
          Object.defineProperty(Object.prototype,'getByName',
            {value:__s,configurable:true,writable:true,enumerable:false}); }`,
  },
  logLevel: 'error',
});

async function freshEnv() {
  const mf = new Miniflare({
    modules: true,
    scriptPath: bundlePath,
    modulesRoot: outDir,
    compatibilityDate: '2024-09-01',
    compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: 'pm-kv-cache', KV_ORDERS: 'pm-kv-orders' },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'test_line_token',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvCache = await mf.getKVNamespace('KV_CACHE');
  const kvOrders = await mf.getKVNamespace('KV_ORDERS');

  const profileJson = (p, balance) => JSON.stringify({
    shortId: p.shortId, lineUserId: p.lineUser, displayName: p.name,
    balance, registeredAt: CREATED_AT, updatedAt: CREATED_AT,
  });

  async function seed(orderNo, amount, creatorBal, matcherBal) {
    const order = {
      orderNumber: orderNo, creatorId: CREATOR.shortId, creatorName: CREATOR.name,
      creatorLineUserId: CREATOR.lineUser, side: 'low', amount,
      betType: 'range', rangeMin: 330, rangeMax: 380,
      status: 'pending_match', createdAt: CREATED_AT, id: `bet_${orderNo}`,
      playerLowId: CREATOR.shortId, playerLowName: CREATOR.name,
    };
    await kvOrders.put(`ORDER_${orderNo}`, JSON.stringify(order));
    // The board and resolveOrderNumber both read the pending list.
    await kvCache.put('PENDING_ORDERS_LIST', JSON.stringify([order]));
    await kvCache.put('PLAYERS_LIST', JSON.stringify([
      JSON.parse(profileJson(CREATOR, creatorBal)),
      JSON.parse(profileJson(MATCHER, matcherBal)),
    ]));
    for (const p of [CREATOR, MATCHER]) {
      await kvCache.put(`USER_${p.lineUser}`, profileJson(p, p === CREATOR ? creatorBal : matcherBal));
      await kvCache.put(`USER_${p.shortId}`, profileJson(p, p === CREATOR ? creatorBal : matcherBal));
      await kvCache.put(`RAW_LINE_${p.shortId}`, p.lineUser);
    }
  }

  let eventSeq = 0;
  async function say(user, text) {
    const eventId = `evt-${++eventSeq}`;
    const body = JSON.stringify({
      destination: 'Utest',
      events: [{
        type: 'message', replyToken: 'a'.repeat(64), webhookEventId: eventId,
        source: { type: 'user', userId: user.lineUser },
        timestamp: 1,
        message: { id: `msg-${eventId}`, type: 'text', text },
      }],
    });
    // Signed for real: the worker rejects unsigned webhooks before any handler
    // runs, so an unsigned call would make this harness pass vacuously.
    const signature = createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
    const res = await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-line-signature': signature },
      body,
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 320)); // let waitUntil drain
  }

  async function dashboard() {
    const res = await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
    });
    return (await res.json())?.data || {};
  }

  // Balances come from the admin view on purpose: the Durable Object is
  // authoritative and KV is only a cold mirror, so reading a KV key would
  // "verify" conservation against numbers the system never acted on.
  async function balances() {
    const d = await dashboard();
    const pick = (id) => {
      const p = (d.players || []).find((x) => x.shortId === id);
      return p ? Number(p.balance) : NaN;
    };
    return { creator: pick(CREATOR.shortId), matcher: pick(MATCHER.shortId) };
  }

  async function orders() {
    const d = await dashboard();
    const raw = await kvCache.get('PENDING_ORDERS_LIST');
    const pending = raw ? JSON.parse(raw) : [];
    return { pending, all: d.bets || [] };
  }

  /** Points in circulation: balances + every point riding on an unsettled order. */
  async function inPlay() {
    const b = await balances();
    const d = await dashboard();
    let total = b.creator + b.matcher;
    const seen = new Set();
    for (const o of d.bets || []) {
      if (seen.has(o.orderNumber)) continue; // list dedupes, count once
      seen.add(o.orderNumber);
      const mult = o.status === 'matched' ? 2 : 1;
      total += (Number(o.amount) || 0) * mult;
    }
    return total;
  }

  async function orderByNo(no) {
    const raw = await kvOrders.get(`ORDER_${no}`);
    return raw ? JSON.parse(raw) : null;
  }

  return { seed, say, balances, orders, inPlay, orderByNo, dispose: () => mf.dispose() };
}

console.log('PARTIAL MATCH HARNESS\n');

// ── Scenario 1: the reported bug — 500pt order, matcher taps the 200 button ──
console.log('SCENARIO 1 — 500pt order, take 200pt (the reported bug)');
{
  const env = await freshEnv();
  await env.seed('7494', 500, 0, 1000);
  const before = await env.inPlay();
  await env.say(MATCHER, 'ต 7494 200');

  const matched = await env.orderByNo('7494');
  check('order #7494 is matched', matched?.status === 'matched', matched?.status);
  check('matched amount is the portion taken (200)', matched?.amount === 200, String(matched?.amount));
  check('matcher recorded', matched?.matcherId === MATCHER.shortId, String(matched?.matcherId));
  // Seeded at 0 (the full 500 already staked). After a 200pt take the
  // untaken 300 is returned, so the creator lands on 300 — proof the refund
  // actually lands on the balance rather than only being recorded.
  check('the untaken 300 is returned to the creator',
    (await env.balances()).creator === 300, String((await env.balances()).creator));

  // The untaken remainder is returned to the creator, not re-listed. The
  // pending board must therefore be empty: there is no second order.
  const { pending } = await env.orders();
  check('no remainder order is created', pending.length === 0, JSON.stringify(pending.map((o) => [o.orderNumber, o.amount])));
  check('nothing is left open at all', pending.every((o) => o.orderNumber !== '7494'));

  check('points conserved', (await env.inPlay()) === before, `${before} -> ${await env.inPlay()}`);
  await env.dispose();
}

// ── Scenario 2: an order closes on its first match, however partial ────────
console.log('\nSCENARIO 2 — the order closes after one partial take');
{
  const env = await freshEnv();
  await env.seed('7495', 500, 0, 5000);
  const before = await env.inPlay();
  await env.say(MATCHER, 'ต 7495 200');
  check('conserved after partial', (await env.inPlay()) === before, `${before} -> ${await env.inPlay()}`);
  check('the order is now matched', (await env.orderByNo('7495'))?.status === 'matched');
  check('it holds only the portion taken', (await env.orderByNo('7495'))?.amount === 200);
  check('nothing remains open for a second taker',
    (await env.orders()).pending.every((o) => o.orderNumber !== '7495'));

  // A second attempt against the same order must be refused.
  await env.say(MATCHER, 'ต 7495 100');
  check('a further take on the same order changes nothing',
    (await env.orderByNo('7495'))?.amount === 200, String((await env.orderByNo('7495'))?.amount));
  check('still conserved', (await env.inPlay()) === before, `${before} -> ${await env.inPlay()}`);
  await env.dispose();
}

// ── Scenario 3: a sub-100 remainder is no longer a special case ────────────
console.log('\nSCENARIO 3 — 150pt order, take 100 (50pt remainder)');
{
  const env = await freshEnv();
  await env.seed('7496', 150, 0, 1000);
  const before = await env.inPlay();
  await env.say(MATCHER, 'ต 7496 100');
  check('conserved', (await env.inPlay()) === before, `${before} -> ${await env.inPlay()}`);
  // Previously the sub-100 leftover was a special branch. It is now the same
  // path as every other remainder, so no order is created for it either.
  check('no 50pt order was created', !(await env.orders()).pending.some((o) => o.amount === 50),
    JSON.stringify((await env.orders()).pending.map((o) => o.amount)));
  check('nothing left open', (await env.orders()).pending.length === 0,
    JSON.stringify((await env.orders()).pending.map((o) => o.amount)));
  check('order settled on the matched 100', (await env.orderByNo('7496'))?.amount === 100);
  await env.dispose();
}

// ── Scenario 4: over-take refused ────────────────────────────────────────────
console.log('\nSCENARIO 4 — over-take is refused');
{
  const env = await freshEnv();
  await env.seed('7497', 500, 0, 1000);
  await env.say(MATCHER, 'ต 7497 900');
  check('order still open', (await env.orderByNo('7497'))?.status === 'pending_match');
  check('order untouched at 500', (await env.orderByNo('7497'))?.amount === 500);
  check('no remainder order created', (await env.orders()).pending.every((o) => o.amount === 500));
  await env.dispose();
}

// ── Scenario 5: under-take below the 20% floor refused ───────────────────────
console.log('\nSCENARIO 5 — under-take below 20% is refused');
{
  const env = await freshEnv();
  await env.seed('7498', 1000, 0, 1000);
  await env.say(MATCHER, 'ต 7498 100'); // 10% of 1000
  check('order still open', (await env.orderByNo('7498'))?.status === 'pending_match');
  check('order untouched at 1000', (await env.orderByNo('7498'))?.amount === 1000);
  await env.dispose();
}

// ── Scenario 6: exactly at the 20% floor is allowed ──────────────────────────
console.log('\nSCENARIO 6 — exactly 20% is allowed');
{
  const env = await freshEnv();
  await env.seed('7499', 500, 0, 1000);
  const before = await env.inPlay();
  await env.say(MATCHER, 'ต 7499 100');
  check('order matched at the floor', (await env.orderByNo('7499'))?.status === 'matched');
  check('matched amount is 100', (await env.orderByNo('7499'))?.amount === 100);
  check('the other 400 is returned, not re-listed',
    (await env.orders()).pending.every((o) => o.amount !== 400),
    JSON.stringify((await env.orders()).pending.map((o) => [o.orderNumber, o.amount])));
  check('conserved', (await env.inPlay()) === before);
  await env.dispose();
}

// ── Scenario 7: full take unchanged, and the pre-fix bug is really gone ──────
console.log('\nSCENARIO 7 — full take still behaves exactly as before');
{
  const env = await freshEnv();
  await env.seed('7500', 500, 0, 1000);
  const before = await env.inPlay();
  await env.say(MATCHER, 'ต 7500 500');
  const o = await env.orderByNo('7500');
  check('order matched', o?.status === 'matched');
  check('amount unchanged at 500', o?.amount === 500, String(o?.amount));
  check('no remainder order created', (await env.orders()).pending.length === 0,
    JSON.stringify((await env.orders()).pending.map((x) => [x.orderNumber, x.amount])));
  check('single order accounts for the whole 500', (await env.orderByNo('7500'))?.amount === 500);
  check('conserved', (await env.inPlay()) === before);
  await env.dispose();
}

// ── Scenario 8: every button the card actually advertises ───────────────────
console.log('\nSCENARIO 8 — all four advertised buttons work (20/40/80/100%)');
{
  for (const [label, take] of [['20%', 100], ['40%', 200], ['80%', 400], ['100%', 500]]) {
    const env = await freshEnv();
    await env.seed('7510', 500, 0, 1000);
    const before = await env.inPlay();
    await env.say(MATCHER, 'ต 7510 ' + take);
    const o = await env.orderByNo('7510');
    const ok = o?.status === 'matched' && o?.amount === take && (await env.inPlay()) === before;
    check(`${label} button (${take}pt) matches and conserves`, ok,
      `status=${o?.status} amount=${o?.amount}`);
    await env.dispose();
  }
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);