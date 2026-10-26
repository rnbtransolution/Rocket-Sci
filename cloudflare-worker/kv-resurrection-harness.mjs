/**
 * Regression harness: data deleted from the Durable Object stays deleted,
 * even while the KV mirror still serves the old value.
 *
 * THE BUG (production, 2026-10-26)
 * --------------------------------
 * The admin set ITT's balance to 1,000, then ran Factory Reset. Afterwards ITT
 * was back with 1,000 — but the ADMIN_ADJUST transaction that explained it was
 * gone. Reads used to adopt the KV value whenever the DO missed (a KV → DO
 * migration aid). Factory Reset deletes from the DO and then from KV, but KV
 * keeps serving a deleted value for up to a minute, so the console's next poll
 * missed in the DO, read the stale KV copy, and wrote it back: players
 * "bounced back" after every reset, holding balances with no ledger entry.
 *
 * ASSERTED HERE
 *  * after Factory Reset, a stale KV copy of players / profiles / orders /
 *    in-flight rounds does NOT come back, through any read path;
 *  * the same player messaging again starts from a fresh 0-balance profile;
 *  * a brand-new DO still copies every lasting KV key once at its first boot
 *    (players, orders, settings, admin credentials), skipping TTL'd keys.
 *
 * Usage:  node kv-resurrection-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const PIN = '7391';
const NOW = Date.now();

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'kvres-harness-'));
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

const boot = (label) => new Miniflare({
  modules: true, scriptPath: bundlePath, modulesRoot: outDir,
  compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: { KV_CACHE: `kr-c-${label}`, KV_ORDERS: `kr-o-${label}` },
  durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
  outboundService: () => new Response('{}', { status: 200 }),
  bindings: {
    ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
    ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
  },
});
const rpcOf = (mf) => async (functionName, args = []) => {
  const res = await mf.dispatchFetch('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ functionName, args }),
  });
  return (await res.json().catch(() => null))?.data;
};

const ITT = { shortId: 'PLC266BD', lineUserId: 'Uaaaaaaaaaaaaaaaaaaaaaaaaac266bd', name: 'ITT' };
const prof = (p, bal) => ({ shortId: p.shortId, lineUserId: p.lineUserId, displayName: p.name, balance: bal, registeredAt: NOW, updatedAt: NOW });

console.log('KV RESURRECTION HARNESS\n');

// ── [1] The production sequence ───────────────────────────────────────────
console.log('[1] Adjust a balance, Factory Reset, KV still stale');
{
  const mf = boot('reset');
  const rpc = rpcOf(mf);
  const kvC = await mf.getKVNamespace('KV_CACHE');
  const kvO = await mf.getKVNamespace('KV_ORDERS');

  // A registered player the admin tops up to 1,000.
  await kvC.put(`USER_${ITT.lineUserId}`, JSON.stringify(prof(ITT, 0)));
  await kvC.put(`USER_${ITT.shortId}`, JSON.stringify(prof(ITT, 0)));
  await kvC.put(`RAW_LINE_${ITT.shortId}`, ITT.lineUserId);
  await kvC.put('PLAYERS_LIST', JSON.stringify([prof(ITT, 0)]));
  await rpc('adminSetDangerPin', [PIN]);
  await rpc('adminSetPlayerBalance', [ITT.shortId, 1000, ITT.name]);
  let dash = await rpc('getDashboardData', ['full']);
  check('before reset: ITT holds 1,000 with its ADMIN_ADJUST entry',
    dash?.players?.[0]?.balance === 1000 && dash?.transactions?.some((t) => t.slipRef === 'ADMIN_ADJUST'));

  // Snapshot what the KV mirror holds right now, then reset.
  const stale = {};
  for (const k of ['PLAYERS_LIST', `USER_${ITT.lineUserId}`, `USER_${ITT.shortId}`, `RAW_LINE_${ITT.shortId}`, 'TRANSACTIONS_LIST']) {
    stale[k] = await kvC.get(k);
  }
  const reset = await rpc('resetGoogleSheetsDatabase', [PIN]);
  check('Factory Reset succeeds', reset && reset.success !== false, JSON.stringify(reset));

  // KV is eventually consistent: for up to a minute other locations still
  // serve the old values. Put them back to model exactly that window.
  for (const [k, v] of Object.entries(stale)) if (v !== null) await kvC.put(k, v);
  await kvO.put('ORDER_9999', JSON.stringify({ orderNumber: '9999', status: 'matched', amount: 500, creatorId: ITT.shortId }));
  await kvC.put('IN_FLIGHT_ROUNDS', JSON.stringify([{ roundId: 'FLT_OLD', name: 'OLD', matchedOrders: [] }]));

  // Every read path the console and the bot use, several times over.
  for (let i = 0; i < 3; i++) dash = await rpc('getDashboardData', ['full']);
  check('players do NOT bounce back', (dash?.players || []).length === 0, JSON.stringify(dash?.players));
  check('no balance without a ledger entry', !(dash?.players || []).some((p) => p.balance > 0) && (dash?.transactions || []).length === 0);
  check('in-flight rounds do NOT bounce back', (dash?.inFlightRounds || []).length === 0, JSON.stringify(dash?.inFlightRounds));

  const ns = await mf.getDurableObjectNamespace('ROCKET_STATE');
  const stub = ns.get(ns.idFromName('rocket-global-state'));
  const [user, raw, order] = await stub.multi([`USER_${ITT.lineUserId}`, `RAW_LINE_${ITT.shortId}`, 'ORDER_9999']);
  check('DO holds no profile for ITT', user === null && raw === null);
  // getOrder used to adopt KV_ORDERS on a miss; "ต 9999" looks the order up.
  await rpc('simulateTextMessageFromDashboard', ['ต 9999', 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'MATCHER']);
  const [orderAfter] = await stub.multi(['ORDER_9999']);
  check('a stale KV order is not adopted into the DO', order === null && orderAfter === null, orderAfter);

  // ITT messages the bot again: a fresh profile at 0, not the old 1,000.
  await rpc('simulateTextMessageFromDashboard', ['เช็คยอด', ITT.lineUserId, ITT.name]);
  dash = await rpc('getDashboardData', ['full']);
  const again = (dash?.players || []).find((p) => p.lineUserId === ITT.lineUserId);
  check('returning player starts from 0', !again || again.balance === 0, JSON.stringify(again));

  await mf.dispose();
}

// ── [2] A brand-new DO still migrates KV once ─────────────────────────────
console.log('\n[2] First boot copies every lasting KV key once');
{
  const mf = boot('boot');
  const kvC = await mf.getKVNamespace('KV_CACHE');
  const kvO = await mf.getKVNamespace('KV_ORDERS');
  await kvC.put(`USER_${ITT.lineUserId}`, JSON.stringify(prof(ITT, 750)));
  await kvC.put(`USER_${ITT.shortId}`, JSON.stringify(prof(ITT, 750)));
  await kvC.put(`RAW_LINE_${ITT.shortId}`, ITT.lineUserId);
  await kvC.put('PLAYERS_LIST', JSON.stringify([prof(ITT, 750)]));
  await kvC.put('PAYMENT_BANK', JSON.stringify({ bankName: 'X' }));
  await kvC.put('ADMIN_CRED_admin', JSON.stringify({ hash: 'h', salt: 's' }));
  await kvC.put('RATELIMIT_tmp', '1', { expirationTtl: 600 });
  await kvO.put('ORDER_4242', JSON.stringify({ orderNumber: '4242', status: 'settled' }));

  const ns = await mf.getDurableObjectNamespace('ROCKET_STATE');
  const stub = ns.get(ns.idFromName('rocket-global-state'));
  const [u, list, bank, cred, ord, rl] = await stub.multi([
    `USER_${ITT.lineUserId}`, 'PLAYERS_LIST', 'PAYMENT_BANK', 'ADMIN_CRED_admin', 'ORDER_4242', 'RATELIMIT_tmp',
  ]);
  check('player profile copied', JSON.parse(u || 'null')?.balance === 750);
  check('player directory copied', JSON.parse(list || '[]').length === 1);
  check('settings copied (PAYMENT_BANK)', bank !== null);
  check('admin credentials copied', cred !== null);
  check('orders copied from KV_ORDERS', JSON.parse(ord || 'null')?.status === 'settled');
  check('TTL\'d bookkeeping skipped', rl === null);

  // Writing to KV after the first boot changes nothing in the DO.
  await kvC.put('PAYMENT_BANK', JSON.stringify({ bankName: 'LATE' }));
  const [bankAfter] = await stub.multi(['PAYMENT_BANK']);
  check('no further KV reads after boot', JSON.parse(bankAfter).bankName === 'X', bankAfter);
  await mf.dispose();
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
