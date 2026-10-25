/**
 * Regression harness for the daily summary card on a busy day.
 *
 * THE BUG
 * -------
 * A LINE carousel holds at most 12 bubbles, and the summary kept the FIRST 12
 * rounds of the day. A 13th rocket and later were dropped without a word — the
 * group never saw the day's newest results.
 *
 * ASSERTED HERE
 *  * up to 12 rounds: one card per round, nothing extra;
 *  * more than 12: the 11 newest rounds, plus a first card saying how many
 *    earlier rounds (and pairs) were left out;
 *  * the message stays under LINE's 50KB limit and carries no money figures.
 *
 * Usage:  node daily-summary-harness.mjs
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

const outDir = mkdtempSync(join(tmpdir(), 'daysum-harness-'));
const bundlePath = join(outDir, 'flex.mjs');
await build({
  entryPoints: ['src/flexTemplates.ts'],
  bundle: true, format: 'esm', platform: 'neutral', outfile: bundlePath, logLevel: 'error',
});
const { generateDailySummaryFlex } = await import(pathToFileURL(bundlePath).href);

/** `rounds` rockets of `pairs` settled duels each, oldest first. */
const day = (rounds, pairs) => {
  const orders = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < pairs; i++) {
      orders.push({
        orderNumber: String(1000 + r * 100 + i), roundId: `R${r}`,
        rocketName: `ROCKET_${String(r).padStart(2, '0')} บั้งไฟสด ช่างวิโรจน์ (พิเศษ VIP)`,
        finalTime: 345, settledAt: 1750000000000 + r * 60000 + i, status: 'settled',
        side: 'low', winnerSide: 'low', amount: 777, payout: 1476, commission: 78,
        creatorName: 'ชื่อผู้เล่นยาวมาก คนที่หนึ่ง', matcherName: 'ชื่อผู้เล่นยาวมาก คนที่สอง',
      });
    }
  }
  return orders;
};
const bubblesOf = (msg) => (msg.contents.type === 'carousel' ? msg.contents.contents : [msg.contents]);
const bytes = (msg) => new TextEncoder().encode(JSON.stringify(msg.contents)).length;

console.log('DAILY SUMMARY HARNESS\n');

console.log('[1] 12 rounds — every round has its own card');
{
  const msg = generateDailySummaryFlex('2026-10-26', day(12, 5));
  const b = bubblesOf(msg);
  const text = JSON.stringify(msg);
  check('12 cards', b.length === 12, `cards=${b.length}`);
  check('no "earlier rounds" card', !text.includes('รอบก่อนหน้า'));
  check('first and last round both shown', text.includes('ROCKET_00') && text.includes('ROCKET_11'));
}

console.log('\n[2] 13 rounds — newest 11 plus a card for the 2 left out');
{
  const msg = generateDailySummaryFlex('2026-10-26', day(13, 5));
  const b = bubblesOf(msg);
  const text = JSON.stringify(msg);
  const first = JSON.stringify(b[0]);
  check('still 12 cards (LINE carousel limit)', b.length === 12, `cards=${b.length}`);
  check('first card names the 2 earlier rounds', first.includes('อีก 2 รอบก่อนหน้า'), first.slice(0, 300));
  check('first card counts their 10 pairs', first.includes('"10 คู่"'));
  check('first card points to the admin page', first.includes('ดูผลครบทุกรอบได้ในหน้าแอดมิน'));
  check('the newest round is shown', text.includes('ROCKET_12'));
  check('the two oldest rounds are the ones left out', !text.includes('ROCKET_00') && !text.includes('ROCKET_01') && text.includes('ROCKET_02'));
  check('alt text still counts every pair of the day', msg.altText.includes('65 คู่'), msg.altText);
}

console.log('\n[3] Very busy day — 40 rounds of 30 pairs');
{
  const msg = generateDailySummaryFlex('2026-10-26', day(40, 30));
  const text = JSON.stringify(msg);
  check('12 cards', bubblesOf(msg).length === 12);
  check('first card names the 29 earlier rounds', JSON.stringify(bubblesOf(msg)[0]).includes('อีก 29 รอบก่อนหน้า'));
  check('message is under LINE\'s 50KB limit', bytes(msg) < 50_000, `${bytes(msg)} bytes`);
  check('no stake, payout, fee or volume', !/\bpt\b|ค่าธรรมเนียม|ยอด|ผู้ชนะรับ|คืนเงิน|777|1476/.test(text));
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
