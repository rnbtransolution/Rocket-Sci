import { Order } from './types.js';
import type { LineIconName } from './lineIcons.js';

/**
 * Flex Message templates for every card the bot sends, in groups and in DMs.
 *
 * One visual system. The header colour says what the message is about before a
 * word is read, so it follows the money, not the mood:
 *
 *   in       green   credit arrives — deposit credited, refund, admin top-up
 *   out      orange  credit leaves — admin payout, admin deduction
 *   error    red     refused or failed, round void
 *   pending  amber   waiting on someone — slip under review, betting closed
 *   info     blue    round news — quote, result, daily summary (kept rare)
 *   neutral  slate   everything else — orders, matches, balance, board,
 *                    menu, rules, plain notices
 *   launch   red-pink "บั้งไฟขึ้นแล้ว" only
 *
 * Copy is short and plain: no emoji, no slang, left-aligned, one idea per line.
 * Amounts are the largest text on a card that moves money.
 */

type Tone = 'in' | 'out' | 'error' | 'pending' | 'info' | 'neutral' | 'launch';

const TONES: Record<Tone, { head: string; accent: string; tint: string }> = {
  in: { head: '#0B6B3F', accent: '#0F7B4A', tint: '#EAF5EF' },
  out: { head: '#B4400F', accent: '#C2410C', tint: '#FCEFE7' },
  error: { head: '#A3221A', accent: '#B42318', tint: '#FBEBE9' },
  pending: { head: '#8A5300', accent: '#9A5B00', tint: '#FDF4E3' },
  info: { head: '#1C3F94', accent: '#1E4DB7', tint: '#EBF0FB' },
  neutral: { head: '#2B3138', accent: '#3B424C', tint: '#F2F4F6' },
  // "บั้งไฟขึ้นแล้ว" only: red-pink, so the launch stands apart from the amber pending cards.
  launch: { head: '#D6336C', accent: '#C2255C', tint: '#FDECF2' },
};

const INK = '#16191D';
const BODY = '#3B424C';
const MUTED = '#5B636E';
const HAIRLINE = '#E6E9ED';
const PANEL = '#F5F6F8';

const pt = (n: number) => `${Number(n || 0).toLocaleString()} pt`;

const text = (value: string, o: Record<string, any> = {}) => ({
  type: 'text',
  text: value,
  size: 'sm',
  color: BODY,
  wrap: true,
  ...o,
});

const divider = (margin = 'md') => ({ type: 'separator', margin, color: HAIRLINE });

const note = (value: string, margin = 'md') => text(value, { size: 'xs', color: MUTED, margin });

/** Label on the left, value on the right. */
const row = (label: string, value: string, o: { color?: string; size?: string } = {}) => ({
  type: 'box',
  layout: 'horizontal',
  spacing: 'md',
  contents: [
    text(label, { size: o.size ?? 'sm', color: MUTED, flex: 4 }),
    text(value, { size: o.size ?? 'sm', color: o.color ?? INK, weight: 'bold', flex: 6, align: 'end' }),
  ],
});

/** The headline number of a money card. */
const hero = (value: string, color: string, caption?: string) => [
  text(value, { size: 'xxl', weight: 'bold', color }),
  ...(caption ? [text(caption, { size: 'xs', color: MUTED })] : []),
];

const panel = (contents: any[], o: Record<string, any> = {}) => ({
  type: 'box',
  layout: 'vertical',
  backgroundColor: PANEL,
  cornerRadius: 'md',
  paddingAll: 'md',
  spacing: 'sm',
  contents,
  ...o,
});

/**
 * Every action button is gold with a dark label: the owner asked for buttons
 * that stand out on a phone. `secondary` is the style whose label LINE draws
 * dark, so the colour below becomes the fill. (LINE does not let a bot colour
 * Quick Reply chips; those get a gold dot icon instead, see QUICK_REPLY_ICON.)
 */
const GOLD = '#E8B931';
const GOLD_TINT = '#F9EBC2';
const GOLD_INK = '#5C4300';
const button = (label: string, message: string) => ({
  type: 'button',
  style: 'secondary',
  height: 'sm',
  color: GOLD,
  action: { type: 'message', label, text: message },
});

/** Served by this Worker (see LINE_ICONS); bump `v` when an icon is redrawn. */
const ICON_VERSION = 1;
/**
 * Public origin of this deployment, set per request by `setPublicBaseUrl`.
 * It used to be one hard-coded workers.dev host, so every other deployment
 * (staging, a custom domain, another account) pointed its cards at that one.
 */
let iconBase = '';

/** `PUBLIC_BASE_URL` when configured, else the origin the request came in on. */
export function setPublicBaseUrl(configured: string | undefined, requestOrigin: string): void {
  const base = (configured || requestOrigin || '').trim().replace(/\/+$/, '');
  // LINE only loads https images; a card without the faint icon beats a broken one.
  iconBase = base.startsWith('https://') ? `${base}/icons` : '';
}

interface BubbleSpec {
  tone: Tone;
  /** Faint line icon in the header's top-right corner, naming the card's subject. */
  icon?: LineIconName;
  /** Small line above the title: the category ("เงินเข้า", "ออเดอร์ #1234"). */
  eyebrow?: string;
  title: string;
  /** One line under the title (rocket name, player). */
  sub?: string;
  body?: any[];
  footer?: any[];
  size?: 'kilo' | 'mega' | 'giga';
  /**
   * Tighter padding and a smaller title, for cards posted to the group. Group
   * chats scroll fast and every card pushes the conversation up, so group
   * cards trade whitespace for height.
   */
  compact?: boolean;
}

function bubble({ tone, icon, eyebrow, title, sub, body, footer, size = 'kilo', compact = false }: BubbleSpec): any {
  return {
    type: 'bubble',
    size,
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: TONES[tone].head,
      paddingAll: compact ? 'md' : 'lg',
      paddingStart: compact ? 'lg' : undefined,
      paddingEnd: compact ? 'lg' : undefined,
      spacing: compact ? 'none' : 'xs',
      contents: [
        // First, so the text draws over it.
        ...(icon && iconBase
          ? [{
              type: 'image',
              url: `${iconBase}/${icon}.png?v=${ICON_VERSION}`,
              position: 'absolute',
              offsetTop: compact ? '4px' : '8px',
              offsetEnd: '10px',
              size: compact ? '44px' : '56px',
              aspectRatio: '1:1',
              aspectMode: 'fit',
            }]
          : []),
        ...(eyebrow ? [text(eyebrow, { size: 'xs', color: '#FFFFFFB3', weight: 'bold' })] : []),
        text(title, { size: compact ? 'md' : 'lg', color: '#FFFFFF', weight: 'bold' }),
        ...(sub ? [text(sub, { size: 'xs', color: '#FFFFFFCC' })] : []),
      ],
    },
    ...(body && body.length > 0
      ? {
          body: {
            type: 'box',
            layout: 'vertical',
            paddingAll: compact ? 'md' : 'lg',
            paddingStart: compact ? 'lg' : undefined,
            paddingEnd: compact ? 'lg' : undefined,
            spacing: 'sm',
            contents: body,
          },
        }
      : {}),
    ...(footer && footer.length > 0
      ? { footer: { type: 'box', layout: 'vertical', paddingAll: compact ? 'sm' : 'md', spacing: 'sm', contents: footer } }
      : {}),
  };
}

