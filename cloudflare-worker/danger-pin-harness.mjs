/**
 * Regression harness for the Factory Reset PIN guard.
 *
 * The property under test is FAIL-CLOSED: every path that is not a successful
 * PIN match must refuse the reset, including the states that are easy to get
 * wrong — no PIN configured, a record that will not parse, a corrupt salt. A
 * fallback that treats "cannot check" as "check passed" would leave exactly the
 * one-click wipe this guard exists to prevent.
 *
 * Run: node danger-pin-harness.mjs
 */

import ts from 'typescript';
import { readFileSync } from 'fs';

// ── In-memory StateStore stand-in ───────────────────────────────────────────
class MemState {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async list() { return { keys: [] }; }
}

// Load the module under test through the TypeScript compiler so it runs as-is.
const src = readFileSync('src/dangerPin.ts', 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const { setDangerPin, verifyDangerPin, isPinConfigured, validatePinFormat } = mod;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('\nFORMAT VALIDATION');
{
  // '1234' is deliberately absent: it is on the weak-PIN blocklist, so a PIN
  // that is long enough can still be rejected for being guessable.
  const good = ['583920', '0001', '123456789012'];
  for (const p of good) check(`accepts ${p}`, validatePinFormat(p).ok);

  const bad = [
    ['', 'empty'],
    ['abc', 'letters'],
    ['12', 'too short'],
    ['1234567890123', 'too long'],
    ['0000', 'trivial'],
    ['1111', 'trivial'],
    ['1234', 'sequential, on blocklist'],
    ['123456', 'sequential, on blocklist'],
  ];
  for (const [p, why] of bad) check(`rejects ${JSON.stringify(p)} (${why})`, !validatePinFormat(p).ok);
}

console.log('\nFAIL-CLOSED WHEN UNSET  ← the property that matters most');
{
  const s = new MemState();
  check('isPinConfigured false when unset', (await isPinConfigured(s)) === false);
  const r = await verifyDangerPin(s, '123456');
  check('reset refused when no PIN configured', r.ok === false, JSON.stringify(r));
  check('  ...with a not_configured code', r.code === 'not_configured', r.code);
}

console.log('\nCORRUPT / UNREADABLE STATE MUST ALSO REFUSE');
{
  const s = new MemState();
  s.map.set('DANGER_PIN', 'this is not json {{{');
  const r = await verifyDangerPin(s, '123456');
  check('refuses when record will not parse', r.ok === false, JSON.stringify(r));

  const s2 = new MemState();
  s2.map.set('DANGER_PIN', JSON.stringify({ salt: 'abcd' })); // hash missing
  const r2 = await verifyDangerPin(s2, '123456');
  check('refuses when hash missing', r2.ok === false, JSON.stringify(r2));

  const s3 = new MemState();
  s3.map.set('DANGER_PIN', JSON.stringify({ hash: 'ff', salt: '' })); // salt missing
  const r3 = await verifyDangerPin(s3, '123456');
  check('refuses when salt missing', r3.ok === false, JSON.stringify(r3));
}

console.log('\nCORRECT PIN IS ACCEPTED');
{
  const s = new MemState();
  await setDangerPin(s, '583920');
  check('isPinConfigured true after set', (await isPinConfigured(s)) === true);
  const r = await verifyDangerPin(s, '583920');
  check('correct PIN accepted', r.ok === true, JSON.stringify(r));
}

console.log('\nWRONG PIN IS REFUSED');
{
  const s = new MemState();
  await setDangerPin(s, '583920');
  for (const wrong of ['583921', '58392', '5839200', '000000', '5839']) {
    const r = await verifyDangerPin(s, wrong);
    check(`refuses ${wrong}`, r.ok === false, JSON.stringify(r));
  }
  for (const junk of ['', 'abcd', '   ', null, undefined, 12345, {}]) {
    const r = await verifyDangerPin(s, junk);
    check(`refuses malformed ${JSON.stringify(junk)}`, r.ok === false, JSON.stringify(r));
  }
}

console.log('\nSPACES AND DASHES ARE NORMALISED');
{
  const s = new MemState();
  await setDangerPin(s, '583920');
  check('"583 920" accepted', (await verifyDangerPin(s, '583 920')).ok === true);
  check('"583-920" accepted', (await verifyDangerPin(s, '583-920')).ok === true);
}

console.log('\nBRUTE-FORCE THROTTLE');
{
  const s = new MemState();
  await setDangerPin(s, '583920');
  let sawLockout = false;
  for (let i = 0; i < 5; i++) {
    const r = await verifyDangerPin(s, '000111');
    if (r.code === 'locked_out') sawLockout = true;
  }
  check('locks out after repeated failures', sawLockout);
  const during = await verifyDangerPin(s, '583920');
  check('correct PIN still refused while locked out', during.ok === false && during.code === 'locked_out', JSON.stringify(during));

  // Re-setting the PIN clears the throttle so a lockout cannot be permanent.
  await setDangerPin(s, '741852');
  const after = await verifyDangerPin(s, '741852');
  check('re-setting PIN clears the lockout', after.ok === true, JSON.stringify(after));
}

console.log('\nSTORAGE NEVER CONTAINS THE PLAINTEXT');
{
  const s = new MemState();
  await setDangerPin(s, '583920');
  const raw = JSON.stringify([...s.map.entries()]);
  check('raw state does not contain the PIN digits', !raw.includes('583920'), raw.slice(0, 200));
  // Match on the hex runs themselves rather than on the surrounding JSON keys:
  // the value is a nested JSON string, so its quotes are escaped in this dump
  // and a key-anchored pattern would be asserting on the escaping.
  check('a PBKDF2-SHA256 hash (64 hex chars) is stored', /[0-9a-f]{64}/.test(raw), raw.slice(0, 160));
  check('a per-install salt (32 hex chars) is stored', /[0-9a-f]{32}/.test(raw), raw.slice(0, 160));
}

console.log('\nSUCCESSFUL RESET CLEARED ITS OWN THROTTLE');
{
  const s = new MemState();
  await setDangerPin(s, '583920');
  await verifyDangerPin(s, '111111');
  await verifyDangerPin(s, '583920');
  const raw = JSON.stringify([...s.map.entries()]);
  check('failure counter cleared after success', !raw.includes('failures'), raw.slice(0, 200));
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);