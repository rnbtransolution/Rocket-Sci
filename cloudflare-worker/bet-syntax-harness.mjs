/**
 * Regression harness for the bet command syntax.
 *
 * THE PROBLEM
 * -----------
 * The quote card read "พิมพ์ ชล / ชถ (±5, ±10) ได้ทันที", which never showed that
 * the stake goes in the SAME message or that the offset goes in front of the
 * keyword. The rule guide listed keywords in one block and amounts in another,
 * so nothing on screen ever showed them combined. The parser did accept
 * "+10ชล500" all along — the syntax was simply undiscoverable.
 *
 * A second, sharper problem: the patterns were tested against the raw text, so
 * a thousands separator ("ชล1,000") failed to match and the message fell
 * through with no reply at all. That is how every other amount in this system is
 * written, so it had to accept them too.
 *
 * These are pure regex checks against the patterns as they appear in
 * queueHandler.ts, so a future edit to either the pattern or the normalisation
 * shows up here.
 *
 * Usage:  node bet-syntax-harness.mjs
 */

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const src = readFileSync('src/queueHandler.ts', 'utf8');

// Lift the two patterns out of the source so this tests the real thing rather
// than a transcription of it that could drift.
const betLine = src.match(/const betRegex = (\/.*\/[a-z]*);/);
const rangeLine = src.match(/const rangeBetRegex = (\/.*\/[a-z]*);/);
if (!betLine || !rangeLine) {
  console.error('  FAIL  could not locate betRegex / rangeBetRegex in queueHandler.ts');
  process.exit(1);
}
const betRegex = eval(betLine[1]);
const rangeBetRegex = eval(rangeLine[1]);

// The normalisation the handler applies before matching. Read from source so a
// change to it is picked up here rather than silently diverging.
const normalise = (t) => t.replace(/,/g, '');
const usesNormalisedText = /betRegex\.test\(betText\)/.test(src)
  && /replace\(\/,\/g, ''\)/.test(src);

check('handler matches against the comma-stripped text', usesNormalisedText);

/** Parse a command exactly as the handler does. */
function parse(raw) {
  const t = normalise(raw);
  const m = t.match(betRegex);
  if (m) return { kind: 'bet', offset: m[1] ?? null, cmd: m[2], amount: m[3] ?? null };
  const r = t.match(rangeBetRegex);
  if (r) return { kind: 'range', min: r[1], max: r[2], cmd: r[3], amount: r[4] ?? null };
  return { kind: 'none' };
}

console.log('BET SYNTAX HARNESS\n');

// ── The format from the bug report ──────────────────────────────────────────
console.log('REPORTED FORMAT — "+10ชล500"');
{
  const p = parse('+10ชล500');
  check('parses as a bet', p.kind === 'bet', JSON.stringify(p));
  check('offset is +10', p.offset === '+10', String(p.offset));
  check('side is ชล', p.cmd === 'ชล', String(p.cmd));
  check('amount is 500', p.amount === '500', String(p.amount));
}

// ── Every advertised example must actually work ─────────────────────────────
console.log('\nADVERTISED EXAMPLES — the cards now show these, so they must work');
for (const [input, offset, cmd, amount] of [
  ['+10ชล500', '+10', 'ชล', '500'],
  ['-5ชถ1,000', '-5', 'ชถ', '1000'],
  ['ชล500', null, 'ชล', '500'],
  ['+10ชย500', '+10', 'ชย', '500'],
]) {
  const p = parse(input);
  check(`"${input}" -> offset ${offset ?? 'none'}, side ${cmd}, amount ${amount}`,
    p.kind === 'bet' && p.offset === offset && p.cmd === cmd && p.amount === amount,
    JSON.stringify(p));
}

// ── Thousands separators must not break the command ─────────────────────────
console.log('\nTHOUSANDS SEPARATORS');
for (const [input, amount] of [['ชล1,000', '1000'], ['+10ชล1,000', '1000'], ['ชถ10,000', '10000']]) {
  const p = parse(input);
  check(`"${input}" parses to ${amount} points`, p.kind === 'bet' && p.amount === amount, JSON.stringify(p));
  check(`  "${input}" has no comma left in the amount`, p.amount !== null && !p.amount.includes(','), String(p.amount));
}

// ── Keyword-only forms (no stake) still work — the quick-bet path ───────────
console.log('\nKEYWORD-ONLY FORMS');
for (const [input, cmd] of [['ชล', 'ชล'], ['ถ', 'ถ'], ['+5ชล', 'ชล'], ['-5ชถ', 'ชถ'], ['ล', 'ล'], ['ต่ำ', 'ต่ำ'], ['สูง', 'สูง']]) {
  const p = parse(input);
  check(`"${input}" -> side ${cmd}, amount omitted`, p.kind === 'bet' && p.cmd === cmd && p.amount === null, JSON.stringify(p));
}

// ── Offsets: only +/-5 and +/-10 reach the handler; assert the shape ─────────
console.log('\nOFFSET SHAPE');
{
  const p = parse('+10ชล500');
  check('offset carries an explicit sign', p.offset.startsWith('+') || p.offset.startsWith('-'), String(p.offset));
  // The handler itself rejects anything outside {5,-5,10,-10}; assert the value
  // the player typed is recoverable as a signed integer.
  check('offset parses to an integer', Number.isInteger(parseInt(p.offset, 10)), String(p.offset));
}

// ── Custom range bets must not regress ─────────────────────────────────────
console.log('\nCUSTOM RANGE BETS');
for (const [input, min, max, cmd] of [
  ['300-350ล100', '300', '350', 'ล'],
  ['300-350 ล 100', '300', '350', 'ล'],
  ['350-400ชล500', '350', '400', 'ชล'],
]) {
  const p = parse(input);
  check(`"${input}" -> ${min}-${max} ${cmd}`, p.kind === 'range' && p.min === min && p.max === max && p.cmd === cmd, JSON.stringify(p));
}

// ── Non-commands must still be rejected, not swallowed ──────────────────────
console.log('\nNON-COMMANDS STILL REJECTED');
for (const input of ['เมนู', 'ฝาก', 'ถอน 500', 'กระดานดวล', 'hello']) {
  check(`"${input}" is not treated as a bet`, parse(input).kind === 'none', JSON.stringify(parse(input)));
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);