const flex = (altText: string, contents: any) => ({ type: 'flex', altText, contents });

// ── Round announcements (group) ──

export function generateRocketLaunchedFlex(rocketName?: string): any {
  return flex(
    `บั้งไฟขึ้นแล้ว${rocketName ? ` · ${rocketName}` : ''} · ปิดรับแทง`,
    bubble({
      tone: 'launch',
      icon: 'rocket',
      compact: true,
      eyebrow: 'ปิดรับแทง',
      title: `บั้งไฟขึ้นแล้ว${rocketName ? ` · ${rocketName}` : ''}`,
      body: [text('แผลที่ยังไม่มีคู่ คืนเครดิตอัตโนมัติ\nประกาศเวลาบินหลังบั้งไฟลง', { size: 'xs' })],
    })
  );
}

/** Quote released for the open rocket, or for the next one (`nextRocket`). */
export function generateQuoteFlex(name: string, min: number, max: number, isChotoy: boolean, nextRocket = false): any {
  const range = `${min}–${max} วิ${isChotoy ? ' (ชตย)' : ''}`;
  return flex(
    `เปิดราคา ${name} · ${min}-${max} วิ${isChotoy ? ' (ชตย)' : ''}`,
    bubble({
      tone: 'info',
      icon: 'stopwatch',
      compact: true,
      eyebrow: nextRocket ? `เปิดราคา · ลำถัดไป · ${name}` : `เปิดราคา · ${name}`,
      title: `ช่าง ${range}`,
      body: [
        text('[ปรับราคา] ชล/ชถ จำนวนแต้ม', { size: 'xs', color: INK, weight: 'bold' }),
        text('เช่น ชล500 · +10ชล500 · -5ชถ1,000', { size: 'xs', color: MUTED, margin: 'none' }),
      ],
    })
  );
}

export function generateVoidRoundFlex(roundName?: string): any {
  return flex(
    `โมฆะรอบ${roundName ? ` ${roundName}` : ''} · คืนเครดิตแล้ว`,
    bubble({
      tone: 'error',
      icon: 'ban',
      compact: true,
      eyebrow: 'โมฆะรอบ',
      title: roundName || 'บั้งไฟ',
      body: [text('ยกเลิกทุกแผลดวลของรอบนี้ และคืนเครดิตเต็มจำนวนแล้ว', { size: 'xs' })],
    })
  );
}

/**
 * Winners and losers as a three-column table, one line per pair. Group-safe:
 * points are real money, so it never shows a stake or payout. A pair-per-block
 * layout took four lines per duel and buried the chat under a busy round.
 */
const duelTable = (orders: Order[]) => {
  const cell = (value: string, o: Record<string, any> = {}) => text(value, { size: 'xs', wrap: false, ...o });
  const head = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      cell('ออเดอร์', { color: MUTED, flex: 3 }),
      cell('ชนะ', { color: MUTED, flex: 5 }),
      cell('แพ้', { color: MUTED, flex: 5 }),
    ],
  };
  const rowOf = (o: Order) => {
    const draw = o.winnerSide === 'draw';
    const creatorWins = o.winnerSide === o.side;
    const winName = String((draw || creatorWins ? o.creatorName : o.matcherName) || (o as any).winnerName || '-');
    const loseName = String((draw || creatorWins ? o.matcherName : o.creatorName) || '-');
    return {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: draw
        ? [cell(`#${o.orderNumber}`, { color: MUTED, flex: 3 }), cell(`เสมอ · ${winName} · ${loseName}`, { color: BODY, flex: 10 })]
        : [
            cell(`#${o.orderNumber}`, { color: MUTED, flex: 3, adjustMode: 'shrink-to-fit' }),
            cell(winName, { color: TONES.in.accent, weight: 'bold', flex: 5 }),
            cell(loseName, { color: TONES.error.accent, flex: 5 }),
          ],
    };
  };
  return [head, divider('xs'), ...orders.map(rowOf)];
};

/**
 * The result of a rocket, posted to the group once: flight time, range and
 * every pair's winner and loser in one card (it used to be two).
 */
export function generateSettlementFlex(name: string, finalSeconds: number, tMin: number, tMax: number, orders: Order[]): any {
  const shown = orders.slice(0, 25);
  return flex(
    `ผลการแข่งขัน ${name} · ${finalSeconds} วิ · ${orders.length > 0 ? `${orders.length} คู่` : 'ไม่มีคู่ดวล'}`,
    bubble({
      tone: 'info',
      icon: 'flag',
      size: 'mega',
      compact: true,
      eyebrow: `ผลการแข่งขัน · ${name}`,
      title: `เวลาบิน ${finalSeconds} วิ`,
      sub: `ช่าง ${tMin}–${tMax} วิ · ${orders.length > 0 ? `ตัดสินผล ${orders.length} คู่` : 'รอบนี้ไม่มีคู่ดวล'}`,
      body: shown.length > 0
        ? [
            ...duelTable(shown),
            ...(orders.length > shown.length ? [note(`และอีก ${orders.length - shown.length} คู่`, 'sm')] : []),
          ]
        : undefined,
    })
  );
}

