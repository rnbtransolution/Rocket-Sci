/**
 * Regression harness for round locking.
 *
 * THE REPORT
 * ----------
 * After the admin sends the "final call" (ปิดรับดวล / adminBroadcastFinalCall),
 * players can still create orders. The portal promises the opposite: "ประกาศ
 * ปิดรับออเดอร์ท้าดวลก่อนปล่อยบั้งไฟ บอทจะปฏิเสธทุกบิลหลังจากนี้" — the bot
 * will reject every bet from here on.
 *
 * `handleCreateOrder` rejects when ACTIVE_ROUND.status === 'CLOSED', and
 * adminBroadcastFinalCall does set CLOSED. So the guard exists. The question
 * is whether anything puts the round back to ACTIVE afterwards.
 *
 * Usage:  node round-lock-harness.mjs
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

const outDir = mkdtempSync(join(tmpdir(), 'lock-harness-'));
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

const PLAYER = { shortId: 'PL000001', lineUserId: 'Uaaaaa0000000001', name: 'PLAYER' };

async function fresh(label, round) {
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `lk-c-${label}`, KV_ORDERS: `lk-o-${label}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: CH, LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvC = await mf.getKVNamespace('KV_CACHE');
  const prof = JSON.stringify({ shortId: PLAYER.shortId, lineUserId: PLAYER.lineUserId, displayName: PLAYER.name, balance: 5000, registeredAt: CREATED_AT, updatedAt: CREATED_AT });
  await kvC.put('PLAYERS_LIST', JSON.stringify([JSON.parse(prof)]));
  await kvC.put(`USER_${PLAYER.lineUserId}`, prof);
  await kvC.put(`USER_${PLAYER.shortId}`, prof);
  await kvC.put(`RAW_LINE_${PLAYER.shortId}`, PLAYER.lineUserId);
  await kvC.put('ACTIVE_ROUND', JSON.stringify(round));

  const rpc = async (functionName, args = []) => {
    const res = await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName, args }),
    });
    return (await res.json());
  };

  let seq = 0;
  const say = async (text) => {
    const eventId = `e${++seq}`;
    const body = JSON.stringify({
      destination: 'G1',
      events: [{
        type: 'message', replyToken: 'a'.repeat(64), webhookEventId: eventId,
        source: { type: 'user', userId: PLAYER.lineUserId },
        timestamp: 1, message: { id: `m${eventId}`, type: 'text', text },
      }],
    });
    const sig = createHmac('sha256', CH).update(body).digest('base64');
    await (await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body,
    })).text();
    await new Promise((r) => setTimeout(r, 320));
  };

  const roundStatus = async () => {
    const d = (await (await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
    })).json())?.data || {};
    return (d.activeRound || {}).status;
  };
  const orderCount = async () => {
    const d = (await (await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName: 'getDashboardData', args: [] }),
    })).json())?.data || {};
    return (d.bets || []).length;
  };

  return { rpc, say, roundStatus, orderCount, kvC: () => mf.getKVNamespace('KV_CACHE'), dispose: () => mf.dispose() };
}

const ACTIVE = { name: 'R', targetMin: 350, targetMax: 400, status: 'ACTIVE', isChotoy: false, quoteReleased: true, updatedAt: CREATED_AT };
const PRE = { name: 'R', targetMin: 0, targetMax: 0, status: 'ACTIVE', isChotoy: false, quoteReleased: false, updatedAt: CREATED_AT };

console.log('ROUND LOCK HARNESS\n');

// ── Final call must lock the round ──────────────────────────────────────────
console.log('FINAL CALL — round locks and orders are refused');
{
  const env = await fresh('final', ACTIVE);
  await env.rpc('adminBroadcastFinalCall', ['ALL']);
  check('round status becomes CLOSED', (await env.roundStatus()) === 'CLOSED', String(await env.roundStatus()));

  const before = await env.orderCount();
  await env.say('ชล500');
  check('a player order is refused after the final call',
    (await env.orderCount()) === before, `orders ${before} -> ${await env.orderCount()}`);
  check('round stays CLOSED', (await env.roundStatus()) === 'CLOSED');
  await env.dispose();
}

// ── A pre-quote round: final call with no quote → locked too ────────────────
console.log('\nFINAL CALL on a never-quoted round');
{
  const env = await fresh('pre', PRE);
  await env.rpc('adminBroadcastFinalCall', ['ALL']);
  check('round becomes CLOSED', (await env.roundStatus()) === 'CLOSED', String(await env.roundStatus()));
  const before = await env.orderCount();
  await env.say('ชล500');
  check('orders refused', (await env.orderCount()) === before);
  await env.dispose();
}

// ── Does a LATER quote reopen a closed round? ───────────────────────────────
console.log('\nQUOTE AFTER THE FINAL CALL — must NOT reopen');
{
  const env = await fresh('reopen', ACTIVE);
  await env.rpc('adminBroadcastFinalCall', ['ALL']);
  check('locked first', (await env.roundStatus()) === 'CLOSED');
  await env.rpc('adminBroadcastQuote', ['ALL', 'ช่าง', 350, 400, false]);
  const after = await env.roundStatus();
  check('round stays CLOSED after a quote is sent', after === 'CLOSED', `status is ${after}`);

  const before = await env.orderCount();
  await env.say('ชล500');
  check('orders still refused after the quote', (await env.orderCount()) === before,
    `orders ${before} -> ${await env.orderCount()}`);
  await env.dispose();
}

// ── Opening a round deliberately SHOULD reopen ─────────────────────────────
console.log('\nOPENING A ROUND — deliberately reopens');
{
  const env = await fresh('open', ACTIVE);
  await env.rpc('adminBroadcastFinalCall', ['ALL']);
  check('locked', (await env.roundStatus()) === 'CLOSED');
  await env.rpc('adminOpenRound', ['รอบใหม่', 300, 350]);
  check('a new round reopens it to ACTIVE', (await env.roundStatus()) === 'ACTIVE', String(await env.roundStatus()));
  await env.dispose();
}

// ── A VOID round must not be revived by a player's bet ────────────────────
console.log('\nVOID ROUND — a player bet must not resurrect it');
{
  const env = await fresh('void', { ...ACTIVE, status: 'VOID' });
  check('round starts VOID', (await env.roundStatus()) === 'VOID', String(await env.roundStatus()));
  const before = await env.orderCount();
  await env.say('ชล500');
  check('a player order does NOT reopen a void round',
    (await env.roundStatus()) === 'VOID', `status became ${await env.roundStatus()}`);
  check('and creates no order', (await env.orderCount()) === before,
    `orders ${before} -> ${await env.orderCount()}`);
  await env.dispose();
}

// ── The same must hold for a RESOLVED round ───────────────────────────────
console.log('\nRESOLVED ROUND — a player bet must not resurrect it');
{
  const env = await fresh('resolved', { ...ACTIVE, status: 'RESOLVED' });
  const before = await env.orderCount();
  await env.say('ชล500');
  check('a player order does NOT reopen a resolved round',
    (await env.roundStatus()) === 'RESOLVED', `status became ${await env.roundStatus()}`);
  check('and creates no order', (await env.orderCount()) === before);
  await env.dispose();
}

// ── VOID round + new quote → should reopen to ACTIVE (the production bug) ──
console.log('\nVOID ROUND + adminBroadcastQuote — must reopen to ACTIVE');
{
  // Pre-seed the ACTIVE_GROUP_ID so the bet can reach handleCreateOrder
  // (without it the handler exits early with "no group" before checking round status).
  const env = await fresh('void-requote', { ...ACTIVE, status: 'VOID' });
  const kvC = await env.kvC();
  await kvC.put('ACTIVE_GROUP_ID', 'Ctest001');

  check('starts VOID', (await env.roundStatus()) === 'VOID');
  await env.rpc('adminBroadcastQuote', ['ALL', 'รอบใหม่', 300, 350, false]);
  check('broadcasting a new quote reopens VOID → ACTIVE',
    (await env.roundStatus()) === 'ACTIVE', `status = ${await env.roundStatus()}`);
  // The round is now ACTIVE — a player bet should not be rejected by the lock guard.
  // (Order may still fail for other reasons like LINE push errors in test env,
  //  but it must NOT fail because the round is locked.)
  const countBefore = await env.orderCount();
  await env.say('ชล500');
  const countAfter = await env.orderCount();
  check('player bet is accepted (order created, not rejected by round lock)',
    countAfter > countBefore, `pending orders ${countBefore} -> ${countAfter}`);
  await env.dispose();
}

// ── CLOSED round + new quote → must NOT reopen (Final Call lock) ──────────
console.log('\nCLOSED ROUND + adminBroadcastQuote — must stay CLOSED (Final Call lock)');
{
  const env = await fresh('closed-requote', { ...ACTIVE, status: 'CLOSED' });
  check('starts CLOSED', (await env.roundStatus()) === 'CLOSED');
  await env.rpc('adminBroadcastQuote', ['ALL', 'ลองใหม่', 300, 350, false]);
  check('CLOSED round stays locked even after a quote is sent',
    (await env.roundStatus()) === 'CLOSED', `status = ${await env.roundStatus()}`);
  const before = await env.orderCount();
  await env.say('ชล500');
  check('players still cannot place orders (Final Call still active)',
    (await env.orderCount()) === before, `orders ${before} -> ${await env.orderCount()}`);
  await env.dispose();
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);