/**
 * Regression harness for the automatic slip re-check, 24 Nov 2026.
 *
 * Bangkok Bank publishes a transfer a few minutes after it is made, so a slip
 * sent straight away fails the slip API and used to wait for an admin even
 * though the same image passes later (seen 23 Nov 2026).
 *
 *  1. A slip the API cannot verify yet is held with a re-check scheduled, the
 *     player is told not to resend, and nothing is credited.
 *  2. The cron does nothing before the re-check is due.
 *  3. When the bank has published it, the re-check credits the slip once and
 *     pushes the credited card.
 *  4. A slip that keeps failing is re-checked 3 times, then left for the admin.
 *  5. A slip already credited from another submission is not credited again.
 *  6. An entry the admin approved meanwhile is left alone (no double credit).
 *  7. A guard failure (slip too old) is never retried.
 *  8. Bangkok Bank "pending" (HTTP error) is retried too.
 *
 * Usage:  node slip-retry-harness.mjs
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

const outDir = mkdtempSync(join(tmpdir(), 'slip-retry-harness-'));
const bundlePath = join(outDir, 'worker.mjs');
await build({
  entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'neutral',
  mainFields: ['module', 'main'], conditions: ['worker', 'browser'],
  external: ['cloudflare:workers'], outfile: bundlePath,
  banner: { js: `{ const __s=function(n){return this.get(this.idFromName(n));};
    Object.defineProperty(Object.prototype,'getByName',{value:__s,configurable:true,writable:true,enumerable:false}); }` },
  logLevel: 'error',
});

/**
 * What the slip API says for each LINE message id. The image bytes the LINE
 * content mock serves are the message id itself, so the slip API mock knows
 * which slip it is looking at.
 */
const slips = new Map(); // messageId -> { mode: 'pending'|'bblPending'|'ok', ref, amount, dateTime }
const slipCalls = new Map();
const pushes = []; // pushes and replies
const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'sr-cache', KV_ORDERS: 'sr-orders' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: CH, LINE_CHANNEL_ACCESS_TOKEN: 't', ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    SLIP_API_KEY: 'slip_key',
  },
  outboundService: async (req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/message/push') || url.pathname.endsWith('/message/reply')) { pushes.push(JSON.parse(await req.text())); return new Response('{}'); }
    const content = url.pathname.match(/\/message\/(\d+)\/content$/);
    if (content) return new Response(new TextEncoder().encode(content[1]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.hostname === 'connect.slip2go.com') {
      const body = JSON.parse(await req.text());
      const id = atob(String(body.payload.imageBase64).split(',')[1]);
      slipCalls.set(id, (slipCalls.get(id) || 0) + 1);
      const s = slips.get(id);
      if (!s || s.mode === 'pending') {
        return Response.json({ code: '200404', message: 'Slip not found' });
      }
      if (s.mode === 'bblPending') {
        return Response.json({ message: 'Bangkok Bank transaction is pending, please try again later' }, { status: 400 });
      }
      return Response.json({ code: '200000', message: 'Slip found', data: {
        transRef: s.ref, amount: s.amount, dateTime: s.dateTime || new Date().toISOString(),
        sender: { bank: { abbr: 'BBL' }, account: { name: 'Test Payer', bank: { account: '000-0-xxx000' } } },
      } });
    }
    return new Response('{}', { status: 200 });
  },
});

const rpc = async (functionName, args = []) => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  });
  const j = await res.json();
  return j?.data || j;
};
let seq = 0;
const sendSlip = async (userId, messageId) => {
  const body = JSON.stringify({ destination: 'G1', events: [{
    type: 'message', replyToken: `${++seq}`.padStart(64, 'r'), webhookEventId: `ev_${seq}`,
    source: { type: 'user', userId }, timestamp: Date.now(), message: { id: messageId, type: 'image' },
  }] });
  const sig = createHmac('sha256', CH).update(body).digest('base64');
  await (await mf.dispatchFetch('http://localhost/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body,
  })).text();
  await new Promise((r) => setTimeout(r, 500));
};
const worker = await mf.getWorker();
const cronAt = async (ms) => {
  await worker.scheduled({ scheduledTime: new Date(ms), cron: '* * * * *' });
  await new Promise((r) => setTimeout(r, 300));
};
const dash = () => rpc('getDashboardData');
const balanceOf = async (u) => (await dash()).players.find((p) => p.lineUserId === u)?.balance ?? null;
const txOf = async (msg) => (await dash()).transactions.find((t) => t.messageId === msg || t.slipRef === msg);
const pushText = (p) => JSON.stringify(p);
const MIN = 60_000;

const U1 = 'U0123456789abcdef0123456789abcde1';
const U2 = 'U0123456789abcdef0123456789abcde2';
const U3 = 'U0123456789abcdef0123456789abcde3';

