import { Order } from './types.js';

/**
 * Pre-compiled, ultra-fast Flex Message generator for Cloudflare Workers.
 * Avoids recursive object re-allocations and heavy serialization overhead.
 */

export function generateRocketLaunchedFlex(rocketName?: string): any {
  const titleSuffix = rocketName ? ` [${rocketName}]` : '';
  return {
    type: 'flex',
    altText: `🚀 บั้งไฟออกแล้ว!${titleSuffix} (⛔ ปิดรับดวลรอบนี้)`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#DC2626',
        paddingAll: 'lg',
        spacing: 'xs',
        contents: [
          {
            type: 'text',
            text: '🔥 LIVE ACTION · FINAL CALL 🔥',
            weight: 'bold',
            color: '#FEF08A',
            size: 'xs',
            align: 'center',
          },
          {
            type: 'text',
            text: '🚀 บั้งไฟออกแล้ว! 🚀',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xl',
            align: 'center',
            wrap: true,
          },
          ...(rocketName
            ? [{
                type: 'text',
                text: `บั้งไฟ: ${rocketName}`,
                weight: 'bold',
                color: '#FEE2E2',
                size: 'sm',
                align: 'center',
                wrap: true,
              }]
            : []),
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFF7ED',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFEDD5',
            cornerRadius: 'md',
            paddingAll: 'sm',
            spacing: 'xs',
            contents: [
              {
                type: 'text',
                text: '⚡ พุ่งทะยานสู่ท้องฟ้า · ⛔ ปิดรับดวลรอบนี้แล้ว!',
                weight: 'bold',
                color: '#C2410C',
                size: 'xs',
                align: 'center',
                wrap: true,
              },
              {
                type: 'text',
                text: '🔒 แผลเปิดที่ไม่ติดคู่ดวล ถูกยกเลิกและคืนแต้มอัตโนมัติ',
                color: '#475569',
                size: 'xs',
                align: 'center',
                wrap: true,
              },
              {
                type: 'text',
                text: '⏱️ รอลุ้นเวลาและสรุปผลหลังบั้งไฟลง 💥',
                weight: 'bold',
                color: '#9A3412',
                size: 'xs',
                align: 'center',
                wrap: true,
              },
            ],
          },
        ],
      },
    },
  };
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
  // The full 100% button sits in Row 2 alongside Cancel so buttons have generous spacing.
  const takeOptions = [0.20, 0.40, 0.80]
    .map((r) => Math.round(numAmount * r))
    .filter((v) => v >= matchFloor && v < numAmount)
    .filter((v, i, arr) => arr.indexOf(v) === i); // rounding can collide
  const amt100 = numAmount;

  return {
    type: 'flex',
    altText: `🚀 เปิดดวล #${orderNumber} [${cardTitle}] ${numAmount.toLocaleString()}pt`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#334155',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: `Order #${orderNumber}`,
            weight: 'bold',
            color: '#F8FAFC',
            size: 'xs',
            align: 'center',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: `${cardTitle}${isChotoy ? ' (ชตย)' : ''}`,
            weight: 'bold',
            color: '#1E293B',
            size: 'md',
            align: 'center',
            wrap: true,
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              {
                type: 'text',
                text: `👤 ผู้เปิด: ${creatorName || '-'}`,
                color: '#64748B',
                size: 'xs',
                align: 'center',
                wrap: true,
                flex: 1,
              },
              {
                type: 'text',
                text: `🚀 บั้งไฟ: ${rocketName || 'บั้งไฟสด'}`,
                color: '#64748B',
                size: 'xs',
                align: 'center',
                wrap: true,
                flex: 1,
              },
            ],
          },
          {
            type: 'separator',
            margin: 'sm',
            color: '#F1F5F9',
          },
          // Row 1: partial Quick Deal Buttons (20%, 40%, 80%), filtered to what can actually be matched
          // Generous horizontal spacing ('md') and vertical touch padding prevent accidental mis-taps.
          ...(takeOptions.length > 0
            ? [{
                type: 'box',
                layout: 'horizontal',
                spacing: 'md',
                margin: 'md',
                contents: takeOptions.map((val) => ({
                  type: 'box',
                  layout: 'vertical',
                  flex: 1,
                  backgroundColor: '#BAE6FD',
                  cornerRadius: 'md',
                  paddingTop: '10px',
                  paddingBottom: '10px',
                  paddingStart: '6px',
                  paddingEnd: '6px',
                  action: {
                    type: 'message',
                    label: `${val}`,
                    text: `ต ${orderNumber} ${val}`,
                  },
                  contents: [
                    { type: 'text', text: `${val}`, color: '#0369A1', weight: 'bold', size: 'sm', align: 'center', wrap: true },
                  ],
                })),
              }]
            : []),
          // Row 2: 100% Full Take & Cancel Buttons with wide spacing ('md')
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'md',
            margin: 'md',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#BBF7D0',
                cornerRadius: 'md',
                paddingTop: '10px',
                paddingBottom: '10px',
                paddingStart: '8px',
                paddingEnd: '8px',
                action: {
                  type: 'message',
                  label: `${amt100}`,
                  text: `ต ${orderNumber} ${amt100}`,
                },
                contents: [
                  { type: 'text', text: `${amt100}`, color: '#15803D', weight: 'bold', size: 'sm', align: 'center', wrap: true },
                ],
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#FECDD3',
                cornerRadius: 'md',
                paddingTop: '10px',
                paddingBottom: '10px',
                paddingStart: '8px',
                paddingEnd: '8px',
                action: {
                  type: 'message',
                  label: '⛔ ยกเลิก',
                  text: `ยกเลิก ${orderNumber}`,
                },
                contents: [
                  { type: 'text', text: '⛔ ยกเลิก', color: '#9F1239', weight: 'bold', size: 'sm', align: 'center', wrap: true },
                ],
              },
            ],
          },
          {
            type: 'text',
            text: `หรือพิมพ์: ${orderNumber} [จำนวนแต้ม]`,
            size: 'xs',
            color: '#2563EB',
            weight: 'bold',
            align: 'center',
            margin: 'md',
            wrap: true,
          },
        ],
      },
    },
  };
}

