/**
 * ชตย (ช่างต่อยยกเลิก) lifecycle harness.
 *
 * Rule (owner, 11 Nov 2026): a self-opened range typed with ชตย is cancelled
 * when the ช่าง announces a price, and BOTH sides get their full stake back,
 * matched or not. Before this the Worker could not read ชตย at all: the
 * examples on the rule card ("300-350ล500 ชตย") were ignored with no reply.
 *
 * Usage:  node chotoy-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const CREATED_AT = 1750000000000;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'chotoy-harness-'));
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

const players = [1, 2, 3, 4].map((n) => ({
  shortId: `PL00000${n}`, lineUserId: `Uaaaaa000000000${n}`, name: `PLAYER ${n}`,
}));
const [P1, P2, P3, P4] = players;

console.log('ชตย HARNESS\n');

const mf = new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: 'ct-cache', KV_ORDERS: 'ct-orders' },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
  },
});

const kvC = await mf.getKVNamespace('KV_CACHE');
const prof = (p, bal) => JSON.stringify({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: CREATED_AT, updatedAt: CREATED_AT });
for (const p of players) {
  await kvC.put(`USER_${p.lineUserId}`, prof(p, 1000));
  await kvC.put(`USER_${p.shortId}`, prof(p, 1000));
  await kvC.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
}
await kvC.put('PLAYERS_LIST', JSON.stringify(players.map((p) => ({ id: p.shortId, shortId: p.shortId, lineUserId: p.lineUserId, name: p.name, balance: 1000 }))));
await kvC.put('ACTIVE_GROUP_ID', 'C00000000000000000000000000000001');
await kvC.put('ACTIVE_ROUND', JSON.stringify({
  roundId: 'R_TEST_1', name: 'บั้งไฟทดสอบ', targetMin: 330, targetMax: 380,
  status: 'ACTIVE', isChotoy: false, quoteReleased: false, updatedAt: CREATED_AT,
}));

const rpc = async (functionName, args = []) => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  });
  const j = await res.json();
  return j?.data || j;
};
const say = (p, text) => rpc('simulateTextMessageFromDashboard', [text, p.lineUserId]);
const settle = () => new Promise((r) => setTimeout(r, 300));
const dash = async () => { await settle(); return rpc('getDashboardData'); };
const bal = (d, p) => Number((d.players || []).find((x) => x.id === p.shortId || x.shortId === p.shortId)?.balance);
const findBet = (d, pred) => (d.bets || []).find(pred);

// ── Before the price: ชตย orders open, with or without a space ─────────────
console.log('BEFORE THE PRICE');
await say(P1, '300-350ล500 ชตย');
let d = await dash();
const o1 = findBet(d, (b) => b.creatorId === P1.shortId);
check('"300-350ล500 ชตย" opens an order', Boolean(o1), JSON.stringify(d.bets));
check('  it is marked ชตย', o1?.isChotoy === true, JSON.stringify(o1));
check('  it is a high-side custom range 300-350', o1?.side === 'high' && o1?.betType === 'custom_range' && o1?.rangeMin === 300 && o1?.rangeMax === 350);
check('  P1 debited 500', bal(d, P1) === 500, `got ${bal(d, P1)}`);

await say(P2, `ต ${o1?.orderNumber}`);
d = await dash();
check('P2 takes it (P2 debited 500)', bal(d, P2) === 500, `got ${bal(d, P2)}`);

await say(P3, '350-400ถ300ชตย');
await say(P4, '300-350ล200');
d = await dash();
const o3 = findBet(d, (b) => b.creatorId === P3.shortId);
const o4 = findBet(d, (b) => b.creatorId === P4.shortId);
check('"350-400ถ300ชตย" (no space) opens a ชตย low order', o3?.isChotoy === true && o3?.side === 'low', JSON.stringify(o3));
check('plain "300-350ล200" is NOT ชตย', o4 && !o4.isChotoy, JSON.stringify(o4));
check('P3 at 700, P4 at 800', bal(d, P3) === 700 && bal(d, P4) === 800, `${bal(d, P3)} / ${bal(d, P4)}`);

// ── The ช่าง prices the rocket ─────────────────────────────────────────────
console.log('\nTHE ช่าง ANNOUNCES 330-380');
const q = await rpc('adminBroadcastQuote', ['ALL', 'บั้งไฟทดสอบ', 330, 380, false]);
const cancelled = q.chotoyCancelled || [];
check('both ชตย orders reported cancelled', cancelled.length === 2 && cancelled.includes(o1?.orderNumber) && cancelled.includes(o3?.orderNumber), JSON.stringify(cancelled));
d = await dash();
check('P1 (matched creator) refunded to 1000', bal(d, P1) === 1000, `got ${bal(d, P1)}`);
check('P2 (matched taker) refunded to 1000', bal(d, P2) === 1000, `got ${bal(d, P2)}`);
check('P3 (unmatched ชตย) refunded to 1000', bal(d, P3) === 1000, `got ${bal(d, P3)}`);
check('P4 (plain range) untouched at 800', bal(d, P4) === 800, `got ${bal(d, P4)}`);
check('P4 order still on the board', Boolean(findBet(d, (b) => b.orderNumber === o4?.orderNumber)));
check('no ชตย order left on the board', !(d.bets || []).some((b) => b.isChotoy));

// A second (corrected) quote must not refund anything twice.
await rpc('adminBroadcastQuote', ['ALL', 'บั้งไฟทดสอบ', 335, 385, false]);
d = await dash();
check('re-quote refunds nothing twice', bal(d, P1) === 1000 && bal(d, P2) === 1000 && bal(d, P3) === 1000, `${bal(d, P1)} ${bal(d, P2)} ${bal(d, P3)}`);

// ── After the price: ชตย is refused, nothing debited ────────────────────────
console.log('\nAFTER THE PRICE');
await say(P1, '300-350ล500 ชตย');
await say(P1, 'ชล500 ชตย');
await say(P2, 'ยัง');
await say(P2, 'ลง');
d = await dash();
check('late ชตย order refused, P1 still 1000', bal(d, P1) === 1000 && !findBet(d, (b) => b.creatorId === P1.shortId), `got ${bal(d, P1)}`);
check('bare "ยัง" / "ลง" open nothing, P2 still 1000', bal(d, P2) === 1000 && !findBet(d, (b) => b.creatorId === P2.shortId), `got ${bal(d, P2)}`);

await say(P2, 'ลง300');
d = await dash();
const o5 = findBet(d, (b) => b.creatorId === P2.shortId);
check('"ลง300" opens a high quote order', o5?.side === 'high' && o5?.amount === 300, JSON.stringify(o5));

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
await mf.dispose();
try { rmSync(outDir, { recursive: true }); } catch (_) {}
if (fail > 0) process.exit(1);
