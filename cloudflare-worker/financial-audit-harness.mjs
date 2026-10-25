import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = mkdtempSync(join(tmpdir(), 'financial-audit-'));
const shimPath = join(outDir, 'cf-workers-shim.mjs');
const bundlePath = join(outDir, 'worker-bundle.mjs');

writeFileSync(
  shimPath,
  `export class DurableObject {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  }\n`
);

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['worker', 'browser'],
  alias: {
    'cloudflare:workers': shimPath,
  },
  outfile: bundlePath,
  logLevel: 'error',
});

const mod = await import(pathToFileURL(bundlePath).href);
const worker = mod.default;
const RocketStateDO = mod.RocketStateDO;

class MockKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value) {
    this.store.set(key, String(value));
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list(opts = {}) {
    const prefix = opts.prefix || '';
    const keys = [];
    for (const k of this.store.keys()) {
      if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
    }
    return { keys, list_complete: true };
  }
}

function makeFakeDONamespace(kvCache, opts = { failAfterCalls: Infinity }) {
  let instance = null;
  let callCount = 0;

  function ensureInstance() {
    if (!instance) {
      const sqlRows = new Map();
      const metaRows = new Map();
      const fakeCtx = {
        storage: {
          sql: {
            databaseSize: 4096,
            exec(query, ...params) {
              const q = query.trim();
              if (q.startsWith('SELECT k, v, exp FROM state')) {
                return { toArray: () => Array.from(sqlRows.values()) };
              }
              if (q.startsWith("SELECT v FROM meta WHERE k = 'bootstrapped'")) {
                const v = metaRows.get('bootstrapped');
                return { toArray: () => (v ? [{ v }] : []) };
              }
              if (q.startsWith('INSERT INTO state')) {
                const [k, v, exp = 0] = params;
                sqlRows.set(k, { k, v, exp: Number(exp) || 0 });
                return { toArray: () => [] };
              }
              if (q.startsWith('DELETE FROM state WHERE k = ?')) {
                sqlRows.delete(params[0]);
                return { toArray: () => [] };
              }
              if (q.startsWith('DELETE FROM state;')) {
                sqlRows.clear();
                return { toArray: () => [] };
              }
              if (q.startsWith("INSERT INTO meta (k, v) VALUES ('bootstrapped'")) {
                metaRows.set('bootstrapped', params[0]);
                return { toArray: () => [] };
              }
              return { toArray: () => [] };
            },
          },
          setAlarm() {},
        },
        waitUntil() {},
      };
      instance = new RocketStateDO(fakeCtx, { KV_CACHE: kvCache });
    }
    return instance;
  }

  function makeProxy() {
    const doObj = ensureInstance();
    return new Proxy(doObj, {
      get(target, prop) {
        const val = target[prop];
        if (typeof val !== 'function') return val;
        return async (...args) => {
          callCount++;
          if (callCount > opts.failAfterCalls) {
            throw new Error('Durable Object exceeded Free Tier daily quota limit');
          }
          return val.apply(target, args);
        };
      },
    });
  }

  return {
    idFromName(name) {
      return name;
    },
    get() {
      return makeProxy();
    },
    getByName() {
      return makeProxy();
    },
    setFailAfterCalls(n) {
      opts.failAfterCalls = n;
    },
    getCallCount() {
      return callCount;
    },
  };
}

function makeEnv(doOpts = { failAfterCalls: Infinity }) {
  const kvCache = new MockKV();
  const kvOrders = new MockKV();
  const doNs = makeFakeDONamespace(kvCache, doOpts);
  return {
    KV_CACHE: kvCache,
    KV_ORDERS: kvOrders,
    ROCKET_STATE: doNs,
    ADMIN_API_KEY: 'test-admin-key',
    SESSION_SECRET: 'test-session-secret-32-chars-minimum!!',
    LINE_CHANNEL_ACCESS_TOKEN: 'mock-line-token',
    LINE_CHANNEL_SECRET: 'mock-line-secret',
  };
}

function makeCtx() {
  const tasks = [];
  return {
    tasks,
    waitUntil(p) {
      tasks.push(Promise.resolve(p));
    },
    async flush() {
      // Wait multiple ticks until no new nested waitUntil tasks are queued
      for (let i = 0; i < 10; i++) {
        if (tasks.length === 0) break;
        const batch = tasks.splice(0, tasks.length);
        await Promise.all(batch);
      }
    },
  };
}