// ── 2. Match Notification Card (Dispatched via Private DM to Matchers) ──
export function generateMatchNotificationFlex(order: Order): any {
  const { orderNumber, amount, creatorName, matcherName, side, rocketName, rangeMin, rangeMax, betType, offset, offsetConfirmedAt } = order as any;
  const lowName = side === 'low' ? creatorName : (matcherName || '-');
  const highName = side === 'high' ? creatorName : (matcherName || '-');
  const isPreQuoteWaiting = betType === 'pre_quote' && !offsetConfirmedAt;
  const offsetStr = offset ? ` (${offset > 0 ? '+' : ''}${offset}s)` : '';
  const rangeStr = (rangeMin && rangeMax)
    ? `${rangeMin}-${rangeMax}s`
    : (isPreQuoteWaiting ? `รอราคาช่าง${offsetStr}` : 'ราคาช่าง');

  const titleText = isPreQuoteWaiting ? `🤝 รับแผลล่วงหน้า! #${orderNumber}` : `🤝 แมตช์สำเร็จ! #${orderNumber}`;
  const rocketText = isPreQuoteWaiting
    ? `🚀 บั้งไฟ: รอแอดมินเปิดราคา (${rangeStr})`
    : `🚀 บั้งไฟ: ${rocketName || 'รอบดวลสด'} (${rangeStr})`;

  return {
    type: 'flex',
    altText: `🤝 ${isPreQuoteWaiting ? 'รับแผลล่วงหน้า' : 'จับคู่ดวลสำเร็จ'}! Order #${orderNumber} (${amount} pt)`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: isPreQuoteWaiting ? '#D97706' : '#059669',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: titleText,
            weight: 'bold',
            color: '#FFFFFF',
            size: 'sm',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: `ยอดดวล: ${amount.toLocaleString()} pt`,
            weight: 'bold',
            color: '#0F172A',
            size: 'md',
            align: 'center',
          },
          {
            type: 'text',
            text: rocketText,
            color: '#64748B',
            size: 'xs',
            align: 'center',
          },
          ...(isPreQuoteWaiting ? [
            {
              type: 'text',
              text: '⏳ จะยืนยันแผลอย่างเป็นทางการเมื่อแอดมินประกาศราคาช่าง',
              color: '#D97706',
              size: 'xs',
              align: 'center',
              wrap: true,
            },
          ] : []),
          { type: 'separator', margin: 'xs', color: '#E2E8F0' },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#EFF6FF',
                cornerRadius: 'sm',
                paddingAll: 'xs',
                contents: [
                  { type: 'text', text: '🔻 ต่ำ (Low)', color: '#2563EB', weight: 'bold', size: 'xs', align: 'center' },
                  { type: 'text', text: `@${lowName}`, color: '#1E293B', weight: 'bold', size: 'xs', align: 'center', wrap: true },
                ],
              },
              { type: 'text', text: 'VS', color: '#94A3B8', weight: 'bold', size: 'xs', align: 'center', gravity: 'center', flex: 0 },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#FEF2F2',
                cornerRadius: 'sm',
                paddingAll: 'xs',
                contents: [
                  { type: 'text', text: '🔺 สูง (High)', color: '#DC2626', weight: 'bold', size: 'xs', align: 'center' },
                  { type: 'text', text: `@${highName}`, color: '#1E293B', weight: 'bold', size: 'xs', align: 'center', wrap: true },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

// ── 2b. Match Mismatch / Rejection Card (Red Theme) ──
// Shown when a match attempt FAILS: own bet, already matched, cancelled, not found,
// insufficient balance, or no opposite-side order available.
export function generateMatchMismatchFlex(orderNo: string | undefined, reason: string, hint?: string): any {
  const title = orderNo ? `🚫 จับคู่ไม่สำเร็จ #${orderNo}` : '🚫 จับคู่ไม่สำเร็จ';
  return {
    type: 'flex',
    altText: `🚫 จับคู่ไม่สำเร็จ${orderNo ? ` Order #${orderNo}` : ''}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#DC2626',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: title,
            weight: 'bold',
            color: '#FFFFFF',
            size: 'sm',
            align: 'center',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: reason,
            color: '#1E293B',
            weight: 'bold',
            size: 'sm',
            align: 'center',
            wrap: true,
          },
          ...(hint ? [
            { type: 'separator', margin: 'xs', color: '#E2E8F0' },
            {
              type: 'text',
              text: hint,
              color: '#64748B',
              size: 'xs',
              align: 'center',
              wrap: true,
            },
          ] : []),
        ],
      },
    },
  };
}

// ── 3. Player Balance Card ──
export function generateBalanceFlex(displayName: string, balance: number): any {
  return {
    type: 'flex',
    altText: `💰 ยอดแต้มคงเหลือ: ${balance.toLocaleString()} pt`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0A3D34',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '💰 ยอดแต้มคงเหลือ',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'xs',
        contents: [
          {
            type: 'text',
            text: `👤 ผู้เล่น: ${displayName || 'สมาชิก'}`,
            color: '#64748B',
            size: 'xs',
            align: 'center',
          },
          {
            type: 'text',
            text: `${Number(balance || 0).toLocaleString()} pt`,
            weight: 'bold',
            color: '#059669',
            size: 'xxl',
            align: 'center',
            margin: 'xs',
          },
          {
            type: 'text',
            text: 'แต้มคงเหลือพร้อมใช้งาน',
            color: '#94A3B8',
            size: 'xs',
            align: 'center',
          },
        ],
      },
    },
  };
}

// ── 3b. Credit Adjustment Notification Card (แจ้งเตือนปรับยอดเครดิตแมนนวล) ──
export function generateCreditAdjustmentFlex(displayName: string, oldBalance: number, newBalance: number): any {
  const delta = newBalance - oldBalance;
  const isPositive = delta >= 0;
  const deltaSign = isPositive ? '+' : '';
  const deltaColor = isPositive ? '#059669' : '#DC2626';

  return {
    type: 'flex',
    altText: `💰 แจ้งเตือนปรับยอดเครดิต: ${newBalance.toLocaleString()} pt`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F172A',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: '💰 แจ้งเตือนปรับยอดเครดิต',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'sm',
            align: 'center',
          },
          {
            type: 'text',
            text: 'แอดมินได้ปรับยอดแต้มคงเหลือของคุณ',
            color: '#94A3B8',
            size: 'xs',
            align: 'center',
            margin: 'xs',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: `👤 คุณ ${displayName}`,
            color: '#64748B',
            size: 'xs',
            weight: 'bold',
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F8FAFC',
            cornerRadius: 'md',
            paddingAll: 'sm',
            margin: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: 'ยอดเดิม:', color: '#64748B', size: 'xs' },
                  { type: 'text', text: `${oldBalance.toLocaleString()} pt`, color: '#64748B', size: 'xs', align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                margin: 'xs',
                contents: [
                  { type: 'text', text: 'ยอดปรับ:', color: '#64748B', size: 'xs' },
                  { type: 'text', text: `${deltaSign}${delta.toLocaleString()} pt`, color: deltaColor, size: 'xs', weight: 'bold', align: 'end' },
                ],
              },
            ],
          },
          { type: 'separator', margin: 'sm', color: '#E2E8F0' },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            alignItems: 'center',
            contents: [
              { type: 'text', text: 'ยอดคงเหลือใหม่', weight: 'bold', color: '#1E293B', size: 'xs' },
              { type: 'text', text: `${newBalance.toLocaleString()} pt`, weight: 'bold', color: '#059669', size: 'lg', align: 'end' },
            ],
          },
          { type: 'text', text: '💡 พิมพ์ "ฝาก" หรือ "ถอน"', color: '#94A3B8', size: 'xs', wrap: true, margin: 'sm' },
        ],
      },
    },
  };
}

