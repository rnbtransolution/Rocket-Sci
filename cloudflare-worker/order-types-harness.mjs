/**
 * Regression harness for the two order types and their lifecycles.
 *
 * THE RULES
 * ---------
 * [1] PRE-QUOTE. Placed before the admin announces the rocket price. It IS
 *     matchable immediately. When the admin sends the quote it is confirmed.
 *     If the admin never sends one, it is cancelled and BOTH parties refunded.
 *
 * [2] SELF-QUOTED. The player quotes their own range. It goes straight to
 *     matchable and stays valid even if the admin never sends a quote.
 *
 * The only event that refunds either type is the round being voided with no
 * rocket launch.
 *
 * THE BUGS THIS LOCKS DOWN
 * ------------------------
 *  * Pre-quote orders were NOT matchable — handleMatchOrder rejected
 *    pending_hold, and the order card hid its take-up buttons.
 *  * cancelHeldPreQuoteOrders only looked at the pending index for
 *    pending_hold, so a MATCHED pre-quote order was skipped entirely: neither
 *    side refunded, order left open, money held against nothing.
 *  * A matched pre-quote order was never given a real range when the quote
 *    arrived, so it could never be settled.
 *  * Settlement judged EVERY order against the round band, ignoring the range
 *    the player quoted for themselves.
 *
 * Usage:  node order-types-harness.mjs
 */

import ts from 'typescript';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const fx = readFileSync('src/flexTemplates.ts', 'utf8');
const fxJs = ts.transpileModule(fx, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const fxMod = await import('data:text/javascript;base64,' + Buffer.from(fxJs).toString('base64'));

const qh = readFileSync('src/queueHandler.ts', 'utf8');
const ix = readFileSync('src/index.ts', 'utf8');

const base = {
  creatorName: 'CREATOR', rocketName: 'Rocket', rangeMin: 330, rangeMax: 380,
  userTypedCmd: 'ชล500', isChotoy: false, groupId: 'G1',
};

function actions(card) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.action && n.action.text) out.push(n.action.text);
    if (n.header) walk(n.header);
    if (n.body) walk(n.body);
    if (Array.isArray(n.contents)) n.contents.forEach(walk);
  };
  walk(card.contents);
  return out;
}

console.log('ORDER TYPE LIFECYCLE HARNESS\n');

// ── [1] A pre-quote order must be matchable ────────────────────────────────
console.log('TYPE [1] PRE-QUOTE — matchable before the quote exists');
{
  const card = fxMod.generateOrderFlex({
    ...base, orderNumber: '7001', amount: 500, side: 'high',
    betType: 'pre_quote', status: 'pending_hold',
  });
  const acts = actions(card);
  const takes = acts.filter((t) => t.startsWith('ต '));
  check('card offers its take-up buttons', takes.length === 4, JSON.stringify(acts));
  check('cancel still offered', acts.includes('ยกเลิก 7001'));

  // The handler must accept a held pre-quote order rather than reject it.
  const acceptsHeld = /isPreQuoteHeld/.test(qh)
    && /order\.status !== 'pending_match' && !isPreQuoteHeld/.test(qh);
  check('handleMatchOrder accepts pending_hold pre-quote orders', acceptsHeld);
  check('held pre-quote is scoped to betType pre_quote (not any pending_hold)',
    /order\.status === 'pending_hold' && order\.betType === 'pre_quote'/.test(qh));
}

// ── [1] No quote -> BOTH parties refunded, even if already matched ────────
console.log('\nTYPE [1] NO QUOTE — cancel and refund both parties');
{
  const fn = qh.slice(qh.indexOf('export async function cancelHeldPreQuoteOrders'));
  const body = fn.slice(0, fn.indexOf('\nexport '));
  check('reads the MATCHED index too, not just pending',
    /getMatchedOrdersList/.test(body), 'a matched pre-quote order would be skipped');
  check('matches on betType, so a self-quoted order is never caught',
    /betType === 'pre_quote'/.test(body) && !/status === 'pending_hold' && o\.betType/.test(body));
  check('includes already-matched orders',
    /status !== 'pending_hold' && order\.status !== 'matched'/.test(body));
  check('refunds via the shared claim (both sides, exactly once)',
    /refundOrderOnce\(order, env, ctx, 'cancel_held_pre_quote'\)/.test(body));
  check('notifies BOTH creator and matcher',
    /matcherId!/.test(body) && /parties\.push/.test(body));
  check('rewrites the matched index so cancelled orders leave it',
    /MATCHED_ORDERS_LIST/.test(body));
}

// ── [1] Quote arrives -> a matched pre-quote order gets a real range ──────
console.log('\nTYPE [1] QUOTE ARRIVES — matched pre-quote orders get a range');
{
  const fn = qh.slice(qh.indexOf('export async function releaseHeldPreQuoteOrders'));
  const body = fn.slice(0, fn.indexOf('\nexport '));
  check('scans the matched index for pre-quote orders',
    /getMatchedOrdersList/.test(body));
  check('assigns rangeMin/rangeMax from the quoted band + offset',
    /order\.rangeMin = bandMin \+ offset/.test(body) && /order\.rangeMax = bandMax \+ offset/.test(body));
  // The confirmed-with-a-range loop must NOT rewrite betType: cancelHeldPre-
  // QuoteOrders keys off it to still find (and refund) pre-quote orders. Only
  // the pending_hold -> pending_match conversion changes it.
  const confirmLoop = body.slice(body.indexOf('const matchedPreQuote'));
  check('confirmed loop does not rewrite betType away from pre_quote',
    !/order\.betType =/.test(confirmLoop), confirmLoop.slice(0, 160));
  check('confirmed loop does not put a matched order back on the pending board',
    !/order\.status = 'pending_match'/.test(confirmLoop));
  check('reports how many matched pre-quotes were confirmed', /confirmedMatched/.test(body));
}

// ── [2] A self-quoted order must survive everything ───────────────────────
console.log('\nTYPE [2] SELF-QUOTED — valid with or without a quote');
{
  const card = fxMod.generateOrderFlex({
    ...base, orderNumber: '7002', amount: 500, side: 'low',
    betType: 'custom_range', status: 'pending_match', rangeMin: 300, rangeMax: 350,
  });
  const acts = actions(card);
  check('offers all four take-up buttons immediately', acts.filter((t) => t.startsWith('ต ')).length === 4, JSON.stringify(acts));

  const fn = qh.slice(qh.indexOf('export async function cancelHeldPreQuoteOrders'));
  const body = fn.slice(0, fn.indexOf('\nexport '));
  check('cancelHeldPreQuoteOrders keys off betType, so custom_range is untouched',
    /const isPreQuote = \(o: any\) => Boolean\(o\) && o\.betType === 'pre_quote'/.test(body));
}

// ── Settlement must honour each order's OWN range ─────────────────────────
console.log('\nSETTLEMENT — judged against the order\'s own quoted range');
{
  const fn = ix.slice(ix.indexOf("functionName === 'adminResolveBets'"));
  const body = fn.slice(0, 4000);
  check('reads the order\'s own rangeMin/rangeMax', /order\.rangeMin/.test(body));
  check('falls back to the round band only when the order has no range',
    /orderMin = [\s\S]{0,200}\? Number\(order\.rangeMin\)[\s\S]{0,80}: tMin/.test(body));
  check('compares against the ORDER range, not tMin/tMax directly',
    /finalSeconds < orderMin/.test(body) && /finalSeconds > orderMax/.test(body));
  check('no longer compares finalSeconds straight to tMin/tMax',
    !/finalSeconds < tMin/.test(body));
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);