try {
  // ── 1–3: Bangkok Bank slip, published a few minutes late ──
  console.log('\n1–3. Slip passes on the first re-check');
  const m1 = '700000000000000001';
  await sendSlip(U1, m1);
  let t1 = await txOf(m1);
  check('held, not credited', t1?.status === 'escalated' && (await balanceOf(U1)) === 0, JSON.stringify(t1));
  check('re-check scheduled about 2 min after arrival',
    t1?.slipRetry?.attempts === 0 && Math.abs(t1.slipRetry.nextAt - t1.createdAt - 2 * MIN) < 5000, JSON.stringify(t1?.slipRetry));
  check('player told it will be re-checked, no need to resend',
    pushes.some((p) => /รอธนาคารยืนยัน/.test(pushText(p)) && /ไม่ต้องส่งสลิปซ้ำ/.test(pushText(p))));

  await cronAt(t1.createdAt + 60_000);
  check('cron before due does not scan', (slipCalls.get(m1) || 0) === 1, `calls=${slipCalls.get(m1)}`);

  slips.set(m1, { mode: 'ok', ref: '2026112300000000000000001', amount: 100 });
  const pushesBefore = pushes.length;
  await cronAt(t1.createdAt + 2 * MIN);
  t1 = await txOf(m1);
  check('credited on re-check', t1?.status === 'success' && t1.actualAmount === 100 && (await balanceOf(U1)) === 100, JSON.stringify(t1));
  check('entry carries the bank reference', t1?.slipRef === '2026112300000000000000001' && t1.slipVerified === true);
  check('credited card pushed to player', pushes.slice(pushesBefore).some((p) => p.to === U1 && /เงินเข้า/.test(pushText(p))));
  await cronAt(t1.createdAt + 5 * MIN);
  await cronAt(t1.createdAt + 10 * MIN);
  check('no further scans or credit after success', slipCalls.get(m1) === 2 && (await balanceOf(U1)) === 100, `calls=${slipCalls.get(m1)}`);

  // ── 4: never verifies ──
  console.log('\n4. Slip that keeps failing goes to the admin after 3 re-checks');
  const m2 = '700000000000000002';
  await sendSlip(U2, m2);
  let t2 = await txOf(m2);
  for (const min of [2, 5, 10]) await cronAt(t2.createdAt + min * MIN);
  t2 = await txOf(m2);
  check('scanned 1 + 3 times', slipCalls.get(m2) === 4, `calls=${slipCalls.get(m2)}`);
  check('still held, retries finished', t2?.status === 'escalated' && t2.slipRetry?.attempts === 3 && t2.slipRetry.nextAt === undefined, JSON.stringify(t2?.slipRetry));
  check('reason tells the admin', /needs admin/.test(t2?.reviewReason || ''), t2?.reviewReason);
  await cronAt(t2.createdAt + 30 * MIN);
  check('no scans after the last retry', slipCalls.get(m2) === 4);
  check('nothing credited', (await balanceOf(U2)) === 0);

  // ── 5: credited from another submission meanwhile ──
  console.log('\n5. Same slip already credited from a later submission');
  const m3a = '641930000000000001', m3b = '641930000000000002';
  const ref3 = '2026112400010000000000001';
  await sendSlip(U3, m3a); // bank not ready
  slips.set(m3a, { mode: 'ok', ref: ref3, amount: 500 });
  slips.set(m3b, { mode: 'ok', ref: ref3, amount: 500 });
  await sendSlip(U3, m3b); // player resent after the bank published it: credited now
  check('resend credited once', (await balanceOf(U3)) === 500);
  const t3 = await txOf(m3a);
  await cronAt(t3.createdAt + 2 * MIN);
  const t3b = await txOf(m3a);
  check('re-check does not credit again', (await balanceOf(U3)) === 500, `balance=${await balanceOf(U3)}`);
  check('marked as duplicate for the admin, retries stopped',
    t3b?.status === 'escalated' && /duplicate/.test(t3b.reviewReason || '') && t3b.slipRetry?.nextAt === undefined, JSON.stringify(t3b));

  // ── 6: admin approved by typing the amount before the re-check ──
  console.log('\n6. Admin settles it first');
  const m4 = '641930000000000004';
  const U4 = 'U0123456789abcdef0123456789abcde4';
  await sendSlip(U4, m4);
  const t4 = await txOf(m4);
  const appr = await rpc('adminApproveTransaction', [t4.id, 100]);
  check('admin approve ok', appr?.success === true, JSON.stringify(appr));
  slips.set(m4, { mode: 'ok', ref: '2026112400040000000000004', amount: 100 });
  await cronAt(t4.createdAt + 2 * MIN);
  check('re-check leaves an approved entry alone', (await balanceOf(U4)) === 100 && slipCalls.get(m4) === 1,
    `balance=${await balanceOf(U4)} calls=${slipCalls.get(m4)}`);

  // ── 7: guard failure is final ──
  console.log('\n7. Old slip is not retried');
  const m5 = '641930000000000005';
  const U5 = 'U0123456789abcdef0123456789abcde5';
  slips.set(m5, { mode: 'ok', ref: '2026112000050000000000005', amount: 100, dateTime: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
  await sendSlip(U5, m5);
  const t5 = await txOf(m5);
  check('held without a re-check', t5?.status === 'escalated' && !t5.slipRetry, JSON.stringify(t5));

  // ── 8: Bangkok Bank pending as an HTTP error ──
  console.log('\n8. Bangkok Bank "pending" error is retried');
  const m6 = '641930000000000006';
  const U6 = 'U0123456789abcdef0123456789abcde6';
  slips.set(m6, { mode: 'bblPending' });
  await sendSlip(U6, m6);
  const t6 = await txOf(m6);
  check('re-check scheduled', t6?.slipRetry?.nextAt > 0, JSON.stringify(t6));
  slips.set(m6, { mode: 'ok', ref: '2026112400060000000000006', amount: 500 });
  await cronAt(t6.createdAt + 2 * MIN);
  check('credited on re-check', (await balanceOf(U6)) === 500);
} catch (err) {
  fail++;
  console.error('harness error:', err);
} finally {
  await mf.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