// ── 3c. Universal Notice & Status Flex Card (เปลี่ยนข้อความธรรมดาเป็น Flex Card) ──
/**
 * Presentation overrides for `generateNoticeFlex`.
 *
 * `align` defaults to 'center' because most notices are one short line where
 * centred reads as a title. A body of several lines must be passed 'start':
 * centring a paragraph makes both edges ragged, the eye loses its place on the
 * return sweep, and on a narrow phone screen it is measurably worse to read.
 */
export interface NoticeFlexOptions {
  align?: 'start' | 'center';
  /** Body text colour. Defaults to #1E293B. */
  color?: string;
  /** Colour of the optional trailing hint. Defaults to #64748B. */
  hintColor?: string;
}

export function generateNoticeFlex(
  title: string,
  message: string,
  type: 'info' | 'success' | 'warning' | 'error' = 'info',
  hint?: string,
  options: NoticeFlexOptions = {}
): any {
  const align = options.align ?? 'center';
  const bodyColor = options.color ?? '#1E293B';
  const hintColor = options.hintColor ?? '#64748B';
  const headerColors: Record<string, string> = {
    info: '#0A3D34',     // Deep Forest Green
    success: '#059669',  // Emerald Green
    warning: '#D97706',  // Amber
    error: '#DC2626',    // Crimson Red
  };

  const headerColor = headerColors[type] || headerColors.info;

  return {
    type: 'flex',
    altText: `🚀 ${title}: ${message.slice(0, 40)}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: title,
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: message,
            color: bodyColor,
            size: 'sm',
            align,
            wrap: true,
          },
          ...(hint
            ? [
                { type: 'separator', margin: 'sm', color: '#E2E8F0' },
                {
                  type: 'text',
                  text: hint,
                  color: hintColor,
                  size: 'xs',
                  align,
                  wrap: true,
                },
              ]
            : []),
        ],
      },
    },
  };
}

// ── 3d. Order Cancellation Confirmation Flex Card ──
export function generateOrderCancelFlex(orderNumber: string, refundAmount: number, currentBalance: number): any {
  return {
    type: 'flex',
    altText: `⛔ ยกเลิก Order #${orderNumber} เรียบร้อยแล้ว`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#475569',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: `⛔ ยกเลิก Order #${orderNumber}`,
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: 'ยกเลิกแผลดวลเรียบร้อยแล้วครับ',
            weight: 'bold',
            color: '#1E293B',
            size: 'sm',
            align: 'center',
          },
          {
            type: 'separator',
            margin: 'xs',
            color: '#E2E8F0',
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: 'คืนแต้ม:', color: '#64748B', size: 'xs', flex: 5 },
              { type: 'text', text: `+${refundAmount.toLocaleString()} pt`, weight: 'bold', color: '#059669', size: 'xs', flex: 5, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: 'แต้มคงเหลือ:', color: '#64748B', size: 'xs', flex: 5 },
              { type: 'text', text: `${currentBalance.toLocaleString()} pt`, weight: 'bold', color: '#0284C7', size: 'xs', flex: 5, align: 'end' },
            ],
          },
        ],
      },
    },
  };
}

// ── 3e. Insufficient Balance Notice Flex Card ──
export function generateInsufficientBalanceFlex(currentBalance: number, neededAmount: number): any {
  const diff = Math.max(0, neededAmount - currentBalance);
  return {
    type: 'flex',
    altText: `⚠️ แต้มไม่พอสำหรับรายการนี้ (ขาด ${diff.toLocaleString()} pt)`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#DC2626',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '⚠️ แต้มคงเหลือไม่พอ',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: 'มีอยู่', color: '#64748B', size: 'xs', flex: 5 },
              { type: 'text', text: `${currentBalance.toLocaleString()} pt`, weight: 'bold', color: '#1E293B', size: 'xs', flex: 5, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: 'ต้องการ', color: '#64748B', size: 'xs', flex: 5 },
              { type: 'text', text: `${neededAmount.toLocaleString()} pt`, weight: 'bold', color: '#DC2626', size: 'xs', flex: 5, align: 'end' },
            ],
          },
          { type: 'separator', margin: 'xs', color: '#E2E8F0' },
          {
            type: 'text',
            text: `ขาดอีก ${diff.toLocaleString()} pt — พิมพ์ "ฝาก" เพื่อเติมแต้ม`,
            color: '#64748B',
            size: 'xs',
            align: 'center',
            wrap: true,
          },
        ],
      },
    },
  };
}

