/**
 * Regression harness for the DM rich menu switch, 25 Nov 2026.
 *
 *  1. Every tile in tools/rich-menu/richmenu.json sends a word the bot answers in DM.
 *  2. DM_QUICK_REPLY unset/"on": DM replies keep the Quick Reply chips.
 *  3. DM_QUICK_REPLY "off": DM replies and DM pushes carry no chips, the card itself is unchanged.
 *
 * Usage:  node rich-menu-harness.mjs
 */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const ADMIN_KEY = 'test_admin_key';
const CH = 'test_channel_secret';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'rich-menu-harness-'));
const bundlePath = join(outDir, 'worker.mjs');
await build({
  entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'neutral',
  mainFields: ['module', 'main'], conditions: ['worker', 'browser'],
  external: ['cloudflare:workers'], outfile: bundlePath,
  banner: { js: `{ const __s=function(n){return this.get(this.idFromName(n));};
    Object.defineProperty(Object.prototype,'getByName',{value:__s,configurable:true,writable:true,enumerable:false}); }` },
  logLevel: 'error',
});

const menu = JSON.parse(readFileSync('tools/rich-menu/richmenu.json', 'utf8'));
const U1 = 'U0123456789abcdef0123456789abcde1';

async function instance(tag, extra) {
  const replies = [], pushes = [];
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `rm-cache-${tag}`, KV_ORDERS: `rm-orders-${tag}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: CH, LINE_CHANNEL_ACCESS_TOKEN: 't', ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
      ...extra,
    },
    outboundService: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/message/reply')) replies.push(JSON.parse(await req.text()));
      if (url.pathname.endsWith('/message/push')) pushes.push(JSON.parse(await req.text()));
      return new Response('{}', { status: 200 });
    },
  });
  let seq = 0;
  const send = async (text) => {
    const body = JSON.stringify({ destination: 'G1', events: [{
      type: 'message', replyToken: `${++seq}`.padStart(64, 'r'), webhookEventId: `ev_${tag}_${seq}`,
      source: { type: 'user', userId: U1 }, timestamp: Date.now(),
      message: { id: `${2000000 + seq}`, type: 'text', text },
    }] });
    const sig = createHmac('sha256', CH).update(body).digest('base64');
    await (await mf.dispatchFetch('http://localhost/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body,
    })).text();
    await new Promise((r) => setTimeout(r, 350));
  };
  const rpc = async (functionName, args = []) => {
    const res = await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName, args }),
    });
    return res.json();
  };
  return { mf, send, rpc, replies, pushes };
}

const hasChips = (m) => Array.isArray(m?.quickReply?.items) && m.quickReply.items.length > 0;

console.log('RICH MENU HARNESS\n');

// 1 + 2: default (var unset) keeps chips; every tile word gets a reply card.
const on = await instance('on', {});
for (const area of menu.areas) {
  const before = on.replies.length;
  await on.send(area.action.text);
  const r = on.replies.slice(before);
  const msg = r[0]?.messages?.[0];
  check(`tile "${area.action.text}" gets a DM reply`, r.length === 1 && msg?.type === 'flex', JSON.stringify(r).slice(0, 200));
  check(`tile "${area.action.text}" keeps chips when switch is on`, hasChips(msg));
}
check('menu has 5 tiles and fits 2500x1686', menu.areas.length === 5 && menu.areas.every((a) =>
  a.bounds.x + a.bounds.width <= 2500 && a.bounds.y + a.bounds.height <= 1686));

// 3: off removes chips from replies and pushes.
const off = await instance('off', { DM_QUICK_REPLY: 'off' });
for (const area of menu.areas) {
  const before = off.replies.length;
  await off.send(area.action.text);
  const msg = off.replies.slice(before)[0]?.messages?.[0];
  check(`tile "${area.action.text}" reply has no chips when off`, msg?.type === 'flex' && !hasChips(msg), JSON.stringify(msg?.quickReply));
}
const pb = off.pushes.length;
await off.rpc('adminSendDirectMessage', [U1, 'ทดสอบ']);
const p = off.pushes.slice(pb).filter((x) => x.to === U1);
check('DM pushes carry no chips when off', p.length === 1 && p.every((x) => x.messages.every((m) => !hasChips(m))), JSON.stringify(p).slice(0, 200));

await on.mf.dispose();
await off.mf.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
