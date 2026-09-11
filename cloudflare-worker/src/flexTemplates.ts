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