// ── 1. Order Creation Card (Open for Matching in Group Chat) ──
export function generateOrderFlex(order: Order): any {
  const { orderNumber, amount, side, userTypedCmd, isChotoy, rocketName, rangeMin, rangeMax, creatorName, betType } = order as any;
  const sideShort = side === 'high' ? 'ล' : 'ถ';
  const numAmount = Number(amount) || 100;

  let cardTitle = `${sideShort}${numAmount}`;
  if (betType === 'custom_range' && rangeMin !== undefined && rangeMax !== undefined) {
    cardTitle = `${rangeMin}-${rangeMax} ${sideShort}${numAmount}`;
  } else if (userTypedCmd && typeof userTypedCmd === 'string') {
    cardTitle = userTypedCmd.trim();
  }

  // The smallest amount a player may stake in a match, and the smallest share of
  // an order they may take. A percentage button that lands below either floor
  // cannot succeed, so it is not rendered at all — offering a button that always
  // errors is worse than offering one fewer button. This bites on small orders:
  // at 100pt the 20/40/80% buttons are 20/40/80, all of them unmatchable.
  const MIN_MATCH_POINTS = 100;
  const MIN_MATCH_RATIO = 0.20;
  const matchFloor = Math.max(MIN_MATCH_POINTS, Math.round(numAmount * MIN_MATCH_RATIO));

  // Partial options (< 100% of numAmount) go in Row 1 (up to 3 buttons: 20%, 40%, 80%).
  // The full 100% button gets Row 2 to itself, and Cancel sits apart below a
  // separator. LINE's 'sm' is 4px: rows that close, with ~26px-tall buttons,
  // made a tap land on the neighbouring amount, or on Cancel next to Accept.
  // Buttons are ~40px tall with 12px between them.
  const btnPad = { paddingTop: '10px', paddingBottom: '10px', paddingStart: '4px', paddingEnd: '4px' };
  const takeOptions = [0.20, 0.40, 0.80]
    .map((r) => Math.round(numAmount * r))
    .filter((v) => v >= matchFloor && v < numAmount)
    .filter((v, i, arr) => arr.indexOf(v) === i); // rounding can collide
  const amt100 = numAmount;

  // Phones render Thai wider than the bubble's nominal width, so a fixed
  // label like "เต็ม 500" was cut to "เต็ม 5..". The full-take button gets
  // twice the width and every label shrinks to fit instead of truncating.
  const takeButton = (val: number, full: boolean) => ({
    type: 'box',
    layout: 'vertical',
    flex: full ? 2 : 1,
    // Gold, dark label: the full take solid, partial takes a lighter gold.
    backgroundColor: full ? GOLD : GOLD_TINT,
    cornerRadius: 'md',
    ...btnPad,
    action: { type: 'message', label: `${val}`, text: `ต ${orderNumber} ${val}` },
    contents: [text(full ? `เต็ม ${val.toLocaleString()}` : val.toLocaleString(), {
      size: 'sm', color: full ? INK : GOLD_INK, weight: 'bold', align: 'center', wrap: false, adjustMode: 'shrink-to-fit',
    })],
  });

  return flex(
    `ออเดอร์ #${orderNumber} · ${cardTitle} · ${pt(numAmount)}`,
    bubble({
      tone: 'neutral',
      icon: 'ticket',
      size: 'mega',
      compact: true,
      eyebrow: `ออเดอร์ #${orderNumber} · ${creatorName || '-'} · ${rocketName || 'บั้งไฟสด'}`,
      title: `${cardTitle}${isChotoy ? ' (ชตย)' : ''}`,
      body: [
        // One row: partial takes, then the full take in solid gold. 12px gaps
        // and ~40px-tall buttons, so a tap does not land on the neighbour.
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'lg',
          contents: [...takeOptions.map((v) => takeButton(v, false)), takeButton(amt100, true)],
        },
        // Cancel is a small text link on its own line, away from the accept row.
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'lg',
          contents: [
            text(`หรือพิมพ์ ${orderNumber} [จำนวนแต้ม]`, { size: 'xs', color: MUTED, flex: 7 }),
            {
              type: 'box',
              layout: 'vertical',
              flex: 3,
              action: { type: 'message', label: 'ยกเลิก', text: `ยกเลิก ${orderNumber}` },
              contents: [text('ยกเลิก', { size: 'xs', color: TONES.error.accent, weight: 'bold', align: 'end' })],
            },
          ],
        },
      ],
    })
  );
}

// ── 2. Match Notification Card (Dispatched via Private DM to Creator & Matcher Only) ──
export function generateMatchNotificationFlex(order: Order): any {
  const { orderNumber, amount, creatorName, matcherName, side, rocketName, rangeMin, rangeMax, offset } = order as any;
  const lowName = side === 'low' ? creatorName : (matcherName || '-');
  const highName = side === 'high' ? creatorName : (matcherName || '-');
  const offsetStr = offset ? ` ${offset > 0 ? '+' : ''}${offset}s` : '';
  const rangeStr = (rangeMin && rangeMax) ? `${rangeMin}-${rangeMax}s` : `ราคาช่าง${offsetStr}`;

  return flex(
    `จับคู่สำเร็จ #${orderNumber} · ${pt(amount)}`,
    bubble({
      tone: 'neutral',
      icon: 'link',
      eyebrow: `จับคู่สำเร็จ · #${orderNumber}`,
      title: pt(amount),
      sub: `${rocketName || 'บั้งไฟสด'} · ${rangeStr}`,
      body: [
        row('ฝั่งสูง', highName || '-'),
        row('ฝั่งต่ำ', lowName || '-'),
        note('ล็อกแล้ว ยกเลิกทีละแผลไม่ได้ รอประกาศผลหลังบั้งไฟลง'),
      ],
    })
  );
}

// ── 2b. Match Rejection Card ──
// Shown when a match attempt FAILS: own bet, already matched, cancelled, not found,
// insufficient balance, or no opposite-side order available.
export function generateMatchMismatchFlex(orderNo: string | undefined, reason: string, hint?: string): any {
  return flex(
    `จับคู่ไม่สำเร็จ${orderNo ? ` #${orderNo}` : ''}`,
    bubble({
      tone: 'error',
      icon: 'alert',
      eyebrow: 'จับคู่ไม่สำเร็จ',
      title: orderNo ? `ออเดอร์ #${orderNo}` : 'รับแผลไม่ได้',
      body: [text(reason, { color: INK }), ...(hint ? [note(hint)] : [])],
    })
  );
}

// ── 3. Player Balance Card ──
export function generateBalanceFlex(displayName: string, balance: number): any {
  return flex(
    `ยอดคงเหลือ ${pt(balance)}`,
    bubble({
      tone: 'neutral',
      icon: 'wallet',
      eyebrow: 'ยอดคงเหลือ',
      title: displayName || 'สมาชิก',
      body: hero(pt(balance), INK, 'พร้อมใช้งาน'),
    })
  );
}

// ── 3b. Manual Credit Adjustment ──
export function generateCreditAdjustmentFlex(displayName: string, oldBalance: number, newBalance: number): any {
  const delta = newBalance - oldBalance;
  const tone: Tone = delta >= 0 ? 'in' : 'out';
  const deltaStr = `${delta >= 0 ? '+' : '-'}${pt(Math.abs(delta))}`;
  return flex(
    `ปรับยอดเครดิต ${deltaStr} · คงเหลือ ${pt(newBalance)}`,
    bubble({
      tone,
      icon: delta >= 0 ? 'deposit' : 'withdraw',
      eyebrow: delta >= 0 ? 'เงินเข้า · ปรับโดยแอดมิน' : 'เงินออก · ปรับโดยแอดมิน',
      title: 'ปรับยอดเครดิต',
      sub: displayName || undefined,
      body: [
        ...hero(deltaStr, TONES[tone].accent),
        divider(),
        row('ยอดเดิม', pt(oldBalance), { color: MUTED }),
        row('ยอดคงเหลือ', pt(newBalance)),
      ],
    })
  );
}

// ── 3c. Universal Notice Card ──
/**
 * Presentation overrides for `generateNoticeFlex`. Text is left-aligned by
 * default; pass 'center' only for a single short line.
 */