// ── 3f. Withdrawal Requested Confirmation Flex Card ──
export function generateWithdrawalSuccessFlex(
  withdrawAmt: number,
  bankName: string,
  accountNumber: string,
  accountName: string,
  remainingBalance: number
): any {
  return {
    type: 'flex',
    altText: `💸 แจ้งถอนเงิน ${withdrawAmt.toLocaleString()} pt เรียบร้อยแล้ว`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0284C7',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '💸 ส่งคำขอถอนเงินเรียบร้อย',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: `${withdrawAmt.toLocaleString()} pt`,
            weight: 'bold',
            color: '#0284C7',
            size: 'xl',
            align: 'center',
          },
          { type: 'separator', margin: 'sm', color: '#F1F5F9' },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'xs',
            contents: [
              { type: 'text', text: '🏦 ธนาคาร', color: '#94A3B8', size: 'xs', flex: 4 },
              { type: 'text', text: bankName, weight: 'bold', color: '#334155', size: 'xs', flex: 6, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '🔢 เลขบัญชี', color: '#94A3B8', size: 'xs', flex: 4 },
              { type: 'text', text: accountNumber, weight: 'bold', color: '#334155', size: 'xs', flex: 6, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '👤 ชื่อบัญชี', color: '#94A3B8', size: 'xs', flex: 4 },
              { type: 'text', text: accountName, weight: 'bold', color: '#334155', size: 'xs', flex: 6, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '💎 แต้มคงเหลือ', color: '#94A3B8', size: 'xs', flex: 4 },
              { type: 'text', text: `${remainingBalance.toLocaleString()} pt`, weight: 'bold', color: '#059669', size: 'xs', flex: 6, align: 'end' },
            ],
          },
          {
            type: 'separator',
            margin: 'sm',
            color: '#F1F5F9',
          },
          {
            type: 'text',
            text: '⏳ รอแอดมินโอนเงิน',
            size: 'xs',
            color: '#64748B',
            align: 'center',
            wrap: true,
          },
        ],
      },
    },
  };
}

// ── 3g. Slip Received Notice Flex Card ──
export function generateSlipReceivedFlex(txId: string): any {
  return {
    type: 'flex',
    altText: `🧾 ได้รับสลิปโอนเงินแล้ว (#${txId})`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#059669',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '🧾 ได้รับสลิปโอนเงินแล้ว',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: `รหัสรายการ: #${txId}`,
            weight: 'bold',
            color: '#1E293B',
            size: 'sm',
            align: 'center',
          },
          {
            type: 'text',
            text: 'ระบบได้ส่งภาพสลิปให้แอดมินตรวจสอบยอดเงินเข้าบัญชีเรียบร้อย เมื่อตรวจสอบสำเร็จแต้มจะเข้ากระเป๋าของคุณทันทีครับ 🙏',
            color: '#64748B',
            size: 'xs',
            align: 'center',
            wrap: true,
          },
        ],
      },
    },
  };
}

// ── 4. Live Betting Board Card (กระดานดวลสด) ──
export function generatePendingBoardFlex(pendingList: Order[]): any {
  if (!pendingList || pendingList.length === 0) {
    return {
      type: 'flex',
      altText: '📊 กระดานดวลสด: ไม่มีแผลค้าง',
      contents: {
        type: 'bubble',
        size: 'mega',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#0F172A',
          paddingAll: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                {
                  type: 'text',
                  text: '📊 กระดานดวลสด',
                  weight: 'bold',
                  color: '#FFFFFF',
                  size: 'md',
                  flex: 1,
                },
                {
                  type: 'box',
                  layout: 'vertical',
                  backgroundColor: '#334155',
                  cornerRadius: 'sm',
                  paddingStart: '8px',
                  paddingEnd: '8px',
                  paddingTop: '3px',
                  paddingBottom: '3px',
                  contents: [
                    { type: 'text', text: 'ว่าง 0 แผล', color: '#CBD5E1', size: 'xs', weight: 'bold' },
                  ],
                },
              ],
            },
            {
              type: 'text',
              text: 'ยังไม่มีแผลเปิดรอคู่ในขณะนี้ 🚀',
              color: '#CBD5E1',
              size: 'xs',
              margin: 'sm',
            },
          ],
        },
        body: {
          type: 'box',
          layout: 'vertical',
          paddingAll: 'lg',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: 'ไม่มีแผลดวลค้างในขณะนี้ 🚀',
              weight: 'bold',
              color: '#0F172A',
              size: 'md',
              align: 'center',
            },
            {
              type: 'text',
              text: 'ท่านสามารถพิมพ์ ชล หรือ ชถ ในกลุ่มดวล เพื่อเปิดแผลใหม่ได้ทันทีครับ',
              color: '#475569',
              size: 'xs',
              align: 'center',
              wrap: true,
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'horizontal',
          spacing: 'xs',
          paddingAll: 'sm',
          contents: [
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              color: '#F1F5F9',
              action: {
                type: 'message',
                label: '🔄 รีเฟรช',
                text: 'กระดานดวล',
              },
            },
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              color: '#F1F5F9',
              action: {
                type: 'message',
                label: '📖 กติกา',
                text: 'กติกา',
              },
            },
          ],
        },
      },
    };
  }

  const displayItems = pendingList.slice(0, 8);
  const itemBoxes = displayItems.map((b) => {
    const isLow = b.side === 'low';
    const sideText = isLow ? '🔻 ทายต่ำ' : '🔺 ทายสูง';
    const sideColor = isLow ? '#DC2626' : '#16A34A';
    const rangeText = (b.rangeMin && b.rangeMax) ? `(${b.rangeMin}-${b.rangeMax}s)` : '(ราคาช่าง)';
    const amtStr = Number(b.amount || 0).toLocaleString('th-TH');

    return {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FFFFFF',
      borderColor: '#CBD5E1',
      borderWidth: '1px',
      cornerRadius: 'md',
      paddingAll: 'md',
      spacing: 'xs',
      contents: [
        // Row 1: Order ID (explicit, without redundant brackets) & Player Name
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'text',
              text: `#${b.orderNumber}`,
              weight: 'bold',
              color: '#0F172A',
              size: 'sm',
              flex: 6,
            },
            {
              type: 'text',
              text: `👤 @${b.creatorName || 'ผู้เล่น'}`,
              weight: 'bold',
              color: '#334155',
              size: 'xs',
              align: 'end',
              flex: 6,
              wrap: true,
            },
          ],
        },
        // Row 2: Prediction Side/Range & Amount
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              flex: 7,
              contents: [
                {
                  type: 'text',
                  text: `${sideText} ${rangeText}`,
                  weight: 'bold',
                  color: sideColor,
                  size: 'xs',
                },
              ],
            },
            {
              type: 'text',
              text: `${amtStr} pt`,
              weight: 'bold',
              color: '#0284C7',
              size: 'sm',
              align: 'end',
              flex: 5,
            },
          ],
        },
        // Row 3: Prominent High-Contrast Accept Deal Button
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'xs',
          margin: 'sm',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#0284C7',
              cornerRadius: 'sm',
              paddingTop: '6px',
              paddingBottom: '6px',
              flex: 1,
              action: {
                type: 'message',
                label: `ต ${b.orderNumber}`,
                text: `ต ${b.orderNumber}`,
              },
              contents: [
                {
                  type: 'text',
                  text: `⚡ รับดวล Order #${b.orderNumber}`,
                  color: '#FFFFFF',
                  weight: 'bold',
                  size: 'xs',
                  align: 'center',
                },
              ],
            },
          ],
        },
      ],
    };
  });

  const overflowNotice = pendingList.length > 8 ? [
    {
      type: 'text',
      text: `... และอีก ${pendingList.length - 8} แผลดวลที่เปิดรอคู่`,
      size: 'xs',
      color: '#475569',
      weight: 'bold',
      align: 'center',
      margin: 'sm',
    },
  ] : [];

  return {
    type: 'flex',
    altText: `📊 กระดานดวลสด (${pendingList.length} แผลค้าง)`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F172A',
        paddingAll: 'md',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '📊 กระดานดวลสด',
                weight: 'bold',
                color: '#FFFFFF',
                size: 'md',
                flex: 1,
              },
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#059669',
                cornerRadius: 'sm',
                paddingStart: '8px',
                paddingEnd: '8px',
                paddingTop: '3px',
                paddingBottom: '3px',
                contents: [
                  {
                    type: 'text',
                    text: `รอคู่ ${pendingList.length} แผล`,
                    color: '#FFFFFF',
                    size: 'xs',
                    weight: 'bold',
                  },
                ],
              },
            ],
          },
          {
            type: 'text',
            text: 'แตะปุ่มด้านล่าง หรือพิมพ์ ต [เลข Order] เพื่อรับดวล 🚀',
            color: '#CBD5E1',
            size: 'xs',
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          ...itemBoxes,
          ...overflowNotice,
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'xs',
        paddingAll: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            color: '#F1F5F9',
            action: {
              type: 'message',
              label: '🔄 รีเฟรช',
              text: 'กระดานดวล',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            color: '#F1F5F9',
            action: {
              type: 'message',
              label: '📖 กติกา',
              text: 'กติกา',
            },
          },
        ],
      },
    },
  };
}

