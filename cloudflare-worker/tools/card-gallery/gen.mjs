/**
 * Card gallery generator (the "Bangfai Commander LINE Cards" page).
 *
 * The gallery page holds each card as LINE Flex JSON on one line
 * (`const CARDS = [...]`) and draws it with a small renderer. This script
 * takes the live page, rebuilds the cards below from src/flexTemplates.ts,
 * and writes the updated page:
 *
 *   node tools/card-gallery/gen.mjs <live page.html> <out.html>
 *
 * Cards with sample data here are rebuilt from the real generators. Any
 * other card is kept as it is on the live page. Before replacing a card,
 * the script checks that the old one matches the new output apart from the
 * known change (EXPECTED_DIFF), so a sample that drifted shows up.
 * The Quick Reply row (`const QR = [...]`) comes from mainMenuQuickReplyItems().
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , livePath, outPath] = process.argv;
if (!livePath || !outPath) {
  console.error('usage: node tools/card-gallery/gen.mjs <live page.html> <out.html>');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'card-gallery-'));
const bundle = join(tmp, 'ft.mjs');
await build({
  entryPoints: [join(root, 'src', 'flexTemplates.ts')],
  bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'error',
});
const ft = await import(bundle);
rmSync(tmp, { recursive: true, force: true });
ft.setPublicBaseUrl('https://rocket-science-cf-worker.rnbtransolution.workers.dev', '');

// ── Sample data (same names and numbers as the rest of the gallery) ──────────
const board = [
  ['4802', 500, 'high', 'ITT (อิท)'],
  ['4839', 1000, 'low', 'A-K'],
  ['4876', 300, 'high', 'ปลาทู'],
  ['4913', 2000, 'low', 'สมชาย'],
  ['4950', 200, 'high', 'Nok'],
  ['4987', 800, 'low', 'บอย'],
].map(([orderNumber, amount, side, creatorName]) => ({
  orderNumber, amount, side, creatorName, rangeMin: 330, rangeMax: 380, status: 'pending_match',
}));

const ambiguousNo = '4802';
const ambiguous = ft.generateNoticeFlex(
  `แผล #${ambiguousNo} ปิดไปแล้ว`,
  `ถ้าต้องการรับดวล ${parseInt(ambiguousNo, 10).toLocaleString()} แต้มจากแผลล่าสุด พิมพ์ "ต ${ambiguousNo} แต้ม"`,
  'warning',
  'พิมพ์ "กระดานดวล" เพื่อดูแผลที่ยังว่าง'
);

/** name → { where, build, rename?, expectedDiff?, after? } */
const CARD_SPECS = {
  'กระดานดวล': {
    where: 'กลุ่ม',
    build: () => ft.generatePendingBoardFlex(board),
    // 21 Nov: the accept button sends "ต #NNNN" instead of "ต NNNN".
    expectedDiff: (s) => s.replace(/"text":"ต #(\d{4})"/g, '"text":"ต $1"'),
  },
  'จับคู่ไม่สำเร็จ': {
    rename: 'จับคู่ไม่สำเร็จ (กดในกลุ่ม: ส่งครั้งเดียวต่อแผล)',
  },
  'แผลปิดแล้ว (กดการ์ดกระดานเก่า)': {
    where: 'DM',
    build: () => ambiguous,
    after: 'จับคู่ไม่สำเร็จ',
  },
};

// ── Rebuild ─────────────────────────────────────────────────────────────────
const html = readFileSync(livePath, 'utf8');
const lines = html.split('\n');
const cardsIdx = lines.findIndex((l) => l.startsWith('const CARDS = '));
const qrIdx = lines.findIndex((l) => l.startsWith('const QR = '));
if (cardsIdx < 0 || qrIdx < 0) throw new Error('CARDS or QR line not found in the live page');

const cards = JSON.parse(lines[cardsIdx].slice('const CARDS = '.length).replace(/;\s*$/, ''));
const originalNames = cards.map((c) => c.name);
const flexToCard = (where, name, msg) => ({ where, name, altText: msg.altText, contents: msg.contents });

for (const [name, spec] of Object.entries(CARD_SPECS)) {
  const i = cards.findIndex((c) => c.name === name || c.name === spec.rename);
  if (spec.build && i >= 0) {
    const fresh = flexToCard(spec.where, cards[i].name, spec.build());
    const a = JSON.stringify(cards[i]);
    const b = (spec.expectedDiff || ((s) => s))(JSON.stringify(fresh));
    if (a !== b && JSON.stringify(cards[i]) !== JSON.stringify(fresh)) {
      throw new Error(`"${name}": the live card differs from the code beyond the expected change; check the sample data`);
    }
    cards[i] = fresh;
    console.log(`rebuilt   ${name}`);
  } else if (spec.build) {
    const at = spec.after ? cards.findIndex((c) => c.name === spec.after || c.name === CARD_SPECS[spec.after]?.rename) : -1;
    const card = flexToCard(spec.where, name, spec.build());
    if (at >= 0) cards.splice(at + 1, 0, card); else cards.push(card);
    console.log(`added     ${name}`);
  }
  if (spec.rename && i >= 0 && cards[i].name !== spec.rename) {
    cards[i].name = spec.rename;
    console.log(`renamed   ${name} → ${spec.rename}`);
  }
}

lines[cardsIdx] = `const CARDS = ${JSON.stringify(cards)};`;
lines[qrIdx] = `const QR = ${JSON.stringify(ft.mainMenuQuickReplyItems().map((q) => q.action.label))};`;
writeFileSync(outPath, lines.join('\n'));
console.log(`${originalNames.length} → ${cards.length} cards, written to ${outPath}`);