export interface NoticeFlexOptions {
  align?: 'start' | 'center';
  /** Body text colour. Defaults to the body ink. */
  color?: string;
  /** Colour of the optional trailing hint. Defaults to muted grey. */
  hintColor?: string;
}

/**
 * `type` picks the header colour: success = green, warning = amber,
 * error = red, info = slate. Use 'in' / 'out' when the notice is about credit
 * arriving or leaving, so it matches the money cards.
 */
export function generateNoticeFlex(
  title: string,
  message: string,
  type: 'info' | 'success' | 'warning' | 'error' | 'in' | 'out' = 'info',
  hint?: string,
  options: NoticeFlexOptions = {}
): any {
  const tone: Tone = ({ info: 'neutral', success: 'in', warning: 'pending', error: 'error', in: 'in', out: 'out' } as const)[type] || 'info';
  const align = options.align ?? 'start';
  return flex(
    `${title}: ${message.slice(0, 60)}`,
    bubble({
      tone,
      icon: ({ in: 'check', out: 'withdraw', error: 'alert', pending: 'clock', info: 'info', neutral: 'info' } as const)[tone],
      title,
      body: [
        text(message, { color: options.color ?? INK, align }),
        ...(hint ? [text(hint, { size: 'xs', color: options.hintColor ?? MUTED, align, margin: 'md' })] : []),
      ],
    })
  );
}

// ── 3d. Order Cancellation ──
export function generateOrderCancelFlex(orderNumber: string, refundAmount: number, currentBalance: number): any {
  return flex(
    `ยกเลิกออเดอร์ #${orderNumber} · คืน ${pt(refundAmount)}`,
    bubble({
      tone: 'in',
      icon: 'refund',
      eyebrow: 'เงินเข้า · คืนเครดิต',
      title: `ยกเลิกออเดอร์ #${orderNumber}`,
      body: [...hero(`+${pt(refundAmount)}`, TONES.in.accent), divider(), row('ยอดคงเหลือ', pt(currentBalance))],
    })
  );
}

// ── 3e. Insufficient Balance ──
export function generateInsufficientBalanceFlex(currentBalance: number, neededAmount: number): any {
  const diff = Math.max(0, neededAmount - currentBalance);
  return flex(
    `เครดิตไม่พอ · ขาด ${pt(diff)}`,
    bubble({
      tone: 'error',
      icon: 'wallet',
      eyebrow: 'ทำรายการไม่สำเร็จ',
      title: 'เครดิตไม่พอ',
      body: [
        row('มีอยู่', pt(currentBalance)),
        row('ต้องใช้', pt(neededAmount)),
        row('ขาดอีก', pt(diff), { color: TONES.error.accent }),
        note('พิมพ์ "ฝาก" เพื่อเติมเครดิต'),
      ],
    })
  );
}

// ── 3g. Slip Received ──
export function generateSlipReceivedFlex(txId: string): any {
  return flex(
    `ได้รับสลิปแล้ว #${txId} · รอตรวจสอบ`,
    bubble({
      tone: 'pending',
      icon: 'receipt',
      eyebrow: 'ฝากเงิน · รอตรวจสอบ',
      title: 'ได้รับสลิปแล้ว',
      body: [row('รหัสรายการ', `#${txId}`), note('แอดมินกำลังตรวจยอด เครดิตจะเข้าทันทีที่ยืนยัน')],
    })
  );
}

// ── 4. Live Betting Board (กระดานดวล) ──
export function generatePendingBoardFlex(pendingList: Order[]): any {
  const footer = [
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [button('รีเฟรช', 'กระดานดวล'), button('กติกา', 'กติกา')],
    },
  ];

  if (!pendingList || pendingList.length === 0) {
    return flex(
      'กระดานดวล · ไม่มีแผลรอคู่',
      bubble({
        tone: 'neutral',
        icon: 'list',
        size: 'mega',
        compact: true,
        eyebrow: 'กระดานดวล',
        title: 'ยังไม่มีแผลรอคู่',
        body: [text('พิมพ์ ชล หรือ ชถ เพื่อเปิดแผลใหม่', { size: 'xs' })],
        footer,
      })
    );
  }

  const displayItems = pendingList.slice(0, 10);
  const itemRows = displayItems.map((b) => {
    const sideText = b.side === 'low' ? '▼ ต่ำ' : '▲ สูง';
    const rangeText = (b.rangeMin && b.rangeMax) ? `${b.rangeMin}-${b.rangeMax}s` : 'ราคาช่าง';
    return {
      type: 'box',
      layout: 'horizontal',
      alignItems: 'center',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          contents: [
            text(`#${b.orderNumber} · ${pt(Number(b.amount || 0))}`, { size: 'sm', color: INK, weight: 'bold', wrap: false, adjustMode: 'shrink-to-fit' }),
            text(`${sideText} · ${rangeText} · ${b.creatorName || 'ผู้เล่น'}`, { size: 'xs', color: MUTED, wrap: false }),
          ],
        },
        // Accept button, ~36px tall
        {
          type: 'box',
          layout: 'vertical',
          width: '80px',
          backgroundColor: TONES.info.accent,
          cornerRadius: 'md',
          paddingTop: '8px',
          paddingBottom: '8px',
          action: { type: 'message', label: `ต ${b.orderNumber}`, text: `ต ${b.orderNumber}` },
          contents: [text('รับดวล', { size: 'sm', color: '#FFFFFF', weight: 'bold', align: 'center', wrap: false, adjustMode: 'shrink-to-fit' })],
        },
      ],
    };
  });

  return flex(
    `กระดานดวล · รอคู่ ${pendingList.length} แผล`,
    bubble({
      tone: 'neutral',
      icon: 'list',
      size: 'mega',
      compact: true,
      eyebrow: 'กระดานดวล',
      title: `รอคู่ ${pendingList.length} แผล`,
      // A hairline between orders, so a tap cannot be read as the next row's.
      body: [
        ...itemRows.flatMap((r, i) => (i === 0 ? [r] : [divider('md'), r])),
        ...(pendingList.length > displayItems.length ? [note(`และอีก ${pendingList.length - displayItems.length} แผลที่รอคู่`)] : []),
      ],
      footer,
    })
  );
}