// ── 5. Rule Guide Card (กติกาการเล่น) ──
export function generateRuleGuideFlex(): any {
  return {
    type: 'flex',
    altText: '📖 กติกาการเล่น 🚀',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0A3D34',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '🚀 ROCKET SCIENCE',
            weight: 'bold',
            color: '#FDE047',
            size: 'xs',
            align: 'center',
          },
          {
            type: 'text',
            text: '📖 กติกาการเล่น',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'sm',
            align: 'center',
            margin: 'xs',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#ECFDF5',
            cornerRadius: 'md',
            paddingAll: 'sm',
            contents: [
              {
                type: 'text',
                text: '📌 กฏที่ 1: เล่นราคาช่าง',
                weight: 'bold',
                color: '#065F46',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '🎉 ทายว่าชนะ (สูง):',
                weight: 'bold',
                color: '#047857',
                size: 'xs',
                margin: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '• ช่างไล่ / ชล / ไล่ / ลง\n• +5ชล / +5ล / +5ไล่\n• -5ชล / -5ล / -5ไล่',
                color: '#047857',
                size: 'xs',
                wrap: true,
                margin: 'xs',
              },
              {
                type: 'text',
                text: '💵 พิมพ์คีย์เวิร์ดตามด้วยจำนวนเงิน (ตัวเลขเท่านั้น)\nเช่น ชล100 , ชล1000 , ชล10000',
                color: '#065F46',
                size: 'xs',
                wrap: true,
                margin: 'xs',
              },
              {
                // The keyword list and the amount list were shown separately,
                // so nothing on screen ever showed that they combine into ONE
                // message, or that the offset goes in front. Players had to
                // guess the full syntax. One worked example settles it.
                type: 'text',
                text: '✅ รูปแบบเต็ม: [ปรับราคา] คีย์เวิร์ด จำนวนแต้ม\nเช่น +10ชล500 · -5ชถ1,000 · ชล500',
                color: '#065F46',
                size: 'xs',
                weight: 'bold',
                wrap: true,
                margin: 'xs',
              },
              {
                type: 'separator',
                margin: 'sm',
                color: '#A7F3D0',
              },
              {
                type: 'text',
                text: '👊 ทายว่าแพ้ (ต่ำ):',
                weight: 'bold',
                color: '#047857',
                size: 'xs',
                margin: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '• ช่างยัง / ช่างถอย / ชย\n• ชถ / ยัง / ย / ถอย / ถ\n• +5ชย / +5ชถ / +5ย / +5ถ\n• -5ชย / -5ชถ / -5ย / -5ถ\nเช่น ชถ100 , ชถ1000\n✅ เต็ม: +10ชย500 · -5ชถ1,000',
                color: '#047857',
                size: 'xs',
                wrap: true,
                margin: 'xs',
              },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F0F9FF',
            cornerRadius: 'md',
            paddingAll: 'sm',
            contents: [
              {
                type: 'text',
                text: '📌 กฏที่ 2: การเปิดราคาเอง (กรณีช่างไม่ต่อย / ต้องมีเครดิตพอ)',
                weight: 'bold',
                color: '#0369A1',
                size: 'xs',
                wrap: true,
              },
              {
                type: 'text',
                text: '💰 การเปิดราคาเอง (เปิดแผลสดใหม่):',
                weight: 'bold',
                color: '#0284C7',
                size: 'xs',
                margin: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '⚠️ ช่วงราคาต้องห่างกันไม่เกิน 50 วิ เช่น\n• 300-350ล500 | 300-350ถ500\n• 350-400ล500 | 350-400ถ500',
                color: '#0284C7',
                size: 'xs',
                wrap: true,
                margin: 'xs',
              },
              {
                type: 'separator',
                margin: 'sm',
                color: '#BAE6FD',
              },
              {
                type: 'text',
                text: '⬆️ ช่างต่อยกเลิก (ชตย)',
                weight: 'bold',
                color: '#0284C7',
                size: 'xs',
                margin: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: 'ใส่ ชตย หลังจำนวนเงิน เช่น\n• 300-350ล500 ชตย\n• 350-400ถ500 ชตย',
                color: '#0284C7',
                size: 'xs',
                wrap: true,
                margin: 'xs',
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        paddingAll: 'xs',
        contents: [
          {
            type: 'button',
            action: {
              type: 'message',
              label: '📋 ดูกระดานดวลสด',
              text: 'กระดานดวล',
            },
            style: 'primary',
            color: '#0A3D34',
            height: 'sm',
          },
        ],
      },
    },
  };
}

// ── 6. Main Menu Quick Reply (เมนูหลักระบบดวล — Floating at all times) ──
export const MAIN_MENU_QUICK_REPLY_ITEMS = [
  { type: 'action', action: { type: 'message', label: '💳 เช็คยอด', text: 'เช็คยอด' } },
  { type: 'action', action: { type: 'message', label: '💰 ฝากเงิน', text: 'ฝากเงิน' } },
  { type: 'action', action: { type: 'message', label: '💸 ถอนเงิน', text: 'ถอนเงิน' } },
  { type: 'action', action: { type: 'message', label: '📖 กติกา', text: 'กติกา' } },
  { type: 'action', action: { type: 'message', label: '📋 กระดานดวล', text: 'กระดานดวล' } },
];

/**
 * Attach the floating main-menu Quick Reply to any outgoing message.
 * This guarantees the quick reply buttons stay visible and floating at all times
 * across all bot replies, notices, and interactions without requiring "เมนู".
 */
export function attachMainMenuQuickReply(payload: any): any {
  if (payload === null || payload === undefined) {
    const notice = generateNoticeFlex('🚀 Rocket Science', 'ยินดีต้อนรับสู่ระบบดวล Rocket Science');
    return {
      ...notice,
      quickReply: { items: MAIN_MENU_QUICK_REPLY_ITEMS },
    };
  }

  // 1. Plain string or number payload: ALWAYS convert to Flex style message!
  if (typeof payload === 'string' || typeof payload === 'number') {
    const textStr = String(payload).trim();
    const lines = textStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const firstLine = lines[0] || '🚀 แจ้งเตือน';
    const restLines = lines.slice(1).join('\n');
    const title = firstLine.length <= 40 ? firstLine : firstLine.slice(0, 40);
    const bodyMessage = restLines.length > 0 ? restLines : firstLine;
    const isError = textStr.includes('⚠️') || textStr.includes('⛔') || textStr.includes('🚫') || textStr.includes('ไม่พอ') || textStr.includes('ผิดพลาด') || textStr.includes('ไม่พบ');
    const isSuccess = textStr.includes('✅') || textStr.includes('สำเร็จ');
    const variant = isError ? 'warning' : (isSuccess ? 'success' : 'info');
    const flex = generateNoticeFlex(title, bodyMessage, variant);
    return {
      ...flex,
      quickReply: { items: MAIN_MENU_QUICK_REPLY_ITEMS },
    };
  }

  // 2. Structured objects
  if (typeof payload === 'object') {
    // If it is a raw bubble or carousel container, wrap into a flex message with quickReply
    if (payload.type === 'bubble' || payload.type === 'carousel') {
      const altText = payload.header?.contents?.[0]?.text || payload.altText || '🚀 Rocket Science';
      return {
        type: 'flex',
        altText,
        contents: payload,
        quickReply: { items: MAIN_MENU_QUICK_REPLY_ITEMS },
      };
    }

    // If it's already a text message object: convert to Flex style message!
    if (payload.type === 'text') {
      const textStr = String(payload.text || '').trim();
      const titleMatch = textStr.match(/^([^\n]+)/);
      const title = titleMatch ? titleMatch[1].slice(0, 30) : '🚀 แจ้งเตือน';
      const isError = textStr.includes('⚠️') || textStr.includes('⛔') || textStr.includes('🚫');
      const isSuccess = textStr.includes('✅') || textStr.includes('สำเร็จ');
      const variant = isError ? 'warning' : (isSuccess ? 'success' : 'info');
      const flex = generateNoticeFlex(title, textStr, variant);
      return {
        ...flex,
        quickReply: { items: MAIN_MENU_QUICK_REPLY_ITEMS },
      };
    }

    // If it's already a flex message object
    if (payload.type === 'flex') {
      if (payload.quickReply && Array.isArray(payload.quickReply.items) && payload.quickReply.items.length > 0) {
        return payload;
      }
      return {
        ...payload,
        quickReply: { items: MAIN_MENU_QUICK_REPLY_ITEMS },
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
  const flex = generateMainMenuFlex(displayName, balance);
  return {
    ...flex,
    quickReply: {
      items: [...MAIN_MENU_QUICK_REPLY_ITEMS],
    },
  };
}

// ── 6. Main Menu Flex Card (เมนูหลักระบบดวล) ──
export function generateMainMenuFlex(displayName: string, balance: number): any {
  return {
    type: 'flex',
    altText: '🚀 เมนูหลักระบบดวลบั้งไฟ',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0A3D34',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '🚀 เมนูหลัก (Rocket Science)',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '👤 ผู้เล่น', color: '#64748B', size: 'xs', flex: 4 },
              { type: 'text', text: displayName || 'ผู้เล่น', weight: 'bold', color: '#1E293B', size: 'xs', flex: 6, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'xs',
            contents: [
              { type: 'text', text: '💰 แต้มคงเหลือ', color: '#64748B', size: 'xs', flex: 4 },
              { type: 'text', text: `${balance.toLocaleString()} pt`, weight: 'bold', color: '#059669', size: 'xs', flex: 6, align: 'end' },
            ],
          },
          {
            type: 'separator',
            margin: 'sm',
            color: '#E2E8F0',
          },
          {
            type: 'text',
            text: 'เลือกรายการที่ต้องการทำได้เลยครับ',
            size: 'xs',
            color: '#94A3B8',
            align: 'center',
            margin: 'xs',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: '#10B981',
                action: {
                  type: 'message',
                  label: '💰 ฝากเงิน',
                  text: 'ฝากเงิน',
                },
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: '#475569',
                action: {
                  type: 'message',
                  label: '💸 ถอนเงิน',
                  text: 'ถอนเงิน',
                },
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            margin: 'xs',
            contents: [
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '📊 เช็คยอด',
                  text: 'เช็คยอด',
                },
              },
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '📖 กติกา',
                  text: 'กติกา',
                },
              },
            ],
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            margin: 'xs',
            action: {
              type: 'message',
              label: '📋 ดูกระดานดวลสด',
              text: 'กระดานดวล',
            },
          },
        ],
      },
    },
  };
}

