import NodeCache from 'node-cache';
import { OrderData } from './firestoreService.js';

// In-Memory Caching (Phase 4): Cache static Flex structures and templates
export const flexCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

/**
 * Generate a dynamic LINE Flex Message bubble for open orders with a Postback match button.
 */
export function generateOrderFlex(order: OrderData): any {
  const isHigh = order.side === 'high' || order.side === 'สูง' || order.side === 'ชล' || order.side === 'ล';
  const sideColor = isHigh ? '#2563EB' : '#DC2626'; // Blue for High, Red for Low
  const sideNameTh = isHigh ? 'สูง (High / ไล่)' : 'ต่ำ (Low / ถอย)';
  const opposingSideTh = isHigh ? 'ต่ำ (Low / ยั่ง)' : 'สูง (High / ไล่)';
  const rocketLabel = order.rocketName ? `🚀 บั้งไฟ: ${order.rocketName}` : '🚀 บั้งไฟเปิดรับดวล';

  const orderId = order.id || order.orderNumber;

  return {
    type: 'flex',
    altText: `🎯 แผลเปิดดวล #${order.orderNumber} | ${sideNameTh} ${order.amount} pt`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: sideColor,
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: '🔥 แผลเปิดรับคู่ดวล 🔥',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'md',
            align: 'center',
          },
          {
            type: 'text',
            text: `Order #${order.orderNumber}`,
            color: '#FFFFFFCC',
            size: 'xs',
            align: 'center',
            margin: 'xs',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: rocketLabel,
            size: 'sm',
            color: '#475569',
            weight: 'bold',
            align: 'center',
          },
          {
            type: 'separator',
            color: '#E2E8F0',
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'ผู้เปิดแผล:',
                size: 'sm',
                color: '#64748B',
                flex: 2,
              },
              {
                type: 'text',
                text: order.creatorName || 'ผู้เล่น',
                size: 'sm',
                color: '#0F172A',
                weight: 'bold',
                flex: 3,
                align: 'end',
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'ฝั่งที่ถือ:',
                size: 'sm',
                color: '#64748B',
                flex: 2,
              },
              {
                type: 'text',
                text: sideNameTh,
                size: 'sm',
                color: sideColor,
                weight: 'bold',
                flex: 3,
                align: 'end',
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'ยอดดวล:',
                size: 'sm',
                color: '#64748B',
                flex: 2,
              },
              {
                type: 'text',
                text: `${order.amount.toLocaleString()} pt`,
                size: 'lg',
                color: '#D97706',
                weight: 'bold',
                flex: 3,
                align: 'end',
              },
            ],
          },
          ...(order.rangeMin && order.rangeMax ? [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                {
                  type: 'text',
                  text: 'ช่วงราคา:',
                  size: 'xs',
                  color: '#64748B',
                  flex: 2,
                },
                {
                  type: 'text',
                  text: `${order.rangeMin}-${order.rangeMax} วิ`,
                  size: 'xs',
                  color: '#334155',
                  flex: 3,
                  align: 'end',
                },
              ],
            },
          ] : []),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: isHigh ? '#DC2626' : '#2563EB', // Button to match opposing side
            height: 'sm',
            action: {
              type: 'postback',
              label: `⚡️ ดวลฝั่ง ${opposingSideTh}`,
              data: `action=match_order&order_id=${orderId}&amount=${order.amount}`,
              displayText: `ต #${order.orderNumber} ${order.amount} pt`,
            },
          },
          {
            type: 'text',
            text: '💡 กดปุ่มด้านบนเพื่อจับคู่ดวลทันที (ความเร็วสูง)',
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

/**
 * Generate a Flex Message confirming successful atomic order match.
 */
export function generateMatchSuccessFlex(order: OrderData, matcherName: string): any {
  return {
    type: 'flex',
    altText: `🤝 ดวลสำเร็จ! Order #${order.orderNumber} (${order.amount} pt)`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#059669', // Emerald
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: '⚔️ แมตช์สำเร็จ! แผลถูกล็อคแล้ว ⚔️',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'md',
            align: 'center',
          },
          {
            type: 'text',
            text: `Order #${order.orderNumber}`,
            color: '#FFFFFFCC',
            size: 'xs',
            align: 'center',
            margin: 'xs',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'ผู้เปิดแผล:',
                size: 'sm',
                color: '#64748B',
                flex: 2,
              },
              {
                type: 'text',
                text: `${order.creatorName} (${order.side})`,
                size: 'sm',
                color: '#0F172A',
                weight: 'bold',
                flex: 3,
                align: 'end',
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'คู่ดวล (ติดแผล):',
                size: 'sm',
                color: '#64748B',
                flex: 2,
              },
              {
                type: 'text',
                text: matcherName,
                size: 'sm',
                color: '#059669',
                weight: 'bold',
                flex: 3,
                align: 'end',
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'ยอดดวลรวม:',
                size: 'sm',
                color: '#64748B',
                flex: 2,
              },
              {
                type: 'text',
                text: `${order.amount.toLocaleString()} pt`,
                size: 'lg',
                color: '#D97706',
                weight: 'bold',
                flex: 3,
                align: 'end',
              },
            ],
          },
          {
            type: 'separator',
            color: '#E2E8F0',
          },
          {
            type: 'text',
            text: '🔒 แผลได้รับการจับคู่โดยสมบูรณ์ ไม่อนุญาตให้ยกเลิกทุกกรณี 🚀',
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

/**
 * Generate a concise error Flex Message when matching fails (e.g. already matched race condition).
 */
export function generateMatchFailureFlex(orderNumber: string, reason: string): any {
  const cacheKey = `fail_${orderNumber}_${reason}`;
  const cached = flexCache.get(cacheKey);
  if (cached) return cached;

  const flex = {
    type: 'flex',
    altText: `⚠️ ไม่สามารถจับคู่ Order #${orderNumber}`,
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
            text: '⚠️ จับคู่ไม่สำเร็จ',
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
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: `Order #${orderNumber}`,
            weight: 'bold',
            size: 'sm',
            color: '#1E293B',
            align: 'center',
          },
          {
            type: 'text',
            text: reason,
            size: 'xs',
            color: '#64748B',
            align: 'center',
            wrap: true,
          },
        ],
      },
    },
  };
  flexCache.set(cacheKey, flex);
  return flex;
}
