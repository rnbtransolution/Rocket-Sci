/**
 * Regression harness for the duplicate-refund bug.
 *
 * Runs the REAL worker (bundled from src/) inside a single in-process Miniflare,
 * so the KV namespaces and the Durable Object are the genuine articles.
 *
 * The bug being reproduced: an order's status lives in KV_ORDERS, which is
 * eventually consistent, and every cancellation path did its own
 * `read status -> refund`. So the Admin Console could cancel an order and refund
 * it, and the player could then cancel the SAME order moments later, still be
 * served the pre-cancel record, pass their own guard and be refunded again.
 *
 * Miniflare's KV is strongly consistent, so the stale read cannot happen on its
 * own. It is reproduced the honest way instead: after the admin cancels, the
 * order record is put BACK to `pending_match`. That is byte-for-byte what LINE's
 * region was serving, and it is the exact input the player's cancel handler
 * consumed in production. Everything downstream — the guard, the claim, the
 * credit — is the real code.
 *
 * Usage:  node refund-race-harness.mjs            # run against current src
 *         REFUND_FIX=off node refund-race-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const CHANNEL_SECRET = 'test_channel_secret';
const ADMIN_KEY = 'test_admin_key';
const LINE_USER = 'Uaaaaa0000000001';
const SHORT_ID = 'PL000001';
const ORDER_NO = '9999';
const CREATED_AT = 1750000000000;
const AMOUNT = 100;
const START_BALANCE = 900; // 1000 staked on this order

const outDir = mkdtempSync(join(tmpdir(), 'refund-harness-'));

async function bundle() {
  const outfile = join(outDir, 'worker.mjs');
  // Miniflare's DurableObjectNamespace in this version predates `getByName`,
  // which StateStore uses. Cloudflare's runtime has it (verified in production
  // via adminStateStats → usingDurableObject: true). The namespace object is
  // immutable, so the shim is injected into this throwaway test isolate only.
  const shim = `
{
  const __shim = function (name) { return this.get(this.idFromName(name)); };
  Object.defineProperty(Object.prototype, 'getByName', {
    value: __shim, configurable: true, writable: true, enumerable: false,
  });
}
${process.env.REFUND_FIX === 'off' ? `
{
  // REFUND_FIX=off — stand in for the pre-fix code, where the "has this already
  // been refunded?" decision was just a read of an eventually-consistent KV
  // record. Every caller believing it won is exactly the old behaviour.
  Object.defineProperty(Object.prototype, 'claimExclusive', {
    value: async function () { return true; }, configurable: true, writable: true, enumerable: false,
  });
}
` : ''}`;

  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['worker', 'browser'],
    external: ['cloudflare:workers'],
    outfile,
    banner: { js: shim },
    logLevel: 'error',
  });
  return outfile;
}

const mf = new Miniflare({
  modules: true,
  scriptPath: await bundle(),
  modulesRoot: outDir,
  compatibilityDate: '2024-09-01',
  compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'test-kv-cache', KV_ORDERS: 'test-kv-orders' },
  durableObjects: {
    ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true },
  },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY,
    SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: 'test_line_token',
    ADMIN_USERNAME: 'admin',
    ENVIRONMENT: 'test',
  },
});

const kvCache = await mf.getKVNamespace('KV_CACHE');
const kvOrders = await mf.getKVNamespace('KV_ORDERS');

// Miniflare's DurableObjectNamespace in this version predates `getByName`,
// which StateStore uses. Cloudflare's runtime has it (verified in production
// via adminStateStats → usingDurableObject: true); shim it so the harness
// exercises the real strongly-consistent store rather than the KV fallback.

const order = (status) => JSON.stringify({
  orderNumber: ORDER_NO,
  creatorId: SHORT_ID,
  creatorName: 'TEST PLAYER',
  creatorLineUserId: LINE_USER,
  side: 'low',
  amount: AMOUNT,
  betType: 'range',
  rangeMin: 330,
  rangeMax: 380,
  status,
  createdAt: CREATED_AT,
  id: `bet_${ORDER_NO}`,
  playerLowId: SHORT_ID,
  playerHighId: null,
});

const profile = JSON.stringify({
  shortId: SHORT_ID,
  lineUserId: LINE_USER,
  displayName: 'TEST PLAYER',
  balance: START_BALANCE,
  registeredAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

// ── Seed: one 100pt pending order, player balance 900 ────────────────────────
await kvOrders.put(`ORDER_${ORDER_NO}`, order('pending_match'));
await kvCache.put(`USER_${LINE_USER}`, profile);
await kvCache.put(`USER_${SHORT_ID}`, profile);
await kvCache.put(`RAW_LINE_${SHORT_ID}`, LINE_USER);
await kvCache.put('PLAYERS_LIST', JSON.stringify([JSON.parse(profile)]));
await kvCache.put('PENDING_ORDERS_LIST', JSON.stringify([JSON.parse(order('pending_match'))]));

/**
 * The balance as the ADMIN CONSOLE sees it.
 *
 * Probing through `getDashboardData` rather than a KV key is deliberate: it is
 * the number an operator actually looks at when a player disputes a balance,
 * and it stays correct whichever write path is active (the Durable Object is
 * authoritative; KV is only a cold mirror).
 */