// ── 5. Rule Guide (กติกาการเล่น) ──
export function generateRuleGuideFlex(): any {
  const heading = (value: string, margin = 'lg') => text(value, { color: INK, weight: 'bold', margin });
  const lines = (value: string) => text(value, { size: 'xs', color: BODY, margin: 'xs' });
  return flex(
    'กติกาการเล่น',
    bubble({
      tone: 'neutral',
      icon: 'book',
      size: 'mega',
      eyebrow: 'Bangfai Commander',
      title: 'กติกาการเล่น',
      // Rewritten 11 Nov 2026 after the test round: players could not tell
      // whether a space was needed. The parser now accepts both, so the card
      // shows one way to type (all together) and says spaces do not matter.
      body: [
        text('1. เล่นราคาช่าง', { color: TONES.info.accent, weight: 'bold' }),
        text('ทายตามราคาที่ช่างเสนอ', { size: 'xs', color: MUTED }),
        panel([
          text('[ปรับราคา][คำย่อ][แต้ม] พิมพ์ติดกันได้เลย', { size: 'xs', color: INK, weight: 'bold' }),
          text('เช่น ชล500 · +10ชล500 · -5ถ500', { size: 'xs', color: BODY }),
        ], { margin: 'md' }),
        heading('ทายว่าชนะ (สูง / ช่างไล่)', 'md'),
        lines('ช่างไล่ · ชล · ไล่ · ลง'),
        heading('ทายว่าแพ้ (ต่ำ / ช่างถอย)', 'md'),
        lines('ช่างยัง · ช่างถอย · ชย · ชถ\nยัง · ย · ถอย · ถ'),
        heading('ปรับราคา', 'md'),
        lines('ใส่ไว้หน้าคำย่อ ได้แค่ +5 · +10 · -5 · -10'),
        divider('lg'),
        text('2. เปิดราคาเอง', { color: TONES.info.accent, weight: 'bold', margin: 'lg' }),
        text('ใช้ได้เมื่อช่างไม่ต่อยราคา · ต้องมีเครดิตพอ', { size: 'xs', color: MUTED }),
        panel([
          text('[ช่วงราคา][คำย่อ][แต้ม] พิมพ์ติดกันได้เลย', { size: 'xs', color: INK, weight: 'bold' }),
          text('300-350ล500 ทายฝั่งไล่\n350-400ถ500 ทายฝั่งถอย', { size: 'xs', color: BODY }),
        ], { margin: 'md' }),
        lines('ช่วงราคาห่างกันได้ไม่เกิน 80 วิ'),
        heading('ช่างต่อยยกเลิก (ชตย)', 'md'),
        lines('ต่อท้ายด้วย ชตย เช่น 300-350ล500ชตย\nเว้นวรรคก่อน ชตย หรือไม่ก็ได้'),
        lines('ถ้าช่างต่อยราคาภายหลัง แผลนี้ยกเลิกและคืนแต้มเต็มทั้งสองฝั่ง แม้จับคู่แล้ว'),
      ],
      footer: [button('ดูกระดานดวล', 'กระดานดวล')],
    })
  );
}

// ── 6. Main Menu Quick Reply (floating at all times in DMs) ──
/**
 * LINE draws Quick Reply chips white and gives bots no colour option; an icon
 * is the only thing a bot can add. Each chip gets a small gold dot, served by
 * this Worker, so the row reads as the gold menu. Without a public https base
 * the chips go out plain rather than with a broken image.
 */
const QUICK_REPLY_ICON = 'gold';
const QUICK_REPLY_LABELS: Array<[string, string]> = [
  ['เช็คยอด', 'เช็คยอด'],
  ['ฝากเงิน', 'ฝากเงิน'],
  ['บัญชีรับเงิน', 'บัญชีรับเงิน'],
  ['กติกา', 'กติกา'],
  ['กระดานดวล', 'กระดานดวล'],
];
function quickReplyItems(): any[] {
  return QUICK_REPLY_LABELS.map(([label, msg]) => ({
    type: 'action',
    ...(iconBase ? { imageUrl: `${iconBase}/${QUICK_REPLY_ICON}.png?v=${ICON_VERSION}` } : {}),
    action: { type: 'message', label, text: msg },
  }));
}
/** Built per message, so the icon URL follows the request's public base. */
export function mainMenuQuickReplyItems(): any[] {
  return quickReplyItems();
}

/**
 * Attach the floating main-menu Quick Reply to any outgoing message.
 * This guarantees the quick reply buttons stay visible and floating at all times
 * across all bot replies, notices, and interactions without requiring "เมนู".
 */
export function attachMainMenuQuickReply(payload: any): any {
  if (payload === null || payload === undefined) {
    const notice = generateNoticeFlex('Bangfai Commander', 'ยินดีต้อนรับสู่ระบบดวล Bangfai Commander');
    return {
      ...notice,
      quickReply: { items: mainMenuQuickReplyItems() },
    };
  }

  // 1. Plain string or number payload: ALWAYS convert to Flex style message!
  if (typeof payload === 'string' || typeof payload === 'number') {
    const textStr = String(payload).trim();
    const lines = textStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const firstLine = lines[0] || 'แจ้งเตือน';
    const restLines = lines.slice(1).join('\n');
    const title = firstLine.length <= 40 ? firstLine : firstLine.slice(0, 40);
    const bodyMessage = restLines.length > 0 ? restLines : firstLine;
    const isError = textStr.includes('⚠️') || textStr.includes('⛔') || textStr.includes('🚫') || textStr.includes('ไม่พอ') || textStr.includes('ผิดพลาด') || textStr.includes('ไม่พบ');
    const isSuccess = textStr.includes('✅') || textStr.includes('สำเร็จ');
    const variant = isError ? 'warning' : (isSuccess ? 'success' : 'info');
    const notice = generateNoticeFlex(title, bodyMessage, variant);
    return {
      ...notice,
      quickReply: { items: mainMenuQuickReplyItems() },
    };
  }

  // 2. Structured objects
  if (typeof payload === 'object') {
    // If it is a raw bubble or carousel container, wrap into a flex message with quickReply
    if (payload.type === 'bubble' || payload.type === 'carousel') {
      const altText = payload.header?.contents?.[0]?.text || payload.altText || 'Bangfai Commander';
      return {
        type: 'flex',
        altText,
        contents: payload,
        quickReply: { items: mainMenuQuickReplyItems() },
      };
    }

    // If it's already a text message object: convert to Flex style message!
    if (payload.type === 'text') {
      const textStr = String(payload.text || '').trim();
      const titleMatch = textStr.match(/^([^\n]+)/);
      const title = titleMatch ? titleMatch[1].slice(0, 30) : 'แจ้งเตือน';
      const isError = textStr.includes('⚠️') || textStr.includes('⛔') || textStr.includes('🚫');
      const isSuccess = textStr.includes('✅') || textStr.includes('สำเร็จ');
      const variant = isError ? 'warning' : (isSuccess ? 'success' : 'info');
      const notice = generateNoticeFlex(title, textStr, variant);
      return {
        ...notice,
        quickReply: { items: mainMenuQuickReplyItems() },
      };
    }

    // If it's already a flex message object
    if (payload.type === 'flex') {
      if (payload.quickReply && Array.isArray(payload.quickReply.items) && payload.quickReply.items.length > 0) {
        return payload;
      }
      return {
        ...payload,
        quickReply: { items: mainMenuQuickReplyItems() },
      };
    }
  }

  return payload;
}

