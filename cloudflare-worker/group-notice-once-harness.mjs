/**
 * Regression harness: a refusal for a tap in the LINE group is pushed once.
 *
 * Admin feedback, 21 Nov 2026: once an order is matched, every further tap on
 * its card (even by the same player) pushed another "แผลนี้มีคู่ดวลแล้ว" DM.
 * Pushes count against the OA's monthly quota, so a busy board ate it fast.
 *
 * Now:
 *   - the matcher or creator tapping their own matched order gets nothing
 *     (they already have the match card)
 *   - anyone else is told once per order; repeat taps are silent
 *   - "ยกเลิก" on a locked order is answered once per player per order
 *   - after Final Call, a player tapping the board is told once per round
 *   - a tap in DM is still answered every time (reply token, free)
 *
 * Usage:  node group-notice-once-harness.mjs
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
const GROUP = 'Cgroup000000000000000000000000001';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'notice-once-harness-'));
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
const M1 = { shortId: 'PL000002', lineUserId: 'Uaaaaa0000000002', name: 'MATCHER1' };
const M2 = { shortId: 'PL000003', lineUserId: 'Uaaaaa0000000003', name: 'BYSTANDER' };

async function freshEnv(suffix) {
  const pushes = [];
  const replies = [];
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `no-cache-${suffix}`, KV_ORDERS: `no-ord-${suffix}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    outboundService: async (req) => {
      if (req.url.includes('/v2/bot/message/push')) pushes.push(await req.json());
      else if (req.url.includes('/v2/bot/message/reply')) replies.push(await req.json());
      return new Response('{}', { status: 200 });
    },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't',
      ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kvO = await mf.getKVNamespace('KV_ORDERS');
  const kvC = await mf.getKVNamespace('KV_CACHE');
  const prof = (p, bal) => ({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });

  async function seed(orderNo, roundStatus = 'ACTIVE') {
    const order = {
      orderNumber: orderNo, creatorId: A.shortId, creatorName: A.name,
      creatorLineUserId: A.lineUserId, side: 'low', amount: 500,
      betType: 'range', rangeMin: 330, rangeMax: 380, roundId: 'R1',
      status: 'pending_match', createdAt: CREATED_AT, id: `bet_${orderNo}`,
      playerLowId: A.shortId, playerLowName: A.name,
    };
    await kvO.put(`ORDER_${orderNo}`, JSON.stringify(order));
    await kvC.put('PENDING_ORDERS_LIST', JSON.stringify([order]));
    await kvC.put('ACTIVE_GROUP_ID', GROUP);
    await kvC.put('ACTIVE_ROUND', JSON.stringify({ roundId: 'R1', name: 'R1', targetMin: 330, targetMax: 380, status: roundStatus }));
    const ps = [prof(A, 500), prof(M1, 1000), prof(M2, 1000)];
    await kvC.put('PLAYERS_LIST', JSON.stringify(ps));
    for (const p of ps) {
      await kvC.put(`USER_${p.lineUserId}`, JSON.stringify(p));
      await kvC.put(`USER_${p.shortId}`, JSON.stringify(p));
      await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
    }
  }

  let seq = 0;
  async function say(user, text, inGroup = true) {
    const eventId = `e${suffix}${++seq}`;
    const source = inGroup
      ? { type: 'group', groupId: GROUP, userId: user.lineUserId }
      : { type: 'user', userId: user.lineUserId };
    const body = JSON.stringify({
      destination: 'Utest',
      events: [{
        type: 'message', replyToken: 'r'.repeat(60) + String(seq).padStart(4, '0'), webhookEventId: eventId,
        source, timestamp: Date.now(), message: { id: `m${eventId}`, type: 'text', text },
      }],
    });
    const sig = createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
    await (await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body,
    })).text();
    await new Promise((r) => setTimeout(r, 350));
  }

  const pushesTo = (u) => pushes.filter((p) => p.to === u.lineUserId);
  const reset = () => { pushes.length = 0; replies.length = 0; };
  const order = async (no) => JSON.parse((await kvO.get(`ORDER_${no}`)) || 'null');
  const putOrder = async (o) => kvO.put(`ORDER_${o.orderNumber}`, JSON.stringify(o));
  const board = async (orders) => kvC.put('PENDING_ORDERS_LIST', JSON.stringify(orders));
  return { seed, say, pushes, replies, pushesTo, reset, order, putOrder, board, dispose: () => mf.dispose() };
}

const altOf = (p) => (p.messages || []).map((m) => m.altText || m.text || '').join(' | ');

console.log('GROUP NOTICE ONCE HARNESS\n');

console.log('MATCHED ORDER — repeat taps');
{
  const env = await freshEnv('a');
  await env.seed('7015');
  await env.say(M1, 'ต 7015 500');
  const o = await env.order('7015');
  check('order matched to MATCHER1', o?.status === 'matched' && o?.matcherId === M1.shortId, `${o?.status} ${o?.matcherId}`);
  check('match card pushed to matcher and creator', env.pushesTo(M1).length === 1 && env.pushesTo(A).length === 1,
    `m1=${env.pushesTo(M1).length} a=${env.pushesTo(A).length}`);

  env.reset();
  for (let i = 0; i < 4; i++) await env.say(M1, 'ต 7015 500');
  check('matcher re-tapping 4x: no push', env.pushes.length === 0, env.pushes.map(altOf).join(' / '));

  env.reset();
  for (let i = 0; i < 3; i++) await env.say(A, 'ต 7015 500');
  check('creator tapping own matched order 3x: no push', env.pushes.length === 0, env.pushes.map(altOf).join(' / '));

  env.reset();
  for (let i = 0; i < 5; i++) await env.say(M2, 'ต 7015 500');
  check('another player tapping 5x: exactly one push', env.pushesTo(M2).length === 1, String(env.pushesTo(M2).length));
  check('...and it says the order is taken', /คู่ดวลแล้ว|ถูกรับไป/.test(JSON.stringify(env.pushes)), env.pushes.map(altOf).join(' / '));

  env.reset();
  for (let i = 0; i < 3; i++) await env.say(M2, 'ยกเลิก 7015');
  check('ยกเลิก on a locked order 3x: exactly one push', env.pushesTo(M2).length === 1, String(env.pushesTo(M2).length));

  env.reset();
  await env.say(M2, 'ต 7015 500', false);
  await env.say(M2, 'ต 7015 500', false);
  check('in DM the player is still answered every time, by free reply', env.replies.length === 2 && env.pushes.length === 0,
    `replies=${env.replies.length} pushes=${env.pushes.length}`);

  const after = await env.order('7015');
  check('order untouched by the taps', after?.status === 'matched' && after?.matcherId === M1.shortId && after?.amount === 500,
    `${after?.status} ${after?.matcherId} ${after?.amount}`);
  await env.dispose();
}

console.log('\nROUND CLOSED — taps after Final Call');
{
  const env = await freshEnv('b');
  await env.seed('7016', 'CLOSED');
  for (let i = 0; i < 4; i++) await env.say(M2, 'ต 7016 500');
  check('one "closed" push per player per round', env.pushesTo(M2).length === 1, String(env.pushesTo(M2).length));
  await env.say(M1, 'ต 7016 500');
  check('a different player still gets their own one', env.pushesTo(M1).length === 1, String(env.pushesTo(M1).length));
  await env.dispose();
}

console.log('\nOPEN ORDER — still works normally');
{
  const env = await freshEnv('c');
  await env.seed('7017');
  await env.say(A, 'ต 7017 500');
  await env.say(A, 'ต 7017 500');
  check('creator tapping own open order: told once', env.pushesTo(A).length === 1, String(env.pushesTo(A).length));
  env.reset();
  await env.say(M2, 'ต 7017 500');
  const o = await env.order('7017');
  check('a later tap by someone else still matches', o?.status === 'matched' && o?.matcherId === M2.shortId, `${o?.status} ${o?.matcherId}`);
  check('both players get the match card', env.pushesTo(M2).length === 1 && env.pushesTo(A).length === 1,
    `m2=${env.pushesTo(M2).length} a=${env.pushesTo(A).length}`);
  await env.dispose();
}

console.log('\nOLD BOARD CARD — "ต 1000" for an order that just finished');
{
  const env = await freshEnv('d');
  await env.seed('7021');
  // #7021 (500, from seed) is the newest open order. #1000 settled an hour ago.
  const now = Date.now();
  await env.putOrder({
    orderNumber: '1000', creatorId: 'PL999999', creatorName: 'OLD', side: 'low', amount: 300,
    betType: 'range', rangeMin: 330, rangeMax: 380, roundId: 'R0', status: 'settled',
    createdAt: now - 3 * 3600000, settledAt: now - 3600000,
  });
  for (let i = 0; i < 3; i++) await env.say(M2, 'ต 1000');
  let o = await env.order('7021');
  check('the bare tap does NOT take the newest order', o?.status === 'pending_match', String(o?.status));
  check('the player is asked once, not on every tap', env.pushesTo(M2).length === 1, String(env.pushesTo(M2).length));
  check('...and told how to take points instead', /ต 1000 แต้ม/.test(JSON.stringify(env.pushes)), env.pushes.map(altOf).join(' / '));

  await env.dispose();
}

console.log('\nOLD BOARD CARD — "ต 1000 แต้ม" is always an amount');
{
  const env = await freshEnv('e');
  await env.seed('7022');
  const now = Date.now();
  await env.putOrder({
    orderNumber: '1000', creatorId: 'PL999999', creatorName: 'OLD', side: 'low', amount: 300,
    betType: 'range', rangeMin: 330, rangeMax: 380, roundId: 'R0', status: 'settled',
    createdAt: now - 3 * 3600000, settledAt: now - 3600000,
  });
  await env.putOrder({ ...(await env.order('7022')), amount: 2000 });
  await env.board([await env.order('7022')]);
  await env.say(M1, 'ต 1000 แต้ม');
  const o = await env.order('7022');
  check('"ต 1000 แต้ม" takes 1000 pt even with #1000 just finished', o?.status === 'matched' && o?.amount === 1000, `${o?.status} ${o?.amount}`);
  await env.dispose();
}

console.log('\nOLD ORDER — "ต 1000" with #1000 finished days ago is still an amount');
{
  const env = await freshEnv('g');
  await env.seed('7024');
  const now = Date.now();
  await env.putOrder({
    orderNumber: '1000', creatorId: 'PL999999', creatorName: 'OLD', side: 'low', amount: 300,
    betType: 'range', rangeMin: 330, rangeMax: 380, roundId: 'R0', status: 'settled',
    createdAt: now - 4 * 86400000, settledAt: now - 3 * 86400000,
  });
  await env.putOrder({ ...(await env.order('7024')), amount: 2000 });
  await env.board([await env.order('7024')]);
  await env.say(M1, 'ต 1000');
  const o = await env.order('7024');
  check('"ต 1000" takes 1000 pt of the newest order (15 Nov rule kept)', o?.status === 'matched' && o?.amount === 1000 && o?.matcherId === M1.shortId,
    `${o?.status} ${o?.amount} ${o?.matcherId}`);
  await env.dispose();
}

console.log('\nNEW BOARD CARD — sends "ต #NNNN"');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/flexTemplates.ts', 'utf8');
  check('board accept button text carries "#"', /text: `ต #\$\{b\.orderNumber\}`/.test(src));
  const env = await freshEnv('f');
  await env.seed('7023');
  await env.say(M2, 'ต #7023');
  const o = await env.order('7023');
  check('"ต #7023" takes order #7023', o?.status === 'matched' && o?.matcherId === M2.shortId, `${o?.status} ${o?.matcherId}`);
  await env.dispose();
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