// ── 7. Deposit Instruction Card (วิธีฝาก — โอนแล้วส่งสลิป) ──
/**
 * The whole deposit procedure, in one card.
 *
 * There is deliberately no amount field and no amount buttons. The player
 * transfers whatever they intend and the slip becomes the source of truth: the
 * scanner reads the amount off it and credits exactly that. Asking for a number
 * first only created a way for the two to disagree.
 *
 * Kept deliberately short. The first version spelled the procedure out as three
 * numbered steps plus two footnotes; on a phone that is a wall of text for what
 * is really two facts — where to send the money, and send the slip afterwards.
 * The constraints that used to be stated up front (24h, real bank app, ask an
 * admin) each have their own message at the moment they apply, which is when
 * the player can actually act on it.
 */
// ── 10b. Typed-Amount Hint (typed "1000" or "ฝาก 1000") ──
/**
 * Answer to a player who typed a deposit amount instead of following the
 * no-typing flow. Same facts as `generateDepositFlex`, said a different way:
 * this one leads with "you don't have to", that one leads with the account.
 *
 * Built from real nested boxes rather than one string with `\n` and leading
 * spaces. A single text node can only centre or flush-left it — it cannot make
 * a wrapped line hang under the text it belongs to, so the numbered steps came
 * out as a ragged blob with the continuation lines starting wherever the wrap
 * landed. Here the marker sits in a fixed-width column and the copy sits beside
 * it, so a wrapped line indents under the step instead of under the number.
 */