/**
 * Explicitly strip/delete any quickReply property from outgoing payloads.
 * Guarantees that messages sent to LINE groups or rooms NEVER carry floating quick reply menus.
 */
export function stripQuickReply(payload: any): any {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'object') {
    if (Array.isArray(payload)) {
      return payload.map(stripQuickReply);
    }
    const clone = { ...payload };
    delete clone.quickReply;
    if (clone.contents && typeof clone.contents === 'object') {
      clone.contents = stripQuickReply(clone.contents);
    }
    return clone;
  }
  return payload;
}

export function generateMainMenuQuickReply(displayName: string, balance: number): any {
  const menu = generateMainMenuFlex(displayName, balance);
  return {
    ...menu,
    quickReply: {
      items: mainMenuQuickReplyItems(),
    },
  };
}

// ── 6. Main Menu Card ──
export function generateMainMenuFlex(displayName: string, balance: number): any {
  return flex(
    `เมนูหลัก · ยอดคงเหลือ ${pt(balance)}`,
    bubble({
      tone: 'neutral',
      icon: 'grid',
      eyebrow: 'เมนูหลัก',
      title: displayName || 'ผู้เล่น',
      body: [
        row('ยอดคงเหลือ', pt(balance)),
        note(PAYOUT_SCHEDULE_TEXT),
      ],
      footer: [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [button('ฝากเงิน', 'ฝากเงิน'), button('บัญชีรับเงิน', 'บัญชีรับเงิน')],
        },
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [button('เช็คยอด', 'เช็คยอด'), button('กติกา', 'กติกา')],
        },
        button('ดูกระดานดวล', 'กระดานดวล'),
      ],
    })
  );
}

// ── 7. Deposit ──
/**
 * There is deliberately no amount field and no amount buttons. The player
 * transfers whatever they intend and the slip becomes the source of truth: the
 * scanner reads the amount off it and credits exactly that. Asking for a number
 * first only created a way for the two to disagree.
 */
const bankPanel = (bank: { bankName: string; accountNumber: string; accountName: string; note?: string }) =>
  panel([
    row('ธนาคาร', bank.bankName),
    row('เลขบัญชี', bank.accountNumber, { color: TONES.in.accent }),
    row('ชื่อบัญชี', bank.accountName),
    ...(bank.note ? [divider('sm'), row('หมายเหตุ', bank.note, { color: TONES.out.accent })] : []),
  ]);

// ── 7b. Typed-Amount Hint (typed "1000" or "ฝาก 1000") ──
/**
 * Answer to a player who typed a deposit amount instead of following the
 * no-typing flow. Same facts as `generateDepositFlex`, said a different way:
 * this one leads with "you don't have to", that one leads with the account.
 *
 * Steps are real nested boxes: the marker sits in a fixed-width column so a
 * wrapped line indents under the step instead of under the number.
 */
export function generateTypedAmountHintFlex(bank: {
  bankName: string;
  accountNumber: string;
  accountName: string;
  note?: string;
}): any {
  const step = (marker: string, content: any[]) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    margin: 'md',
    contents: [
      { type: 'box', layout: 'vertical', width: '20px', contents: [text(marker, { color: INK, weight: 'bold' })] },
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'sm', contents: content },
    ],
  });

  return flex(
    'ไม่ต้องพิมพ์ยอดเงิน · ระบบเติมเครดิตตามยอดในสลิป',
    bubble({
      tone: 'in',
      icon: 'deposit',
      eyebrow: 'ฝากเงิน',
      title: 'ไม่ต้องพิมพ์ยอดเงิน',
      body: [
        text('ระบบเติมเครดิตตามยอดบนสลิปจริง', { color: INK }),
        step('1.', [text('โอนเข้าบัญชีนี้', { color: INK }), bankPanel(bank)]),
        step('2.', [text('ส่งรูปสลิปในแชตนี้', { color: INK })]),
        note('ระบบอ่านสลิปและเติมเครดิตให้อัตโนมัติ'),
      ],
    })
  );
}

export function generateDepositFlex(bank: {
  bankName: string;
  accountNumber: string;
  accountName: string;
  note?: string;
}): any {
  return flex(
    'ฝากเงิน · โอนแล้วส่งสลิป',
    bubble({
      tone: 'in',
      icon: 'deposit',
      eyebrow: 'ฝากเงิน',
      title: 'โอนเข้าบัญชีนี้',
      body: [
        bankPanel(bank),
        // The one line the player has to act on: bold ink, not muted grey.
        text('โอนแล้วส่งรูปสลิปในแชตนี้', { color: INK, weight: 'bold', margin: 'md' }),
        text('ไม่ต้องพิมพ์ยอด ระบบเติมเครดิตตามยอดในสลิป', { size: 'xs', color: MUTED }),
      ],
    })
  );
}

