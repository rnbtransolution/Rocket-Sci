import { Order } from './types.js';

/**
 * Pre-compiled, ultra-fast Flex Message generator for Cloudflare Workers.
 * Avoids recursive object re-allocations and heavy serialization overhead.
 */

// ── 1. Order Creation Card (Open for Matching in Group Chat) ──
export function generateOrderFlex(order: Order): any {
  const { orderNumber, amount, side, userTypedCmd, isChotoy, rocketName, rangeMin, rangeMax } = order as any;
  const sideShort = side === 'low' ? 'ล' : 'ถ';
  let cleanCmd = (userTypedCmd && typeof userTypedCmd === 'string') ? userTypedCmd.trim() : `${sideShort}${amount}`;
  cleanCmd = cleanCmd.replace(/^\d+[-/]\d+/, '').replace(/pt$/i, '').trim() || `${sideShort}${amount}`;

  const cardTitle = cleanCmd.includes(amount.toString()) ? cleanCmd : `${cleanCmd} ${amount}`;
  const numAmount = Number(amount) || 100;

  const amt20 = Math.max(1, Math.round(numAmount * 0.20));
  const amt40 = Math.max(1, Math.round(numAmount * 0.40));
  const amt80 = Math.max(1, Math.round(numAmount * 0.80));
  const amt100 = numAmount;

  return {
    type: 'flex',
    altText: `🚀 เปิดดวล #${orderNumber} [${cardTitle}] ${numAmount}pt`,
    contents: {
      type: 'bubble',
      size: 'kilo',
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
        spacing: 'xs',
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
          ...(rocketName ? [{
            type: 'text',
            text: `🚀 บั้งไฟ: ${rocketName}`,
            color: '#64748B',
            size: 'xxs',
            align: 'center',
            wrap: true,
          }] : []),
          {
            type: 'separator',
            margin: 'xs',
            color: '#F1F5F9',
          },
          // Row 1: 20%, 40%, 80% Quick Deal Buttons
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            margin: 'xs',
            contents: [
              { label: `${amt20}`, val: amt20 },
              { label: `${amt40}`, val: amt40 },
              { label: `${amt80}`, val: amt80 },
            ].map(item => ({
              type: 'box',
              layout: 'vertical',
              flex: 1,
              backgroundColor: '#BAE6FD',
              cornerRadius: 'sm',
              paddingAll: 'xs',
              action: {
                type: 'message',
                label: item.label,
                text: `ต ${orderNumber} ${item.val}`,
              },
              contents: [
                { type: 'text', text: item.label, color: '#0369A1', weight: 'bold', size: 'xs', align: 'center', wrap: true },
              ],
            })),
          },
          // Row 2: 100% & Cancel Buttons
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            margin: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#BBF7D0',
                cornerRadius: 'sm',
                paddingAll: 'xs',
                action: {
                  type: 'message',
                  label: `${amt100}`,
                  text: `ต ${orderNumber} ${amt100}`,
                },
                contents: [
                  { type: 'text', text: `${amt100}`, color: '#15803D', weight: 'bold', size: 'xs', align: 'center', wrap: true },
                ],
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#FECDD3',
                cornerRadius: 'sm',
                paddingAll: 'xs',
                action: {
                  type: 'message',
                  label: '⛔ ยกเลิก',
                  text: `ยกเลิก ${orderNumber}`,
                },
                contents: [
                  { type: 'text', text: '⛔ ยกเลิก', color: '#9F1239', weight: 'bold', size: 'xs', align: 'center', wrap: true },
                ],
              },
            ],
          },
          {
            type: 'text',
            text: `หรือพิมพ์: ${orderNumber} [จำนวนแต้ม]`,
            size: 'xxs',
            color: '#2563EB',
            weight: 'bold',
            align: 'center',
            margin: 'xs',
            wrap: true,
          },
        ],
      },
    },
  };
}

