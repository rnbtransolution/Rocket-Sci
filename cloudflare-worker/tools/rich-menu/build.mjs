// Builds the DM rich menu image (2500x1686) and the rich menu JSON.
//   node tools/rich-menu/build.mjs
// Writes richmenu.html, richmenu.png, richmenu.jpg and richmenu.json next to this file.
// The tile texts are the same words the Worker already answers in DM
// (เช็คยอด / ฝากเงิน / บัญชีรับเงิน / กติกา / กระดานดวล), so no Worker change is
// needed for the taps themselves.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const W = 2500;
const H = 1686;
const TOP = 900; // top row height; bottom row gets the rest

// Soft tints of the เพชรมงคล logo: a light ribbon coral and a light sky blue
// on top, warm white below, a pale gold line between the rows. Text stays
// dark enough to read at a glance on a phone.
const CORAL_BG = '#FDE9E4';
const CORAL_INK = '#B23A2E';
const SKY_BG = '#E4EFFB';
const SKY_INK = '#1F4E8C';
const INK = '#2A3550';
const SUB = '#6B7385';
const GOLD = '#E6CF9A';
const PAPER = '#FFFDF8';
const LINE = '#ECE6DA';

const TILES = [
  { x: 0, y: 0, w: 1250, h: TOP, icon: 'swords', label: 'กระดานดวล', sub: 'แผลที่ยังรอคู่', text: 'กระดานดวล', bg: CORAL_BG, fg: CORAL_INK, subFg: '#8C5A52', iconFg: CORAL_INK, big: true },
  { x: 1250, y: 0, w: 1250, h: TOP, icon: 'wallet', label: 'เช็คยอด', sub: 'ยอดคงเหลือของคุณ', text: 'เช็คยอด', bg: SKY_BG, fg: SKY_INK, subFg: '#56708F', iconFg: SKY_INK, big: true },
  { x: 0, y: TOP, w: 833, h: H - TOP, icon: 'coin-baht', label: 'ฝากเงิน', sub: 'โอนแล้วส่งสลิป', text: 'ฝากเงิน', bg: PAPER, fg: INK, subFg: SUB, iconFg: '#B8892E' },
  { x: 833, y: TOP, w: 834, h: H - TOP, icon: 'building-bank', label: 'บัญชีรับเงิน', sub: 'บัญชีรับยอดถอน', text: 'บัญชีรับเงิน', bg: PAPER, fg: INK, subFg: SUB, iconFg: '#B8892E' },
  { x: 1667, y: TOP, w: 833, h: H - TOP, icon: 'books', label: 'กติกา', sub: 'วิธีเล่นและคำย่อ', text: 'กติกา', bg: PAPER, fg: INK, subFg: SUB, iconFg: '#B8892E' },
];

const svg = (name, color, size, stroke) =>
  readFileSync(join(here, 'icons', `${name}.svg`), 'utf8')
    .replace(/class="[^"]*"/, '')
    .replace(/width="24"/, `width="${size}"`)
    .replace(/height="24"/, `height="${size}"`)
    .replace(/stroke="currentColor"/, `stroke="${color}"`)
    .replace(/stroke-width="2"/, `stroke-width="${stroke}"`);

const tileHtml = (t) => `
  <div class="tile${t.big ? ' big' : ''}" style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;background:${t.bg}">
    ${svg(t.icon, t.iconFg, t.big ? 230 : 190, t.big ? 1.5 : 1.6)}
    <div class="label" style="color:${t.fg}">${t.label}</div>
    <div class="sub" style="color:${t.subFg}">${t.sub}</div>
  </div>`;

const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<style>
  @font-face { font-family: 'NotoThai'; src: local('Noto Sans Thai'); }
  html, body { margin: 0; padding: 0; }
  body { width: ${W}px; height: ${H}px; position: relative; overflow: hidden; background: ${LINE};
         font-family: 'Noto Sans Thai', 'Sarabun', sans-serif; }
  .tile { position: absolute; box-sizing: border-box; display: flex; flex-direction: column;
          align-items: center; justify-content: center; }
  .label { font-weight: 700; font-size: 118px; line-height: 1.15; margin-top: 34px; letter-spacing: 0; }
  .sub { font-weight: 500; font-size: 62px; line-height: 1.2; margin-top: 10px; }
  .big .label { font-size: 150px; margin-top: 40px; }
  .big .sub { font-size: 70px; }
  /* hairlines between the white tiles, a gold rule under the top row */
  .rule { position: absolute; left: 0; width: ${W}px; top: ${TOP}px; height: 10px; background: ${GOLD}; }
  .vline { position: absolute; top: ${TOP + 10}px; width: 4px; height: ${H - TOP - 10}px; background: ${LINE}; }
</style></head>
<body>
${TILES.map(tileHtml).join('')}
  <div class="rule"></div>
  <div class="vline" style="left:831px"></div>
  <div class="vline" style="left:1665px"></div>
</body></html>`;

writeFileSync(join(here, 'richmenu.html'), html);

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--window-size=${W},${H}`, `--screenshot=${join(here, 'richmenu.png')}`,
  `file://${join(here, 'richmenu.html')}`,
], { stdio: 'ignore' });
// LINE takes JPEG or PNG up to 1 MB.
execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88',
  join(here, 'richmenu.png'), '--out', join(here, 'richmenu.jpg')], { stdio: 'ignore' });

const menu = {
  size: { width: W, height: H },
  selected: true, // open by default when the chat is opened
  name: 'bangfai-dm-main-v1',
  chatBarText: 'เมนู',
  areas: TILES.map((t) => ({
    bounds: { x: t.x, y: t.y, width: t.w, height: t.h },
    action: { type: 'message', label: t.label, text: t.text },
  })),
};
writeFileSync(join(here, 'richmenu.json'), JSON.stringify(menu, null, 2) + '\n');
console.log('wrote richmenu.html / .png / .jpg / .json');