/** Slip verified and credited — the player sees the amount the slip proved. */
export function generateSlipCreditedFlex(
  amount: number,
  newBalance: number,
  refCode: string,
  payoutAccount?: { bankName: string; accountNumber: string; accountName: string } | null
): any {
  const formattedAmt = Number(amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formattedBal = Number(newBalance || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return flex(
    `เงินเข้า +${formattedAmt} บาท · คงเหลือ ${formattedBal} pt`,
    bubble({
      tone: 'in',
      icon: 'deposit',
      eyebrow: 'เงินเข้า · ฝากเงิน',
      title: 'เติมเครดิตแล้ว',
      body: [
        ...hero(`+${formattedAmt} บาท`, TONES.in.accent, 'ยอดตามสลิป'),
        divider(),
        row('ยอดคงเหลือ', `${formattedBal} pt`),
        row('เลขอ้างอิง', refCode, { color: MUTED, size: 'xs' }),
        divider('lg'),
        // The evening payout needs an account; ask while the player is here.
        ...(payoutAccount
          ? [
              text('บัญชีรับเงิน', { size: 'xs', color: MUTED, margin: 'md' }),
              text(`${payoutAccount.bankName} ${payoutAccount.accountNumber}`, { size: 'sm', color: INK, weight: 'bold' }),
              text(payoutAccount.accountName, { size: 'xs', color: BODY }),
              note('ไม่ถูกต้อง ส่งใหม่: ธนาคาร เลขบัญชี ชื่อบัญชี'),
            ]
          : [
              text('ส่งเลขบัญชีรับเงินด้วย', { size: 'sm', color: TONES.pending.accent, weight: 'bold', margin: 'md' }),
              bankFormatPanel(),
              note(PAYOUT_SCHEDULE_TEXT),
            ]),
      ],
    })
  );
}

// ── 8. Deposit Invoice (ใบแจ้งโอนเงินฝาก) ──
export function generateDepositInvoiceFlex(depositAmt: number): any {
  const formattedAmt = Number(depositAmt || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return flex(
    `ใบแจ้งโอนเงินฝาก ${formattedAmt} บาท`,
    bubble({
      tone: 'in',
      icon: 'receipt',
      eyebrow: 'ฝากเงิน',
      title: 'ใบแจ้งโอน',
      body: [
        ...hero(`${formattedAmt} บาท`, TONES.in.accent, 'ยอดที่ต้องโอน'),
        divider(),
        bankPanel({ bankName: 'SCB (ไทยพาณิชย์)', accountNumber: '890-1-23456-7', accountName: 'Somchai Jongcharoen' }),
        note('โอนแล้วส่งรูปสลิปในแชตนี้ ระบบตรวจและเติมเครดิตอัตโนมัติ'),
      ],
    })
  );
}

// ── 9. Payout account (บัญชีรับเงิน) ──

/** There is no self-service withdrawal: the admin pays out by hand every evening. */
export const PAYOUT_SCHEDULE_TEXT = 'แอดมินโอนเงินตามยอดคงเหลือให้ทุกวันหลัง 20:00 น. เข้าบัญชีรับเงินที่แจ้งไว้';

/** How to send the account, shown wherever the bot asks for it. */
function bankFormatPanel(): any {
  return panel([
    text('ส่งในแชตนี้: ธนาคาร เลขบัญชี ชื่อบัญชี', { size: 'sm', color: INK, weight: 'bold' }),
    text('เช่น กสิกร 012-3-45678-9 สมชาย ใจดี', { size: 'xs', color: MUTED }),
  ]);
}

/**
 * Sent right after a slip (and on "บัญชีรับเงิน" when nothing is on file):
 * the evening payout goes to this account, so the bot asks for it while the
 * player is still in the chat.
 */
export function generateBankRequestFlex(): any {
  return flex(
    'ส่งเลขบัญชีรับเงิน',
    bubble({
      tone: 'pending',
      icon: 'bank',
      eyebrow: 'บัญชีรับเงิน',
      title: 'ส่งเลขบัญชีรับเงิน',
      body: [
        text('ใช้สำหรับโอนเงินรางวัลให้คุณ', { size: 'sm', color: BODY }),
        bankFormatPanel(),
        note(PAYOUT_SCHEDULE_TEXT),
      ],
    })
  );
}

/** The account on file, with how to change it. */
export function generateBankOnFileFlex(bankName: string, accountNumber: string, accountName: string, saved = false): any {
  return flex(
    saved ? 'บันทึกบัญชีรับเงินแล้ว' : 'บัญชีรับเงินของคุณ',
    bubble({
      tone: saved ? 'in' : 'neutral',
      icon: saved ? 'check' : 'bank',
      eyebrow: 'บัญชีรับเงิน',
      title: saved ? 'บันทึกบัญชีแล้ว' : 'บัญชีรับเงินของคุณ',
      body: [
        row('ธนาคาร', bankName || '-'),
        row('เลขบัญชี', accountNumber || '-'),
        row('ชื่อบัญชี', accountName || '-'),
        divider(),
        note(PAYOUT_SCHEDULE_TEXT),
        note('ต้องการเปลี่ยนบัญชี ส่งข้อมูลใหม่ในรูปแบบ: ธนาคาร เลขบัญชี ชื่อบัญชี'),
      ],
    })
  );
}

/** Reply to "ถอน" now that withdrawal is no longer a player action. */
export function generateNoWithdrawalFlex(hasBank: boolean): any {
  return flex(
    'การรับเงิน · แอดมินโอนให้ทุกวันหลัง 20:00 น.',
    bubble({
      tone: 'neutral',
      icon: 'bank',
      eyebrow: 'การรับเงิน',
      title: 'ไม่ต้องแจ้งถอน',
      body: [
        text(PAYOUT_SCHEDULE_TEXT, { size: 'sm', color: BODY }),
        ...(hasBank ? [] : [divider(), text('ยังไม่มีบัญชีรับเงิน', { size: 'sm', color: TONES.error.accent, weight: 'bold' }), bankFormatPanel()]),
      ],
      footer: [button('ดูบัญชีรับเงิน', 'บัญชีรับเงิน')],
    })
  );
}

/** DM after the admin records an evening transfer. */
export function generatePayoutSentFlex(amount: number, bankName: string, accountNumber: string, remaining: number): any {
  return flex(
    `โอนเงินแล้ว ${Number(amount || 0).toLocaleString()} บาท`,
    bubble({
      tone: 'out',
      icon: 'withdraw',
      eyebrow: 'เงินออก · โอนให้แล้ว',
      title: 'แอดมินโอนเงินแล้ว',
      body: [
        ...hero(`${Number(amount || 0).toLocaleString()} บาท`, TONES.out.accent),
        divider(),
        row('ธนาคาร', bankName || '-'),
        row('เลขบัญชี', accountNumber || '-'),
        row('ยอดคงเหลือ', pt(remaining)),
      ],
    })
  );
}

/**
 * DM to one player after a round is settled: each of their pairs in this
 * round with the result and the points it moved, then the net and balance.
 * Private, so amounts are shown (the group card never shows them).
 */
export function generatePlayerSettlementFlex(
  roundName: string,
  finalSeconds: number,
  lines: Array<{ orderNumber: string; side: 'low' | 'high'; result: 'win' | 'lose' | 'draw'; delta: number }>,
  balance: number | null
): any {
  const net = lines.reduce((sum, l) => sum + l.delta, 0);
  const wins = lines.filter((l) => l.result === 'win').length;
  const losses = lines.filter((l) => l.result === 'lose').length;
  const tone: Tone = net > 0 ? 'in' : net < 0 ? 'out' : 'neutral';
  const signed = (n: number) => `${n > 0 ? '+' : ''}${pt(n)}`;
  const shown = lines.slice(0, 20);
  const cell = (value: string, o: Record<string, any> = {}) => text(value, { size: 'xs', wrap: false, ...o });
  const resultRow = (l: (typeof lines)[number]) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      cell(`#${l.orderNumber}`, { color: MUTED, flex: 3, adjustMode: 'shrink-to-fit' }),
      cell(l.side === 'high' ? 'สูง (ล)' : 'ต่ำ (ถ)', { color: BODY, flex: 3 }),
      cell(l.result === 'win' ? 'ชนะ' : l.result === 'lose' ? 'แพ้' : 'เสมอ', {
        color: l.result === 'win' ? TONES.in.accent : l.result === 'lose' ? TONES.error.accent : BODY,
        weight: 'bold',
        flex: 2,
      }),
      cell(l.result === 'draw' ? 'คืนเต็ม' : signed(l.delta), { color: INK, flex: 4, align: 'end' }),
    ],
  });
  return flex(
    `ผล ${roundName} · ${finalSeconds} วิ · ${signed(net)}`,
    bubble({
      tone,
      icon: 'flag',
      eyebrow: `ผลของคุณ · ${roundName || 'บั้งไฟ'}`,
      title: `เวลาบิน ${finalSeconds} วิ`,
      sub: `ชนะ ${wins} · แพ้ ${losses}${lines.length - wins - losses > 0 ? ` · เสมอ ${lines.length - wins - losses}` : ''}`,
      body: [
        ...shown.map(resultRow),
        ...(lines.length > shown.length ? [note(`และอีก ${lines.length - shown.length} แผล`, 'sm')] : []),
        divider(),
        ...hero(signed(net), net > 0 ? TONES.in.accent : net < 0 ? TONES.out.accent : INK, 'สุทธิรอบนี้ (หักค่าธรรมเนียม 10% ของฝั่งที่ชนะแล้ว)'),
        ...(balance !== null ? [row('ยอดคงเหลือ', pt(balance), balance < 0 ? { color: TONES.error.accent } : {})] : []),
      ],
    })
  );
}

