/**
 * Regression harness for the admin chat (console ↔ player DM), 18 Nov 2026.
 *
 *  1. A player's DM text and image land in their thread and raise the unread count.
 *  2. The bot's reply to that DM is filed in the same thread as 'bot'.
 *  3. Group messages never create a thread.
 *  4. Opening the thread clears unread; the admin's message is pushed to LINE
 *     as plain text, filed as 'admin', and is not run as a bot command.
 *  5. Bad user ids and empty text are refused; Factory Reset clears the history.
 *
 * Usage:  node admin-chat-harness.mjs
 */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
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

const outDir = mkdtempSync(join(tmpdir(), 'admin-chat-harness-'));
const bundlePath = join(outDir, 'worker.mjs');
await build({
  entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'neutral',
  mainFields: ['module', 'main'], conditions: ['worker', 'browser'],
  external: ['cloudflare:workers'], outfile: bundlePath,
  banner: { js: `{ const __s=function(n){return this.get(this.idFromName(n));};
    Object.defineProperty(Object.prototype,'getByName',{value:__s,configurable:true,writable:true,enumerable:false}); }` },
  logLevel: 'error',
});

const pushes = [];
const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'ac-cache', KV_ORDERS: 'ac-orders' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: CH, LINE_CHANNEL_ACCESS_TOKEN: 't', ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
  },
  outboundService: async (req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/message/push')) pushes.push(JSON.parse(await req.text()));
    if (url.pathname.includes('/content')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    return new Response('{}', { status: 200 });
  },
});

const U1 = 'U0123456789abcdef0123456789abcde1';
const U2 = 'U0123456789abcdef0123456789abcde2';
const rpc = async (functionName, args = []) => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  });
  const j = await res.json();
  return j?.data || j;
};
let seq = 0;
const send = async (userId, message, group = null) => {
  const eventId = `ev_${++seq}`;
  const body = JSON.stringify({ destination: 'G1', events: [{
    type: 'message', replyToken: `${seq}`.padStart(64, 'r'), webhookEventId: eventId,
    source: group ? { type: 'group', groupId: group, userId } : { type: 'user', userId },
    timestamp: Date.now(), message: { id: `${1000000 + seq}`, ...message },
  }] });
  const sig = createHmac('sha256', CH).update(body).digest('base64');
  await (await mf.dispatchFetch('http://localhost/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body,
  })).text();
  await new Promise((r) => setTimeout(r, 350));
};

console.log('ADMIN CHAT HARNESS\n');

await send(U1, { type: 'text', text: 'สวัสดีครับ ฝากถามเรื่องยอด' });
await send(U1, { type: 'text', text: 'เช็คยอด' });
await send(U1, { type: 'image' });
await send(U2, { type: 'text', text: 'ชล500' }, 'C0123456789abcdef0123456789abcdef');

let inbox = await rpc('getDmInbox');
const t1 = (inbox.threads || []).find((t) => t.userId === U1);
check('player DM creates a thread', !!t1, JSON.stringify(inbox));
check('three player messages counted unread', t1?.unread === 3, `unread=${t1?.unread}`);
check('group message creates no thread', !(inbox.threads || []).some((t) => t.userId === U2));

let th = await rpc('getDmThread', [U1, false]);
const msgs = th.messages || [];
check('player text filed as user', msgs.some((m) => m.from === 'user' && m.text.includes('ฝากถาม')));
check('bot balance reply filed as bot', msgs.some((m) => m.from === 'bot'), JSON.stringify(msgs.map((m) => [m.from, m.text])));
const img = msgs.find((m) => m.type === 'image');
check('image keeps its LINE message id', !!img?.messageId);
inbox = await rpc('getDmInbox');
check('background refresh leaves unread alone', inbox.threads.find((t) => t.userId === U1).unread === 3);

th = await rpc('getDmThread', [U1]);
inbox = await rpc('getDmInbox');
check('opening the thread clears unread', inbox.threads.find((t) => t.userId === U1).unread === 0 && inbox.unreadTotal === 0);

const before = pushes.length;
const sent = await rpc('adminSendDirectMessage', [U1, 'เช็คยอด']);
check('admin send succeeds', sent.success === true, JSON.stringify(sent));
const p = pushes.slice(before);
check('one push to the player as plain text', p.length === 1 && p[0].to === U1 && p[0].messages[0].type === 'text' && p[0].messages[0].text === 'เช็คยอด', JSON.stringify(p));
th = await rpc('getDmThread', [U1]);
const last = th.messages[th.messages.length - 1];
check('admin message filed once as admin', last.from === 'admin' && th.messages.filter((m) => m.from === 'admin').length === 1);
check('admin text is not filed again as bot', th.messages.filter((m) => m.text === 'เช็คยอด' && m.from === 'bot').length === 0);

const imgRes = await rpc('getDmImage', [img.messageId]);
check('image loads as data URL', String(imgRes.dataUrl || '').startsWith('data:image/jpeg;base64,'));
check('bad user id refused', (await rpc('adminSendDirectMessage', ['PL000001', 'hi'])).success === false);
check('empty text refused', (await rpc('adminSendDirectMessage', [U1, '   '])).success === false);

await rpc('adminSetDangerPin', ['583920']);
const reset = await rpc('resetGoogleSheetsDatabase', ['583920']);
inbox = await rpc('getDmInbox');
th = await rpc('getDmThread', [U1]);
check('factory reset clears chat history', (inbox.threads || []).length === 0 && th.messages.length === 0, JSON.stringify(reset).slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
await mf.dispose();
process.exit(fail ? 1 : 0);