// ── 2. Match Notification Card (Dispatched via Private DM to Matchers) ──
export function generateMatchNotificationFlex(order: Order): any {
  const { orderNumber, amount, creatorName, matcherName, side, rocketName, rangeMin, rangeMax } = order;
  const lowName = side === 'low' ? creatorName : (matcherName || '-');
  const highName = side === 'high' ? creatorName : (matcherName || '-');
  const rangeStr = (rangeMin && rangeMax) ? `${rangeMin}-${rangeMax}s` : 'ราคาช่าง';

  return {
    type: 'flex',
    altText: `🤝 จับคู่ดวลสำเร็จ! Order #${orderNumber} (${amount} pt)`,
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
            text: `🤝 แมตช์สำเร็จ! #${orderNumber}`,
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
            text: `🚀 บั้งไฟ: ${rocketName || 'รอบดวลสด'} (${rangeStr})`,
            color: '#64748B',
            size: 'xs',
            align: 'center',
          },
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
                  { type: 'text', text: '🔻 ต่ำ (Low)', color: '#2563EB', weight: 'bold', size: 'xxs', align: 'center' },
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
                  { type: 'text', text: '🔺 สูง (High)', color: '#DC2626', weight: 'bold', size: 'xxs', align: 'center' },
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
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'md',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `👤 คุณ ${displayName}`, color: '#64748B', size: 'xs' },
          { type: 'text', text: `${balance.toLocaleString()} pt`, weight: 'bold', color: '#059669', size: 'xl' },
          { type: 'text', text: '💡 พิมพ์ "ฝากเงิน" เพื่อเติมแต้ม หรือ "ถอนเงิน" เพื่อแจ้งถอน', color: '#94A3B8', size: 'xxs' },
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
            size: 'xxs',
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
                size: 'xxs',
                wrap: true,
                margin: 'xs',
              },
              {
                type: 'text',
                text: '💵 พิมพ์คีย์เวิร์ดตามด้วยจำนวนเงิน (ตัวเลขเท่านั้น)\nเช่น ชล100 , ชล1000 , ชล10000',
                color: '#065F46',
                size: 'xxs',
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
                text: '• ช่างยัง / ช่างถอย / ชย\n• ชถ / ยัง / ย / ถอย / ถ\n• +5ชย / +5ชถ / +5ย / +5ถ\n• -5ชย / -5ชถ / -5ย / -5ถ\nเช่น ชถ100 , ชถ1000',
                color: '#047857',
                size: 'xxs',
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
                size: 'xxs',
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
                size: 'xxs',
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

// ── 6. Main Menu Quick Reply (เมนูหลักระบบดวล — 1:1 chat only) ──
const MAIN_MENU_QUICK_REPLY_ITEMS = [
  { type: 'action', action: { type: 'message', label: '💳 เช็คยอด', text: 'เช็คยอด' } },
  { type: 'action', action: { type: 'message', label: '💰 ฝากเงิน', text: 'ฝากเงิน' } },
  { type: 'action', action: { type: 'message', label: '💸 ถอนเงิน', text: 'ถอนเงิน' } },
  { type: 'action', action: { type: 'message', label: '📖 กติกา', text: 'กติกา' } },
  { type: 'action', action: { type: 'message', label: '📋 กระดานดวล', text: 'กระดานดวล' } },
];

/**
 * Attach the floating main-menu Quick Reply to any outgoing private-chat message.
 * This guarantees the menu keys stay visible after EVERY bot reply (not only after
 * the "เมนู" command). SKIPPED when the payload is an interactive menu object that
 * must render inside LINE's input area (e.g. welcome/menu flex cards) — in those
 * cases users reach the menu through the splash screen instead.
 */
export function attachMainMenuQuickReply(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;
  const type = payload.type;
  // Only wrap LINE message objects (text / flex). Pure bubbles/carousels are nested
  // objects, not standalone message objects — never attach quickReply to those.
  if (type === 'bubble' || type === 'carousel') return payload;
  if (type !== 'text' && type !== 'flex') return payload;
  // Skip the interactive menu flex card (it duplicates the Quick Reply itself).
  const text = (payload.text || payload.altText || '').toString();
  if (text.includes('เมนูหลัก') && type === 'flex') return payload;
  // Never override a payload that already defines its own Quick Reply.
  if (payload.quickReply && Array.isArray(payload.quickReply.items) && payload.quickReply.items.length > 0) {
    return payload;
  }
  return { ...payload, quickReply: { items: MAIN_MENU_QUICK_REPLY_ITEMS } };
}

export function generateMainMenuQuickReply(displayName: string, balance: number): any {
  return {
    type: 'text',
    text: '🚀 Rocket Science เมนูหลัก (1:1)\n\nดูแต้ม เติมเงิน ถอนเงิน และกติกาได้จากปุ่มด้านล่างเลยครับ 👇',
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
            size: 'xxs',
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

// ── 7. Deposit Options Card (เลือกยอดฝาก) ──
export function generateDepositFlex(): any {
  return {
    type: 'flex',
    altText: '💰 ฝากเครดิตเข้าระบบ',
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
            type: 'text',
            text: 'เลือกยอดเงินที่ต้องการฝาก หรือพิมพ์จำนวนเงิน เช่น "1000"',
            size: 'xxs',
            color: '#64748B',
            align: 'center',
            wrap: true,
          },
          {
            type: 'separator',
            margin: 'xs',
            color: '#F1F5F9',
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            margin: 'xs',
            contents: [
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: '#10B981',
                action: { type: 'message', label: '100 บาท', text: '100' },
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: '#10B981',
                action: { type: 'message', label: '300 บาท', text: '300' },
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
                style: 'primary',
                height: 'sm',
                color: '#10B981',
                action: { type: 'message', label: '500 บาท', text: '500' },
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: '#10B981',
                action: { type: 'message', label: '1,000 บาท', text: '1000' },
              },
            ],
          },
          {
            type: 'text',
            text: '💡 หรือพิมพ์จำนวนเงินที่ต้องการฝากเข้ามาได้ทันที',
            size: 'xxs',
            color: '#94A3B8',
            align: 'center',
            margin: 'xs',
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
            size: 'xxs',
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
                  { type: 'text', text: '🏦 ธนาคาร', color: '#94A3B8', size: 'xxs', flex: 4 },
                  { type: 'text', text: 'SCB (ไทยพาณิชย์)', weight: 'bold', color: '#334155', size: 'xxs', flex: 6, align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '🔢 เลขบัญชี', color: '#94A3B8', size: 'xxs', flex: 4 },
                  { type: 'text', text: '064-2-35656-6', weight: 'bold', color: '#0369A1', size: 'xs', flex: 6, align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '👤 ชื่อบัญชี', color: '#94A3B8', size: 'xxs', flex: 4 },
                  { type: 'text', text: 'อิทธิรัตน์ แนวหล่า', weight: 'bold', color: '#334155', size: 'xxs', flex: 6, align: 'end' },
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
            size: 'xxs',
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
          {
            type: 'text',
            text: 'เครดิตคงเหลือ',
            color: '#94A3B8',
            size: 'xxs',
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
                  { type: 'text', text: '🏦 ธนาคาร', color: '#94A3B8', size: 'xxs', flex: 4 },
                  { type: 'text', text: bankName || '-', weight: 'bold', color: '#334155', size: 'xxs', flex: 6, align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '🔢 เลขบัญชี', color: '#94A3B8', size: 'xxs', flex: 4 },
                  { type: 'text', text: accountNumber || '-', weight: 'bold', color: '#334155', size: 'xxs', flex: 6, align: 'end' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '👤 ชื่อบัญชี', color: '#94A3B8', size: 'xxs', flex: 4 },
                  { type: 'text', text: accountName || '-', weight: 'bold', color: '#334155', size: 'xxs', flex: 6, align: 'end' },
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
            text: '💡 พิมพ์ "ถอน [จำนวน]" เช่น "ถอน 500"\n(ถอนขั้นต่ำ 100 pt)',
            size: 'xxs',
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
export function generateBankRegistrationFlex(): any {
  return {
    type: 'flex',
    altText: '🏦 ลงทะเบียนบัญชีธนาคาร',
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
            text: '🏦 ลงทะเบียนบัญชีธนาคาร',
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
            text: 'เพื่อความสะดวกรวดเร็วในการถอนเงิน กรุณาพิมพ์แจ้งข้อมูลบัญชีธนาคารของท่านในรูปแบบดังนี้ครับ:',
            size: 'xxs',
            color: '#475569',
            wrap: true,
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F8FAFC',
            paddingAll: 'xs',
            cornerRadius: 'sm',
            margin: 'xs',
            contents: [
              {
                type: 'text',
                text: 'พิมพ์:\nบัญชี [ธนาคาร] [เลขบัญชี] [ชื่อ-สกุล]\n\nตัวอย่าง:\nบัญชี กสิกร 0123456789 สมชาย ใจดี',
                size: 'xxs',
                color: '#0369A1',
                weight: 'bold',
                wrap: true,
              },
            ],
          },
        ],
      },
    },
  };
}

