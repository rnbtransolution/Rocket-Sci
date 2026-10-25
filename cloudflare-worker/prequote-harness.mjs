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
    } else if (n.type === 'image') {
      if (!/^https:\/\//.test(n.url || '')) errs.push(`${path}: image url must be https`);
      if (n.size && !/^(\d+px|\d+%|xxs|xs|sm|md|lg|xl|xxl|[3-5]xl|full)$/.test(n.size)) errs.push(`${path}: bad image size ${n.size}`);
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

// ── A held PRE-QUOTE order IS matchable before the quote exists ────────────
//
// Corrected rule: a pre-quote order can be matched straight away. It has no
// range until the admin announces the price, at which point it is confirmed;
// if no quote ever comes it is cancelled and both sides refunded. So the card
// must offer its take-up buttons exactly like a live order.
console.log('\nHELD PRE-QUOTE ORDER — matchable, so buttons are offered');
{
  const card = mod.generateOrderFlex({
    ...base, orderNumber: '2222', amount: 500, side: 'low',
    betType: 'pre_quote', status: 'pending_hold',
  });
  validate(card, 'held pre-quote card');
  const acts = actions(card);
  const takes = acts.filter((a) => a.text.startsWith('ต '));
  check('offers its take-up buttons', takes.length === 4, JSON.stringify(takes.map((t) => t.text)));
  check('cancel button still offered', acts.some((a) => a.text === 'ยกเลิก 2222'),
    JSON.stringify(acts.map((a) => a.text)));
  check('no longer shows a "waiting" notice that suppressed the buttons',
    !texts(card).some((t) => t.includes('รอประกาศราคา')));
}

// ── The match handler must accept a held pre-quote order ──────────────────
console.log('\nMATCH HANDLER — accepts held pre-quote, still refuses a real cancel');
{
  check('handleMatchOrder recognises a held pre-quote order', /isPreQuoteHeld/.test(qh));
  check('and allows it through the pending_match guard',
    /order\.status !== 'pending_match' && !isPreQuoteHeld/.test(qh));
  check('scoped to betType pre_quote, so any other pending_hold is still refused',
    /order\.status === 'pending_hold' && order\.betType === 'pre_quote'/.test(qh));
  check('a genuinely cancelled order still says so', /ถูกยกเลิกไปแล้ว/.test(qh));
  check('a matched order still says it has a partner', /มีคู่ดวลแล้ว/.test(qh));
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);