/** DM when an admin corrected a round's flight time and this player's result moved. */
export function generateResultCorrectionFlex(roundName: string, oldTime: number, newTime: number, delta: number, balance: number): any {
  const up = delta >= 0;
  return flex(
    `แก้ผลรอบ ${roundName} · ${up ? '+' : ''}${pt(delta)}`,
    bubble({
      tone: up ? 'in' : 'out',
      icon: 'stopwatch',
      eyebrow: 'แก้ไขผล',
      title: roundName || 'บั้งไฟ',
      body: [
        row('เวลาบินเดิม', `${oldTime} วิ`, { color: MUTED }),
        row('เวลาบินที่ถูกต้อง', `${newTime} วิ`),
        divider(),
        ...hero(`${up ? '+' : ''}${pt(delta)}`, up ? TONES.in.accent : TONES.out.accent, 'ปรับยอดตามผลใหม่'),
        row('ยอดคงเหลือ', pt(balance), balance < 0 ? { color: TONES.error.accent } : {}),
        ...(balance < 0 ? [note('ยอดติดลบ เติมเครดิตก่อนเล่นต่อ')] : []),
      ],
    })
  );
}

/** Group card: the admin entered the wrong time; this is the corrected result. Winners/losers only. */
export function generateCorrectedSettlementFlex(roundName: string, oldTime: number, newTime: number, tMin: number, tMax: number, orders: Order[]): any {
  const base = generateSettlementFlex(roundName, newTime, tMin, tMax, orders);
  const card = base?.contents;
  if (card && card.type === 'bubble' && card.header && Array.isArray(card.header.contents)) {
    card.header.backgroundColor = TONES.pending.head;
    card.header.contents.push(text(`แก้ไขผล · เวลาเดิม ${oldTime} วิ`, { size: 'xs', color: '#FFFFFF', margin: 'sm' }));
  }
  return { ...base, altText: `แก้ไขผล ${roundName || 'บั้งไฟ'} · เวลาบินที่ถูกต้อง ${newTime} วิ` };
}

// ── Daily Duel Summary (one card per rocket round) ──

/** LINE rejects a Flex message over 50KB; stay clear of it. */
const DAILY_SUMMARY_MAX_BYTES = 45_000;
/** A carousel holds at most 12 bubbles. */
const DAILY_SUMMARY_MAX_ROUNDS = 12;

/**
 * Every duel settled on `day`, grouped by rocket round, each pair showing the
 * winner and loser (or a draw). Points are real money, so the card carries no
 * stake, payout, fee or volume — it must not reveal who won or lost how much.
 *
 * Rounds are keyed on `roundId`, then the in-flight parking ID, and only then
 * on the rocket's name — names repeat ("บั้งไฟสด"), so two rockets with the
 * same name would otherwise merge into one card.
 */
export function generateDailySummaryFlex(day: string, orders: Order[]): any {
  const rounds = new Map<string, Order[]>();
  for (const o of orders) {
    const key = o.roundId || o.inFlightRoundId || `name:${o.rocketName || 'บั้งไฟสด'}`;
    if (!rounds.has(key)) rounds.set(key, []);
    rounds.get(key)!.push(o);
  }
  // Oldest rocket first, pairs in settlement order within each.
  const groups = [...rounds.values()]
    .map((list) => list.slice().sort((a, b) => (Number(a.settledAt) || 0) - (Number(b.settledAt) || 0)))
    .sort((a, b) => (Number(a[0].settledAt) || 0) - (Number(b[0].settledAt) || 0));

  if (groups.length === 0) {
    return generateNoticeFlex(`สรุปผลวันที่ ${day}`, 'ยังไม่มีคู่ดวลที่ตัดสินผลในวันนี้', 'info');
  }

  // More rounds than a carousel holds: show the latest ones and give the last
  // slot to a card saying how many earlier rounds were left out. Slicing the
  // first 12 used to drop the day's newest rounds without a word.
  const overflow = groups.length > DAILY_SUMMARY_MAX_ROUNDS;
  const shownGroups = overflow ? groups.slice(groups.length - (DAILY_SUMMARY_MAX_ROUNDS - 1)) : groups;
  const hiddenGroups = groups.slice(0, groups.length - shownGroups.length);
  const hiddenPairs = hiddenGroups.reduce((n, list) => n + list.length, 0);
  const hiddenBubble = overflow
    ? bubble({
        tone: 'neutral',
        icon: 'calendar',
        size: 'mega',
        compact: true,
        eyebrow: `สรุปผลวันที่ ${day}`,
        title: `อีก ${hiddenGroups.length} รอบก่อนหน้า`,
        sub: `${hiddenPairs} คู่`,
        body: [note('ดูผลครบทุกรอบได้ในหน้าแอดมิน', 'sm')],
      })
    : null;

  const build = (rowsPerRound: number) => {
    const roundBubbles = shownGroups.map((list) => {
      const first = list[0];
      const hidden = list.length - rowsPerRound;
      return bubble({
        tone: 'info',
        icon: 'calendar',
        size: 'mega',
        compact: true,
        eyebrow: `สรุปผลวันที่ ${day}`,
        title: first.rocketName || 'บั้งไฟสด',
        sub: `เวลาบิน ${first.finalTime ?? '-'} วิ · ${list.length} คู่`,
        body: [
          ...duelTable(list.slice(0, rowsPerRound)),
          ...(hidden > 0 ? [note(`และอีก ${hidden} คู่ ดูครบในหน้าแอดมิน`, 'sm')] : []),
        ],
      });
    });
    const bubbles = hiddenBubble ? [hiddenBubble, ...roundBubbles] : roundBubbles;
    return flex(
      `สรุปผลวันที่ ${day} · ${orders.length} คู่`,
      bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles }
    );
  };

  // Fewer rows per card until the whole message fits LINE's size limit.
  let rows = 30;
  let msg = build(rows);
  while (rows > 3 && new TextEncoder().encode(JSON.stringify(msg.contents)).length > DAILY_SUMMARY_MAX_BYTES) {
    rows -= 1;
    msg = build(rows);
  }
  return msg;
}
