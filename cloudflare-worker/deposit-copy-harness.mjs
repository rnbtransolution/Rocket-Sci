/**
 * Regression harness for the deposit card copy button, 25 Nov 2026.
 *
 * The receiving account has no PromptPay, so no QR. Text inside a Flex card
 * cannot be long-pressed and copied, so the deposit cards carry a LINE
 * clipboard button that copies the account number as digits only.
 *
 *  1. Deposit card and typed-amount hint card both carry one clipboard button.
 *  2. clipboardText is digits only (dashes and spaces stripped).
 *  3. The number shown on the card keeps its dashes.
 *  4. Label fits LINE's 20-character button limit.
 *  5. A number with no digits gets no button (nothing useful to copy).
 *
 * Usage:  node deposit-copy-harness.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const outDir = mkdtempSync(join(tmpdir(), 'deposit-copy-harness-'));
const bundlePath = join(outDir, 'flex.mjs');
await build({
  entryPoints: ['src/flexTemplates.ts'],
  bundle: true, format: 'esm', platform: 'neutral', outfile: bundlePath, logLevel: 'error',
});
const { generateDepositFlex, generateTypedAmountHintFlex } = await import(pathToFileURL(bundlePath).href);

/** Every node in a Flex tree, depth first. */
const walk = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((c) => walk(c, out));
    else if (v && typeof v === 'object') walk(v, out);
  }
  return out;
};
const clipButtons = (card) => walk(card).filter((n) => n.type === 'button' && n.action?.type === 'clipboard');
const texts = (card) => walk(card).filter((n) => n.type === 'text').map((n) => n.text);

const bank = { bankName: 'กสิกรไทย (KBank)', accountNumber: '123-4-56789-0', accountName: 'ชื่อทดสอบ นามสกุลทดสอบ' };

for (const [name, card] of [
  ['deposit card', generateDepositFlex(bank)],
  ['typed-amount hint', generateTypedAmountHintFlex(bank)],
  ['deposit card with note', generateDepositFlex({ ...bank, note: 'โอนจากบัญชีชื่อตัวเองเท่านั้น' })],
]) {
  const btns = clipButtons(card);
  check(`${name}: exactly one copy button`, btns.length === 1, `found ${btns.length}`);
  check(`${name}: copies digits only`, btns[0]?.action.clipboardText === '1234567890', btns[0]?.action.clipboardText);
  check(`${name}: label within 20 chars`, (btns[0]?.action.label || '').length <= 20);
  check(`${name}: card still shows dashed number`, texts(card).includes('123-4-56789-0'));
}

check('spaces stripped too',
  clipButtons(generateDepositFlex({ ...bank, accountNumber: '123 4 56789 0' }))[0]?.action.clipboardText === '1234567890');
check('no digits -> no button',
  clipButtons(generateDepositFlex({ ...bank, accountNumber: 'ติดต่อแอดมิน' })).length === 0);

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
