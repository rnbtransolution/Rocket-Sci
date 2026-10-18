/**
 * Regression harness for pre-quote (pending_hold) order cards and matching.
 *
 * THE BUG
 * -------
 * Creating an order before the rocket price is announced parks it as
 * `pending_hold`. It is not matchable until the quote is released. But the
 * order card still rendered the take-up buttons (20/40/80/100%), and tapping
 * one reached handleMatchOrder, which rejected anything not `pending_match`
 * via a two-way ternary that reported every such status as "cancelled".
 *
 * Net effect: the card invited a tap that could only produce a confident lie.
 * Production evidence, 7 seconds apart:
 *
 *   07:46:43  ITT        +10ชล500      -> order #5656 created pending_hold
 *   07:46:51  😊😊😊      ต 5656 400      -> told "this order was cancelled"
 *
 * Usage:  node prequote-harness.mjs
 */

import ts from 'typescript';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const src = readFileSync('src/flexTemplates.ts', 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const qh = readFileSync('src/queueHandler.ts', 'utf8');

const base = {
  creatorName: 'CREATOR', rocketName: 'Rocket', rangeMin: 330, rangeMax: 380,
  userTypedCmd: '+10ชล500', isChotoy: false, groupId: 'G1',
};

/** Every tappable action on a card, as "text it would send". */
function actions(card) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.action && n.action.text) out.push({ type: n.action.type, text: n.action.text, label: n.action.label });
    // A bubble nests header/body rather than a contents array; descending only
    // into `contents` would stop at the bubble and find nothing.
    if (n.header) walk(n.header);
    if (n.body) walk(n.body);
    if (Array.isArray(n.contents)) n.contents.forEach(walk);
  };
  walk(card.contents);
  return out;
}

function texts(card) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    if (n.header) walk(n.header);
    if (n.body) walk(n.body);
    if (Array.isArray(n.contents)) n.contents.forEach(walk);
  };
  walk(card.contents);
  return out;
}

// ── Schema sanity, so a malformed card is caught here ───────────────────────
const VALID_SIZE = new Set(['xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl']);
function validate(card, label) {
  const errs = [];
  const walk = (n, path) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text') {
      if (typeof n.text !== 'string') errs.push(`${path}: text without string`);
      if (n.size && !VALID_SIZE.has(n.size)) errs.push(`${path}: bad size ${n.size}`);
    } else if (n.type === 'box') {
      if (!['vertical', 'horizontal', 'baseline'].includes(n.layout)) errs.push(`${path}: bad layout ${n.layout}`);
      if (!Array.isArray(n.contents) || !n.contents.length) errs.push(`${path}: empty box`);
      (n.contents || []).forEach((c, i) => walk(c, `${path}[${i}]`));
    } else if (n.type === 'separator') {
      // valid leaf
    } else if (n.type === 'bubble') {
      if (n.header) walk(n.header, `${path}.header`);
      if (n.body) walk(n.body, `${path}.body`);
    } else {
      errs.push(`${path}: unknown type ${n.type}`);
    }
  };
  walk(card.contents, 'root');
  check(`${label} is a valid Flex bubble`, errs.length === 0, errs.join('; '));
}

console.log('PRE-QUOTE ORDER CARD HARNESS\n');

// ── A live (pending_match) order still offers its take buttons ──────────────
console.log('LIVE ORDER — take-up buttons present');
{
  const card = mod.generateOrderFlex({
    ...base, orderNumber: '1111', amount: 500, side: 'low',
    betType: 'range', status: 'pending_match',
  });
  validate(card, 'live order card');
  const acts = actions(card);
  const takes = acts.filter((a) => a.text.startsWith('ต '));
  check('offers the 4 take-up buttons', takes.length === 4, JSON.stringify(takes.map((t) => t.text)));
  check('take amounts are 100/200/400/500',
    JSON.stringify(takes.map((t) => t.text.replace('ต 1111 ', ''))) === JSON.stringify(['100', '200', '400', '500']),
    JSON.stringify(takes.map((t) => t.text)));
  check('cancel button still offered', acts.some((a) => a.text === 'ยกเลิก 1111'));
  check('no "awaiting quote" notice', !texts(card).some((t) => t.includes('รอประกาศราคา')));
}

// ── A held order must NOT invite a match ───────────────────────────────────
console.log('\nHELD ORDER (pending_hold) — no take-up buttons');
{
  const card = mod.generateOrderFlex({
    ...base, orderNumber: '2222', amount: 500, side: 'low',
    betType: 'pre_quote', status: 'pending_hold',
  });
  validate(card, 'held order card');
  const acts = actions(card);
  const takes = acts.filter((a) => a.text.startsWith('ต '));
  check('offers NO take-up buttons', takes.length === 0, JSON.stringify(takes.map((t) => t.text)));
  check('cancel button still offered', acts.some((a) => a.text === 'ยกเลิก 2222'),
    JSON.stringify(acts.map((a) => a.text)));
  check('says it is waiting for the quote', texts(card).some((t) => t.includes('รอประกาศราคา')),
    JSON.stringify(texts(card)));
}

// ── The status message must not call a held order cancelled ────────────────
console.log('\nMATCH-REJECTION MESSAGES');
{
  // The old code was: status === 'matched' ? 'has a partner' : 'has been cancelled'
  const hasHoldBranch = /order\.status === 'pending_hold'/.test(qh);
  check('handleMatchOrder handles pending_hold explicitly', hasHoldBranch);
  check('pending_hold no longer falls into the cancelled branch',
    /รอประกาศราคาช่าง/.test(qh));
  // And the cancelled wording must still exist, for orders that really are.
  check('a genuinely cancelled order still says so', /ถูกยกเลิกไปแล้ว/.test(qh));
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);