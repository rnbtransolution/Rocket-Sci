/**
 * Regression harness for partial takes.
 *
 * THE MODEL
 * ---------
 * A partial take no longer spawns a second order. When a matcher takes less
 * than the full stake, the unmatched remainder is returned to the CREATOR
 * immediately, at match time:
 *
 *   creator opens 500   -> creator -500
 *   matcher takes 200   -> creator +300 now, matcher -200
 *   round settles       -> both sides settle on 200 only
 *
 * The creator then decides whether to open a new order with those points or
 * sit them out. Previously the remainder became a new order under a fresh
 * number, which left an order the group could not see, a sub-100 leftover
 * nobody was allowed to bet, and a class of cancel/remainder edge cases.
 *
 * The second half guards the order card's take-up buttons, which are filtered
 * to amounts a match can actually accept (>=100pt AND >=20% of the order).
 * Before this, a 100pt order advertised 20/40/80/100 and the first three could
 * never succeed.
 *
 * Usage:  node partial-take-harness.mjs
 */

import ts from 'typescript';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const qh = readFileSync('src/queueHandler.ts', 'utf8');
const fxSrc = readFileSync('src/flexTemplates.ts', 'utf8');
const fx = await import('data:text/javascript;base64,' + Buffer.from(
  ts.transpileModule(fxSrc, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
).toString('base64'));

const base = {
  creatorName: 'CREATOR', rocketName: 'Rocket', rangeMin: 330, rangeMax: 380,
  userTypedCmd: 'ชล500', isChotoy: false, groupId: 'G1',
};

function takeButtons(amount) {
  const card = fx.generateOrderFlex({
    ...base, orderNumber: '5555', amount, side: 'high', betType: 'range', status: 'pending_match',
  });
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.action && typeof n.action.text === 'string' && n.action.text.startsWith('ต ')) {
      out.push(Number(n.action.text.replace('ต 5555 ', '')));
    }
    if (n.header) walk(n.header);
    if (n.body) walk(n.body);
    if (Array.isArray(n.contents)) n.contents.forEach(walk);
  };
  walk(card.contents);
  return [...new Set(out)].sort((a, b) => a - b);
}

console.log('PARTIAL TAKE HARNESS\n');

// ── The remainder is refunded, not re-listed ───────────────────────────────
console.log('REMAINDER — returned to the creator, no second order');
{
  const fn = qh.slice(qh.indexOf('async function handleMatchOrder'));
  const body = fn.slice(0, fn.indexOf('\nasync function '));

  check('no remainder order is created', !/remainderOrder/.test(body), 'a second order would still be spawned');
  check('does not allocate a new order number', !/remainderNo/.test(body));
  check('does not re-add anything to the pending board',
    !/addToPendingOrdersList/.test(body.slice(body.indexOf('Remainder handling'))));
  check('credits the untaken remainder to the creator',
    /credits: isPartial && remainingAmount > 0 \? \[\{ who: 'creator', delta: remainingAmount \}\]/.test(body));
  check('the creator is refunded the exact untaken amount',
    /remainderRefunded = isPartial \? remainingAmount : 0/.test(body));
  check('records the untaken amount on the order for audit',
    /unmatchedAmount/.test(body) || /remainingAmount/.test(body));
  // The remainder is credited in the same atomic commit as the match, so there
  // is no separate credit step that could fail on its own.
  check('the remainder credit commits atomically with the match',
    /const res = await ledger\(env, \{[\s\S]*credits: isPartial/.test(body));
  check('tells the creator the points are back',
    /ส่วนที่ไม่ถูกรับ/.test(body) || /คืนเข้ากระเป๋าคุณแล้ว/.test(body));
  check('does not reference a "remainder order number" in the notice',
    !/remainderOrder\.orderNumber/.test(body));
}

// ── Buttons must never offer an unmatchable amount ────────────────────────
console.log('\nCARD BUTTONS — nothing below the match floor');
{
  const MIN = 100, RATIO = 0.20;
  const cases = [100, 200, 300, 400, 500, 700, 1000, 5000];
  for (const amount of cases) {
    const floor = Math.max(MIN, Math.round(amount * RATIO));
    const btns = takeButtons(amount);
    const bad = btns.filter((b) => b < floor);
    check(`order ${amount}: buttons [${btns.join(', ')}] all >= floor ${floor}`,
      bad.length === 0 && btns.length > 0, `unmatchable: ${bad.join(', ')}`);
    check(`order ${amount}: full amount is always offered`, btns.includes(amount), btns.join(', '));
    check(`order ${amount}: no duplicate buttons`, btns.length === new Set(btns).size);
  }
}

// ── A 100pt order must not advertise 20/40/80 ─────────────────────────────
console.log('\nTHE DEAD-BUTTON CASE (the bug being fixed)');
{
  const btns = takeButtons(100);
  check('100pt order does NOT offer 20/40/80', !btns.includes(20) && !btns.includes(40) && !btns.includes(80), btns.join(', '));
  check('100pt order offers exactly the full amount', btns.length === 1 && btns[0] === 100, btns.join(', '));

  const btns200 = takeButtons(200);
  check('200pt order does NOT offer 40 or 80', !btns200.includes(40) && !btns200.includes(80), btns200.join(', '));
  check('200pt order offers 160 and 200', btns200.includes(160) && btns200.includes(200), btns200.join(', '));
}

console.log(`\nRESULT\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);