const balance = async () => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
  });
  const json = await res.json();
  const player = (json?.data?.players || []).find((p) => p.shortId === SHORT_ID || p.id === SHORT_ID);
  return player ? Number(player.balance) : NaN;
};

const rpc = async (functionName, args = [], headers = {}) => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ functionName, args }),
  });
  return res.json();
};

const playerCancelWebhook = async (eventId) => {
  const body = JSON.stringify({
    destination: 'Utest',
    events: [{
      type: 'message', mode: 'active', timestamp: CREATED_AT + 60_000,
      source: { type: 'user', userId: LINE_USER },
      // Must NOT look like an all-zero token: the webhook handler treats
      // /^0000[0-9a-f]{26,}$/ as a LINE Console "Verify" probe and silently
      // discards the event, which would make this harness pass vacuously.
      replyToken: 'a'.repeat(64),
      webhookEventId: eventId,
      message: { id: `msg-${eventId}`, type: 'text', text: `ยกเลิก ${ORDER_NO}` },
    }],
  });
  const signature = createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
  const res = await mf.dispatchFetch('http://localhost/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-line-signature': signature },
    body,
  });
  await res.text();
};

// ── Scenario ────────────────────────────────────────────────────────────────
console.log(`REFUND_FIX=${process.env.REFUND_FIX || 'on'}`);
console.log(`start balance: ${await balance()}\n`);

console.log('STEP 1  admin cancels the order');
const adminRes = await rpc('adminRequestCancelBet', [`bet_${ORDER_NO}`], { 'x-admin-key': ADMIN_KEY });
console.log('        ->', JSON.stringify(adminRes?.data));
const afterAdmin = await balance();
console.log(`        balance: ${afterAdmin}\n`);

console.log('STEP 2  restore the order record to pending_match');
console.log('        (stands in for the stale copy LINE\'s PoP was still serving)');
await kvOrders.put(`ORDER_${ORDER_NO}`, order('pending_match'));

console.log('\nSTEP 3  player cancels the same order from LINE');
await playerCancelWebhook('evt-player-cancel-1');
const afterPlayer = await balance();
console.log(`        balance: ${afterPlayer}\n`);

await mf.dispose();
rmSync(outDir, { recursive: true, force: true });

console.log('RESULT');
if (afterPlayer === START_BALANCE + 2 * AMOUNT) {
  console.log(`  FAIL  double refund: one 100pt order paid out twice (${START_BALANCE} -> ${afterPlayer})`);
  process.exit(1);
}
if (afterAdmin === START_BALANCE + AMOUNT && afterPlayer === afterAdmin) {
  console.log(`  PASS  exactly one refund: ${START_BALANCE} -> ${afterAdmin}, second cancel credited nothing`);
  process.exit(0);
}
console.log(`  UNEXPECTED  afterAdmin=${afterAdmin} afterPlayer=${afterPlayer}`);
process.exit(2);