export function generateTypedAmountHintFlex(bank: {
  bankName: string;
  accountNumber: string;
  accountName: string;
  note?: string;
}): any {
  /**
   * One numbered step: marker in a fixed column, content in the rest. The fixed
   * width is what keeps step 1 and step 2 on the same axis — sizing the column
   * to its contents would work only while both markers are the same width.
   */
  const step = (marker: string, content: any[]) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    margin: 'xs',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '20px',
        contents: [
          {
            type: 'text',
            text: marker,
            weight: 'bold',
            color: '#000000',
            size: 'sm',
            align: 'start',
          },
        ],
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        spacing: 'xs',
        contents: content,
      },
    ],
  });

  /** Label/value pair. Mirrors `detailRow` in `generateDepositFlex`. */
  const detailRow = (label: string, value: string, valueColor = '#000000') => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: '#64748B', size: 'xs', flex: 4, wrap: true },
      { type: 'text', text: value, weight: 'bold', color: valueColor, size: 'xs', flex: 6, align: 'end', wrap: true },
    ],
  });

  const bodyText = (text: string) => ({
    type: 'text',
    text,
    color: '#000000',
    size: 'sm',
    align: 'start',
    wrap: true,
  });

  return {
    type: 'flex',
    altText: '💡 ไม่ต้องพิมพ์ยอดเงิน — ระบบเติมเครดิตตามยอดในสลิป',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0A3D34',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '💡 ไม่ต้องพิมพ์ยอดเงินครับ',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'md',
        contents: [
          bodyText('ระบบเติมเครดิตตามยอดที่ปรากฏบนสลิปจริง'),
          { type: 'separator', margin: 'md', color: '#E2E8F0' },
          {
            type: 'text',
            text: 'วิธีทำ',
            weight: 'bold',
            color: '#000000',
            size: 'sm',
            align: 'start',
          },
          step('1.', [
            bodyText('โอนเงินเข้าบัญชีด้านล่าง'),
            {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#F8FAFC',
              cornerRadius: 'md',
              paddingAll: 'sm',
              spacing: 'xs',
              contents: [
                detailRow('🏦 ธนาคาร', bank.bankName),
                detailRow('🔢 เลขบัญชี', bank.accountNumber),
                detailRow('👤 ชื่อบัญชี', bank.accountName),
                ...(bank.note
                  ? [{ type: 'separator', margin: 'xs', color: '#E2E8F0' }, detailRow('📌 หมายเหตุ', bank.note, '#EA580C')]
                  : []),
              ],
            },
          ]),
          step('2.', [bodyText('ส่งรูปสลิปมาที่แชทนี้')]),
          { type: 'separator', margin: 'md', color: '#E2E8F0' },
          bodyText('ระบบจะอ่านสลิปแล้วเติมเครดิตให้อัตโนมัติครับ 🙏'),
        ],
      },
    },
  };
}

export function generateDepositFlex(bank: {
  bankName: string;
  accountNumber: string;
  accountName: string;
  note?: string;
}): any {
  const detailRow = (label: string, value: string, valueColor = '#334155') => ({
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, color: '#94A3B8', size: 'xs', flex: 4 },
      { type: 'text', text: value, weight: 'bold', color: valueColor, size: 'xs', flex: 6, align: 'end', wrap: true },
    ],
  });

  return {
    type: 'flex',
    altText: '💰 วิธีฝากเครดิต — โอนเงินแล้วส่งสลิป',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#10B981',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '💰 ฝากเครดิต (Deposit)',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F8FAFC',
            cornerRadius: 'md',
            paddingAll: 'sm',
            spacing: 'xs',
            contents: [
              detailRow('🏦 ธนาคาร', bank.bankName),
              detailRow('🔢 เลขบัญชี', bank.accountNumber, '#0369A1'),
              detailRow('👤 ชื่อบัญชี', bank.accountName),
              ...(bank.note
                ? [{ type: 'separator', margin: 'xs', color: '#E2E8F0' }, detailRow('📌 หมายเหตุ', bank.note, '#EA580C')]
                : []),
            ],
          },
          { type: 'separator', margin: 'sm', color: '#F1F5F9' },
          {
            type: 'text',
            text: 'โอนเงินแล้วส่งรูปสลิปมาที่แชทนี้\nไม่ต้องพิมพ์ยอด — ระบบเติมเครดิตตามยอดในสลิป',
            // Brick orange rather than the slate it replaced. This is the one
            // line the player has to act on, and at #334155 on a white bubble it
            // rendered as grey mush in LINE on a phone. Warm orange also keeps
            // it distinct from the account number directly above it, which is
            // already blue and is data rather than instruction.
            color: '#C2410C',
            weight: 'bold',
            size: 'xs',
            wrap: true,
            align: 'center',
          },
        ],
      },
    },
  };
}

