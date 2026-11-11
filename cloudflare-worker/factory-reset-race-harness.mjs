/**
 * Regression harness: player credit surviving a Factory Reset.
 *
 * THE BUG (seen live 2026-11-08)
 * ------------------------------
 * After a reset the console still listed players with their old balances, and
 * a player who messaged the bot got that balance back. getPlayersList, which
 * the console calls every few seconds, did a read-modify-write of
 * PLAYERS_LIST: it read the list, de-duplicated it, and saved it back when the
 * count changed (or rebuilt it from USER_ records when it was missing). A poll
 * that read the list just before the reset deleted it then wrote the whole
 * list, balances included, straight back. The reset deleted USER_ records but
 * the directory survived, and new profiles are restored from the directory.
 *
 * Seeded with a duplicated directory entry, as production had, so every poll
 * takes the write-back path.
 *
 * Run: node factory-reset-race-harness.mjs
 */

import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test_admin_key';
const GID = 'C0123456789abcdef0123456789abcdef';
const PIN = '583920';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'factory-reset-race-'));
const bundlePath = join(outDir, 'worker.mjs');
await build({
  entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'neutral',
  mainFields: ['module', 'main'], conditions: ['worker', 'browser'],
  external: ['cloudflare:workers'], outfile: bundlePath,
  banner: { js: `{ const __s=function(n){return this.get(this.idFromName(n));};
    Object.defineProperty(Object.prototype,'getByName',{value:__s,configurable:true,writable:true,enumerable:false}); }` },
  logLevel: 'error',
});

console.log('\nFACTORY RESET RACE HARNESS\n');

const ROUNDS = 6;
let survivedRounds = 0;
let restoredCredit = 0;
for (let round = 0; round < ROUNDS; round++) {
  const mf = new Miniflare({
    modules: true, scriptPath: bundlePath, modulesRoot: outDir,
    compatibilityDate: '2024-09-01', compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: { KV_CACHE: `rr-c-${round}`, KV_ORDERS: `rr-o-${round}` },
    durableObjects: { ROCKET_STATE: { className: 'RocketStateDO', useSQLite: true } },
    bindings: {
      ADMIN_API_KEY: ADMIN_KEY, SESSION_SECRET: 'test_session_secret_0123456789',
      LINE_CHANNEL_SECRET: 'x', LINE_CHANNEL_ACCESS_TOKEN: 't', ADMIN_USERNAME: 'admin', ENVIRONMENT: 'test',
    },
  });
  const kv = await mf.getKVNamespace('KV_CACHE');
  const players = Array.from({ length: 40 }, (_, i) => ({
    shortId: `PL${String(i).padStart(6, '0')}`,
    lineUserId: `U${String(i).padStart(32, 'f')}`,
    displayName: `P${i}`, balance: 5000, registeredAt: 1, updatedAt: 1,
  }));
  for (const p of players) {
    await kv.put(`USER_${p.lineUserId}`, JSON.stringify(p));
    await kv.put(`USER_${p.shortId}`, JSON.stringify(p));
    await kv.put(`RAW_LINE_${p.shortId}`, p.lineUserId);
  }
  const dir = players.map((p) => ({ id: p.shortId, ...p }));
  dir.push({ ...dir[0] }); // a duplicate, so every poll's de-dup changes the count
  await kv.put('PLAYERS_LIST', JSON.stringify(dir));
  await kv.put('ACTIVE_GROUP_ID', GID);

  const rpc = async (functionName, args = []) => {
    const res = await mf.dispatchFetch('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ functionName, args }),
    });
    return (await res.json())?.data;
  };
  await rpc('adminSetDangerPin', [PIN]);

  let polling = true;
  const pollers = Array.from({ length: 6 }, () => (async () => { while (polling) await rpc('getDashboardData', []); })());
  await new Promise((r) => setTimeout(r, 30));
  await rpc('resetGoogleSheetsDatabase', [PIN]);
  polling = false;
  await Promise.all(pollers);

  const dash = await rpc('getDashboardData', []);
  if ((dash?.players || []).length > 0) survivedRounds++;
  // A survivor's credit comes back when they next use the bot.
  await rpc('adminCreatePlayer', [players[1].lineUserId, 'P1', 0]);
  const again = await rpc('getDashboardData', []);
  const p1 = (again?.players || []).find((p) => p.lineUserId === players[1].lineUserId);
  if (p1 && p1.balance > 0) restoredCredit++;
  await mf.dispose();
}

check(`no player survives a reset under console polling (${ROUNDS} runs)`, survivedRounds === 0, `${survivedRounds}/${ROUNDS} runs kept players`);
check(`no old credit comes back for a returning player (${ROUNDS} runs)`, restoredCredit === 0, `${restoredCredit}/${ROUNDS} runs restored credit`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