async function rpc(env, ctx, functionName, args = []) {
  const req = new Request('https://worker.test/api/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': env.ADMIN_API_KEY,
    },
    body: JSON.stringify({ functionName, args, apiKey: env.ADMIN_API_KEY }),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.flush();
  const json = await res.json();
  return json.data !== undefined ? json.data : json;
}

async function sendGroupLineEvent(env, ctx, userId, text, groupId = 'C0123456789abcdef0123456789abcdef') {
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        timestamp: Date.now(),
        webhookEventId: crypto.randomUUID(),
        replyToken: `reply_${Date.now()}_${Math.random()}`,
        source: { type: 'group', groupId, userId },
        message: { id: `msg_${Date.now()}_${Math.random()}`, type: 'text', text },
      },
    ],
  });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.LINE_CHANNEL_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sig = Buffer.from(sigBuf).toString('base64');

  const req = new Request('https://worker.test/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-line-signature': sig,
    },
    body,
  });
  await worker.fetch(req, env, ctx);
  await ctx.flush();
}

// Intercept outbound LINE HTTP calls so tests run offline & capture Flex messages
const sentLinePayloads = [];
globalThis.fetch = async (url, init) => {
  const urlStr = String(url);
  if (urlStr.includes('api.line.me/v2/bot/profile/')) {
    const uid = urlStr.split('/').pop();
    const names = {
      Ua34bcbb1d365c657cc1a7f3576c76e26: 'ITT (อิท)',
      U66afe0312134b3910a7e21e96d214a1e: 'A-K',
      U11111111111111111111111111111111: 'PlayerThree',
    };
    return new Response(JSON.stringify({ displayName: names[uid] || `User_${uid.slice(-4)}` }), { status: 200 });
  }
  if (urlStr.includes('api.line.me/v2/bot/message/')) {
    if (init?.body) {
      try {
        sentLinePayloads.push(JSON.parse(init.body));
      } catch (_) {}
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

const ITT_ID = 'Ua34bcbb1d365c657cc1a7f3576c76e26'; // PLC76E26
const AK_ID = 'U66afe0312134b3910a7e21e96d214a1e';  // PL214A1E
const P3_ID = 'U11111111111111111111111111111111';  // PL111111
const TEST_GROUP_ID = 'C0123456789abcdef0123456789abcdef';

async function getPlayerBalances(env, ctx) {
  const dash = await rpc(env, ctx, 'getDashboardData', ['full']);
  const map = {};
  for (const p of dash.players || []) {
    map[p.shortId] = p.balance;
  }
  return map;
}

console.log('================================================================');
console.log('🛡️  BANG FAI COMMANDER — REAL-MONEY FINANCIAL AUDIT SUITE');
console.log('================================================================\n');

try {
  // ---------------------------------------------------------------------------
  // TEST 1: Exact Reproduction of Production Scenario (18:22–19:21 ICT Round)
  //         INCLUDING Simulated Durable Object Quota Trip Mid-Round!
  // ---------------------------------------------------------------------------
  {
    console.log('▶ TEST 1: Exact Production Scenario (ITT vs A-K: #1 Pre-Quote 500, #2 Pre-Quote 200, #3 Custom Range 250-300 Partial 240/300) + DO Outage Mid-Round');
    sentLinePayloads.length = 0;
    const env = makeEnv({ failAfterCalls: Infinity });
    const ctx = makeCtx();

    await env.KV_CACHE.put('ACTIVE_GROUP_ID', TEST_GROUP_ID);
    await rpc(env, ctx, 'adminOpenRound', ['บั้งไฟสด 123', 400, 450]);

    // 1. Admin sets both players to 1,000 pt
    await rpc(env, ctx, 'adminSetPlayerBalance', [ITT_ID, 1000, 'ITT (อิท)']);
    await rpc(env, ctx, 'adminSetPlayerBalance', [AK_ID, 1000, 'A-K']);

    let bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 1000, 'ITT initial balance should be 1000');
    assert.equal(bals.PL214A1E, 1000, 'A-K initial balance should be 1000');

    // 2. Order 1: ITT opens ชล500 (pre_quote, high, 500 pt), A-K matches 500 pt
    await sendGroupLineEvent(env, ctx, ITT_ID, 'ชล500');
    let dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const order1 = dash.bets.find((b) => b.amount === 500 && b.status === 'pending_hold');
    assert.ok(order1, 'Order 1 (500pt pre_quote) should be created');

    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 500, 'ITT balance after opening 500pt order should be 500');

    await sendGroupLineEvent(env, ctx, AK_ID, `ต #${order1.orderNumber}`);
    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PL214A1E, 500, 'A-K balance after matching 500pt order should be 500');

    // 3. Order 2: A-K opens ชล200 (pre_quote, high, 200 pt), ITT matches 200 pt
    await sendGroupLineEvent(env, ctx, AK_ID, 'ชล200');
    dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const order2 = dash.bets.find((b) => b.amount === 200 && b.status === 'pending_hold');
    assert.ok(order2, 'Order 2 (200pt pre_quote) should be created');

    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PL214A1E, 300, 'A-K balance after opening 200pt order should be 300');

    await sendGroupLineEvent(env, ctx, ITT_ID, `ต #${order2.orderNumber}`);
    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 300, 'ITT balance after matching 200pt order should be 300');

    // 4. Order 3: ITT opens 250-300ถ300 (custom_range 250-300, low, 300 pt)
    await sendGroupLineEvent(env, ctx, ITT_ID, '250-300ถ300');
    dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const order3 = dash.bets.find((b) => b.amount === 300 && b.status === 'pending_match');
    assert.ok(order3, 'Order 3 (300pt custom_range 250-300) should be created');

    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 0, 'ITT balance after opening 300pt order should be 0');

    // 5. Simulate the Durable Object hitting its quota right before the partial match.
    //    Money operations FAIL CLOSED: the match is refused and nothing moves.
    //    (A KV fallback cannot check-and-debit atomically — that is how stakes
    //    were lost and refunds doubled under burst traffic.)
    env.ROCKET_STATE.setFailAfterCalls(0);
    await sendGroupLineEvent(env, ctx, AK_ID, `ต #${order3.orderNumber} 240`);
    env.ROCKET_STATE.setFailAfterCalls(Infinity);
    // StateStore keeps its circuit open for 15s after a quota error; step past it.
    const realNow = Date.now;
    Date.now = () => realNow() + 16_000;
    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 0, 'ITT balance must be unchanged while the ledger is unavailable');
    assert.equal(bals.PL214A1E, 300, 'A-K must not be debited while the ledger is unavailable');

    // Once the Durable Object is back, the same partial match succeeds exactly once:
    // A-K takes 240 pt (80% of 300 pt); the untaken 60 pt is refunded to ITT.
    await sendGroupLineEvent(env, ctx, AK_ID, `ต #${order3.orderNumber} 240`);
    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 60, 'ITT balance after 60pt partial-match remainder refund must be 60');
    assert.equal(bals.PL214A1E, 60, 'A-K balance after taking 240pt partial match must be 60');

    // 6. Admin releases official quote 400-450s for บั้งไฟสด 123
    await rpc(env, ctx, 'adminBroadcastQuote', ['ALL', 'บั้งไฟสด 123', 400, 450, false]);

    // Verify unified green แมตช์สำเร็จ card style and strict DM-only routing (never sent to LINE Group)
    const allFlexJson = JSON.stringify(sentLinePayloads);
    assert.ok(allFlexJson.includes(`🤝 แมตช์สำเร็จ! #${order1.orderNumber}`), 'Unified green แมตช์สำเร็จ title must appear for Order 1');
    assert.ok(!allFlexJson.includes('รับแผลล่วงหน้า'), 'Confusing orange รับแผลล่วงหน้า card must NOT appear');
    assert.ok(!allFlexJson.includes('ยืนยันแผลดวล'), 'Old verbose pre-quote confirmation title must NOT appear');
    const groupMatchSends = sentLinePayloads.filter(
      (p) => p.body?.to === TEST_GROUP_ID && JSON.stringify(p.body).includes('แมตช์สำเร็จ')
    );
    assert.equal(groupMatchSends.length, 0, 'Match confirmation cards must NEVER be sent to the LINE Group');

    // 7. Admin settles round at finalTime = 320s (quote band 400-450s)
    //    - Order 1 (400-450s, 500pt, ITT=HIGH, A-K=LOW): 320 < 400 -> LOW (A-K) wins 950pt (comm 50)
    //    - Order 2 (400-450s, 200pt, A-K=HIGH, ITT=LOW): 320 < 400 -> LOW (ITT) wins 380pt (comm 20)
    //    - Order 3 (250-300s, 240pt, ITT=LOW, A-K=HIGH): 320 > 300 -> HIGH (A-K) wins 456pt (comm 24)
    const settleRes = await rpc(env, ctx, 'adminResolveBets', [320, 400, 450]);
    assert.equal(settleRes.success, true);
    assert.equal(settleRes.resolvedCount, 3, 'All 3 matched orders must be settled');

    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 440, `ITT final balance must be 440 pt (60 + 380), got ${bals.PLC76E26}`);
    assert.equal(bals.PL214A1E, 1466, `A-K final balance must be 1466 pt (60 + 950 + 456), got ${bals.PL214A1E}`);

    // Verify strict conservation of money:
    // Initial pool (2,000) == ITT (440) + A-K (1,466) + Total Commission (50 + 20 + 24 = 94)
    const p2pRes = await rpc(env, ctx, 'getP2PResults', []);
    const totalComm = p2pRes.p2pResults.reduce((s, r) => s + r.commission, 0);
    assert.equal(totalComm, 94, 'Total platform 10% commission must be 94 pt');
    assert.equal(bals.PLC76E26 + bals.PL214A1E + totalComm, 2000, 'Conservation of money: 440 + 1466 + 94 === 2000');

    // Verify P2P winnerName !== loserName on every single settled order
    for (const row of p2pRes.p2pResults) {
      assert.notEqual(row.winnerName, row.loserName, `Order #${row.orderNumber} winnerName (${row.winnerName}) must not equal loserName (${row.loserName})`);
    }

    console.log('  ✅ PASS: ITT = 440 pt, A-K = 1,466 pt, Commission = 94 pt (Total = 2,000 pt, 0 discrepancy)\n');
    Date.now = realNow;
  }

  // ---------------------------------------------------------------------------
  // TEST 2: In-Range Draw Settlement (0% Commission, 100% Stake Refund to Both)
  // ---------------------------------------------------------------------------
  {
    console.log('▶ TEST 2: In-Range Draw Settlement (Boundary & Mid-Range)');
    const env = makeEnv();
    const ctx = makeCtx();
    await env.KV_CACHE.put('ACTIVE_GROUP_ID', TEST_GROUP_ID);
    await rpc(env, ctx, 'adminOpenRound', ['บั้งไฟเสมอ', 300, 350]);
    await rpc(env, ctx, 'adminSetPlayerBalance', [ITT_ID, 1000, 'ITT (อิท)']);
    await rpc(env, ctx, 'adminSetPlayerBalance', [AK_ID, 1000, 'A-K']);

    // Release quote 300-350
    await rpc(env, ctx, 'adminBroadcastQuote', ['ALL', 'บั้งไฟเสมอ', 300, 350, false]);

    // ITT opens 500pt low (300-350), A-K matches
    await sendGroupLineEvent(env, ctx, ITT_ID, 'ชถ500');
    const dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const ord = dash.bets.find((b) => b.amount === 500);
    await sendGroupLineEvent(env, ctx, AK_ID, `ต #${ord.orderNumber}`);

    let bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 500);
    assert.equal(bals.PL214A1E, 500);

    // Settle at 325s (inside 300-350s) -> DRAW! Both must get 500pt back -> 1,000 pt each
    await rpc(env, ctx, 'adminResolveBets', [325, 300, 350]);
    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 1000, 'ITT must be refunded full 500pt on draw -> 1000');
    assert.equal(bals.PL214A1E, 1000, 'A-K must be refunded full 500pt on draw -> 1000');
    console.log('  ✅ PASS: In-range draw refunds 100% to both sides with 0 commission\n');
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Unquoted Pre-Quote Auto-Cancel on Settlement vs Custom Range Survival
  // ---------------------------------------------------------------------------
  {
    console.log('▶ TEST 3: Unquoted Matched Pre-Quote Auto-Refund vs Self-Quoted Custom Range Settlement');
    const env = makeEnv();
    const ctx = makeCtx();
    await env.KV_CACHE.put('ACTIVE_GROUP_ID', TEST_GROUP_ID);
    await rpc(env, ctx, 'adminOpenRound', ['บั้งไฟไม่มีราคาช่าง', 330, 380]);
    await rpc(env, ctx, 'adminSetPlayerBalance', [ITT_ID, 1000, 'ITT (อิท)']);
    await rpc(env, ctx, 'adminSetPlayerBalance', [AK_ID, 1000, 'A-K']);

    // 1. Pre-quote order (matched, but Admin NEVER sends quote)
    await sendGroupLineEvent(env, ctx, ITT_ID, 'ชล400');
    let dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const pqOrder = dash.bets.find((b) => b.amount === 400);
    await sendGroupLineEvent(env, ctx, AK_ID, `ต #${pqOrder.orderNumber}`);

    // 2. Custom range order 300-340ถ200 (matched, valid without admin quote)
    await sendGroupLineEvent(env, ctx, ITT_ID, '300-340ถ200');
    dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const crOrder = dash.bets.find((b) => b.amount === 200 && b.status === 'pending_match');
    await sendGroupLineEvent(env, ctx, AK_ID, `ต #${crOrder.orderNumber}`);

    let bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 400, 'ITT should have 400 left after 400+200 bets');
    assert.equal(bals.PL214A1E, 400, 'A-K should have 400 left after 400+200 matches');

    // Settle at 280s without ever releasing admin quote:
    // - pqOrder (400pt) must be cancelled & refunded (+400 to ITT, +400 to A-K)
    // - crOrder (200pt, 300-340s, ITT=LOW): 280 < 300 -> ITT wins 380pt!
    await rpc(env, ctx, 'adminResolveBets', [280, 330, 380]);
    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 400 + 400 + 380, 'ITT should get 400 refund + 380 payout = 1180');
    assert.equal(bals.PL214A1E, 400 + 400, 'A-K should get 400 refund = 800');
    assert.equal(bals.PLC76E26 + bals.PL214A1E + 20, 2000, 'Conservation of money holds (1180 + 800 + 20 = 2000)');
    console.log('  ✅ PASS: Unquoted pre-quote refunded 100%, custom range settled accurately\n');
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Double-Cancel & Double-Match Race Protection (KV Fallback Mode)
  // ---------------------------------------------------------------------------
  {
    console.log('▶ TEST 4: Idempotent Refund & Exclusive Match Protection, and Fail-Closed under DO Outage');
    const env = makeEnv();
    const ctx = makeCtx();
    await env.KV_CACHE.put('ACTIVE_GROUP_ID', TEST_GROUP_ID);
    await rpc(env, ctx, 'adminOpenRound', ['บั้งไฟทดสอบ Race', 330, 380]);
    await rpc(env, ctx, 'adminSetPlayerBalance', [ITT_ID, 1000, 'ITT (อิท)']);
    await rpc(env, ctx, 'adminSetPlayerBalance', [AK_ID, 1000, 'A-K']);
    await rpc(env, ctx, 'adminSetPlayerBalance', [P3_ID, 1000, 'PlayerThree']);

    // ITT opens 300-350ล500
    await sendGroupLineEvent(env, ctx, ITT_ID, '300-350ล500');
    const dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const ord = dash.bets.find((b) => b.amount === 500);

    // Player cancels AND Admin cancels AND the board is cleared, all for the same order
    await Promise.all([
      sendGroupLineEvent(env, ctx, ITT_ID, `ยกเลิก ${ord.orderNumber}`),
      rpc(env, ctx, 'adminRequestCancelBet', [ord.orderNumber]),
      rpc(env, ctx, 'clearPendingBets', []),
    ]);

    let bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 1000, `ITT must be refunded exactly once (1000), got ${bals.PLC76E26}`);

    // Now ITT opens another 500pt order, and A-K + PlayerThree both try to match it
    await sendGroupLineEvent(env, ctx, ITT_ID, '300-350ล500');
    const dash2 = await rpc(env, ctx, 'getDashboardData', ['full']);
    const ord2 = dash2.bets.find((b) => b.amount === 500 && b.status === 'pending_match');

    await Promise.all([
      sendGroupLineEvent(env, ctx, AK_ID, `ต #${ord2.orderNumber}`),
      sendGroupLineEvent(env, ctx, P3_ID, `ต #${ord2.orderNumber}`),
    ]);

    bals = await getPlayerBalances(env, ctx);
    // Exactly one of A-K or PlayerThree should be deducted 500; the other stays at 1000
    const matcherBals = [bals.PL214A1E, bals.PL111111].sort((a, b) => a - b);
    assert.deepEqual(matcherBals, [500, 1000], `Exactly one matcher must take the order, got ${matcherBals}`);

    // DO outage: a new bet is refused outright and no credit moves.
    const before = await getPlayerBalances(env, ctx);
    env.ROCKET_STATE.setFailAfterCalls(0);
    await sendGroupLineEvent(env, ctx, AK_ID, 'ชล100');
    env.ROCKET_STATE.setFailAfterCalls(Infinity);
    const realNow = Date.now;
    Date.now = () => realNow() + 16_000;
    const after = await getPlayerBalances(env, ctx);
    Date.now = realNow;
    assert.deepEqual(after, before, 'No balance may change while the ledger is unavailable');
    console.log('  ✅ PASS: Zero double-refunds, zero double-matches, and no money moves during a DO outage\n');
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Concurrent Rocket A (In-Flight) + Rocket B Isolation & Independent Settlement
  // ---------------------------------------------------------------------------
  {
    console.log('▶ TEST 5: Concurrent Rocket A (In-Flight) & Rocket B Independent Settlement');
    const env = makeEnv();
    const ctx = makeCtx();
    await env.KV_CACHE.put('ACTIVE_GROUP_ID', TEST_GROUP_ID);
    await rpc(env, ctx, 'adminOpenRound', ['บั้งไฟ A', 300, 350]);
    await rpc(env, ctx, 'adminSetPlayerBalance', [ITT_ID, 1000, 'ITT (อิท)']);
    await rpc(env, ctx, 'adminSetPlayerBalance', [AK_ID, 1000, 'A-K']);

    // Rocket A: quote 300-350, ITT bets 400 HIGH, A-K matches LOW
    await rpc(env, ctx, 'adminBroadcastQuote', ['ALL', 'บั้งไฟ A', 300, 350, false]);
    await sendGroupLineEvent(env, ctx, ITT_ID, 'ชล400');
    let dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const ordA = dash.bets.find((b) => b.amount === 400);
    await sendGroupLineEvent(env, ctx, AK_ID, `ต #${ordA.orderNumber}`);

    // Launch Rocket A & Open Rocket B (quote 400-450) while Rocket A is in the air
    const openNextRes = await rpc(env, ctx, 'adminOpenNextRocket', ['ALL', 'บั้งไฟ B', 'quote', 400, 450, false, true]);
    assert.equal(openNextRes.success, true);
    assert.equal(openNextRes.inFlightRounds.length, 1);

    // Rocket B: ITT bets 300 LOW, A-K matches HIGH
    await sendGroupLineEvent(env, ctx, ITT_ID, 'ชถ300');
    dash = await rpc(env, ctx, 'getDashboardData', ['full']);
    const ordB = dash.bets.find((b) => b.amount === 300 && b.status === 'pending_match');
    await sendGroupLineEvent(env, ctx, AK_ID, `ต #${ordB.orderNumber}`);

    let bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 300, 'ITT should have 300 left after 400 (Rocket A) + 300 (Rocket B)');
    assert.equal(bals.PL214A1E, 300, 'A-K should have 300 left after 400 (Rocket A) + 300 (Rocket B)');

    // Settle Rocket A (in-flight) at 370s (> 350 -> HIGH wins -> ITT wins 760pt, comm 40)
    const roundAId = openNextRes.inFlightRounds[0].roundId;
    await rpc(env, ctx, 'adminResolveInFlightRound', [roundAId, 370]);

    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 300 + 760, 'ITT balance after winning Rocket A should be 1060');
    assert.equal(bals.PL214A1E, 300, 'A-K balance should remain 300 while Rocket B is still active');

    // Settle Rocket B (active) at 420s (inside 400-450 -> DRAW -> both get 300pt back)
    await rpc(env, ctx, 'adminResolveBets', [420, 400, 450]);
    bals = await getPlayerBalances(env, ctx);
    assert.equal(bals.PLC76E26, 1360, 'ITT final balance after Rocket B draw refund should be 1360');
    assert.equal(bals.PL214A1E, 600, 'A-K final balance after Rocket B draw refund should be 600');
    assert.equal(bals.PLC76E26 + bals.PL214A1E + 40, 2000, 'Conservation of money across concurrent rockets holds (1360 + 600 + 40 = 2000)');
    console.log('  ✅ PASS: Concurrent Rocket A & Rocket B settle independently with 100% accounting accuracy\n');
  }

  console.log('================================================================');
  console.log('🎉 ALL 5 REAL-MONEY FINANCIAL AUDIT SUITES PASSED 100%!');
  console.log('================================================================');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