/** Slip verified and credited — the player sees the amount the slip proved. */
export function generateSlipCreditedFlex(amount: number, newBalance: number, refCode: string): any {
  const formattedAmt = Number(amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formattedBal = Number(newBalance || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    type: 'flex',
    altText: `✅ เติมเครดิต ${formattedAmt} บาทเรียบร้อย`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#059669',
        paddingAll: 'sm',
        contents: [
          { type: 'text', text: '✅ เติมเครดิตเรียบร้อย', weight: 'bold', color: '#FFFFFF', size: 'xs', align: 'center' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: `+${formattedAmt} บาท`,
            weight: 'bold',
            color: '#059669',
            size: 'xl',
            align: 'center',
          },
          {
            type: 'text',
            text: 'ระบบอ่านยอดจากสลิปของคุณแล้วครับ',
            color: '#64748B',
            size: 'xs',
            align: 'center',
            wrap: true,
          },
          { type: 'separator', margin: 'sm', color: '#F1F5F9' },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '💎 แต้มคงเหลือ', color: '#94A3B8', size: 'xs', flex: 4 },
              { type: 'text', text: `${formattedBal} pt`, weight: 'bold', color: '#0F172A', size: 'xs', flex: 6, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '🔖 เลขอ้างอิง', color: '#94A3B8', size: 'xs', flex: 4 },
              { type: 'text', text: refCode, color: '#64748B', size: 'xs', flex: 6, align: 'end', wrap: true },
            ],
          },
        ],
      },
    },
  };
}
// ── 8. Deposit Invoice Card (ใบแจ้งโอนเงินฝาก) ──
export function generateDepositInvoiceFlex(depositAmt: number): any {
  const formattedAmt = Number(depositAmt || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    type: 'flex',
    altText: `🧾 ใบแจ้งโอนเงินฝาก ${formattedAmt} THB`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#10B981',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '🧾 ใบแจ้งโอนเงินฝาก',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: `${formattedAmt} THB`,
            weight: 'bold',
            color: '#059669',
            size: 'xl',
            align: 'center',
          },
          {
            type: 'text',
            text: 'ยอดเงินที่ต้องโอน',
            color: '#94A3B8',
            size: 'xs',
            align: 'center',
          },
          {
            type: 'separator',
            margin: 'xs',
            color: '#F1F5F9',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'xs',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '🏦 ธนาคาร', color: '#94A3B8', size: 'xs', flex: 4 },
                  { type: 'text', text: 'SCB (ไทยพาณิชย์)', weight: 'bold', color: '#334155', size: 'xs', flex: 6, align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '🔢 เลขบัญชี', color: '#94A3B8', size: 'xs', flex: 4 },
                  { type: 'text', text: '890-1-23456-7', weight: 'bold', color: '#0369A1', size: 'xs', flex: 6, align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '👤 ชื่อบัญชี', color: '#94A3B8', size: 'xs', flex: 4 },
                  { type: 'text', text: 'Somchai Jongcharoen', weight: 'bold', color: '#334155', size: 'xs', flex: 6, align: 'end' },
                ],
              },
            ],
          },
          {
            type: 'separator',
            margin: 'xs',
            color: '#F1F5F9',
          },
          {
            type: 'text',
            text: '⚠️ โอนเสร็จแล้ว กรุณาส่ง "รูปสลิป" เข้ามาในแชทนี้ได้เลยครับ ระบบจะตรวจสอบและเติมเครดิตให้อัตโนมัติ 🙏',
            size: 'xs',
            color: '#EA580C',
            align: 'center',
            wrap: true,
            margin: 'xs',
          },
        ],
      },
    },
  };
}

// ── 9. Withdrawal Card (ถอนเงินคืน) ──
export function generateWithdrawalFlex(bankName: string, accountNumber: string, accountName: string, balance: number): any {
  const formattedBal = Number(balance || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return {
    type: 'flex',
    altText: '💸 แจ้งถอนเงินคืน',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#475569',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: '💸 แจ้งถอนเงินคืน',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'xs',
            align: 'center',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'sm',
        contents: [
          {
            type: 'text',
            text: `${formattedBal} pt`,
            weight: 'bold',
            color: '#059669',
            size: 'xl',
            align: 'center',
          },
          { type: 'separator', margin: 'sm', color: '#F1F5F9' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'xs',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '🏦 ธนาคาร', color: '#94A3B8', size: 'xs', flex: 4 },
                  { type: 'text', text: bankName || '-', weight: 'bold', color: '#334155', size: 'xs', flex: 6, align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '🔢 เลขบัญชี', color: '#94A3B8', size: 'xs', flex: 4 },
                  { type: 'text', text: accountNumber || '-', weight: 'bold', color: '#334155', size: 'xs', flex: 6, align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '👤 ชื่อบัญชี', color: '#94A3B8', size: 'xs', flex: 4 },
                  { type: 'text', text: accountName || '-', weight: 'bold', color: '#334155', size: 'xs', flex: 6, align: 'end' },
                ],
              },
            ],
          },
          {
            type: 'separator',
            margin: 'xs',
            color: '#F1F5F9',
          },
          {
            type: 'text',
            text: 'พิมพ์ "ถอน [จำนวน]"',
            size: 'xs',
            color: '#2563EB',
            align: 'center',
            wrap: true,
            margin: 'xs',
          },
        ],
      },
    },
  };
}

// ── 10. Bank Registration Card ──
/**
 * Asked to withdraw before their bank details are on file.
 *
 * Three things only: the format they must type (which they cannot guess), the
 * fact that nothing was deducted yet (the request is abandoned at this point,
 * and a player who cannot tell that will assume their points are gone), and the
 * exact command to repeat once they have sent it.
 */
export function generateBankRegistrationFlex(pendingAmount?: number): any {
  const retry =
    pendingAmount && pendingAmount > 0
      ? ` — แล้วพิมพ์ "ถอน ${Number(pendingAmount).toLocaleString('th-TH')}" อีกครั้ง`
      : '';

  return {
    type: 'flex',
    altText: '🏦 ข้อมูลบัญชีธนาคาร',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0284C7',
        paddingAll: 'sm',
        contents: [
          { type: 'text', text: '🏦 ข้อมูลบัญชีธนาคาร', weight: 'bold', color: '#FFFFFF', size: 'xs', align: 'center' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F8FAFC',
            paddingAll: 'sm',
            cornerRadius: 'sm',
            contents: [
              {
                type: 'text',
                text: 'บัญชี [ธนาคาร] [เลขบัญชี] [ชื่อ-สกุล]\nเช่น กสิกร 0123456789 สมชาย',
                size: 'xs',
                color: '#0369A1',
                weight: 'bold',
                wrap: true,
              },
            ],
          },
          {
            type: 'text',
            text: `ยังไม่หักแต้ม — ส่งแล้วพิมพ์ "ถอน" อีกครั้ง${retry}`,
            size: 'xs',
            color: '#EA580C',
            wrap: true,
            margin: 'xs',
          },
        ],
      },
    },
  };
}

