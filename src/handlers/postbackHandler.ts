import { webhook, messagingApi } from '@line/bot-sdk';
import { matchOrderTransaction, getOrder } from '../services/firestoreService.js';
import { generateMatchSuccessFlex, generateMatchFailureFlex } from '../services/flexOrderService.js';

export async function handlePostbackEvent(
  event: webhook.PostbackEvent,
  client: messagingApi.MessagingApiClient
): Promise<void> {
  const replyToken = event.replyToken;
  const userId = event.source?.userId;

  if (!userId || !replyToken) {
    console.warn('[PostbackHandler] Missing userId or replyToken in event');
    return;
  }

  // Parse query string data format (e.g. "action=match_order&order_id=123&amount=500")
  const data = event.postback.data;
  const params = new URLSearchParams(data);
  const action = params.get('action');
  const orderId = params.get('order_id');

  if (action !== 'match_order' || !orderId) {
    console.log(`[PostbackHandler] Ignored non-matching action: ${action}`);
    return;
  }

  // Fetch player profile from LINE to display friendly name
  let displayName = 'ผู้เล่น';
  try {
    const profile = await client.getProfile(userId);
    if (profile?.displayName) {
      displayName = profile.displayName;
    }
  } catch (err: any) {
    console.warn(`[PostbackHandler] Could not fetch profile for ${userId}: ${err?.message || err}`);
  }

  try {
    // 1. Execute Atomic Transaction Lock
    const result = await matchOrderTransaction(orderId, userId, displayName);
    
    // 2. Reply match success card to group/chat
    const successFlex = generateMatchSuccessFlex(result.order, displayName);
    await client.replyMessage({
      replyToken,
      messages: [successFlex],
    });

    console.log(`[PostbackHandler] Successfully matched Order #${result.order.orderNumber} for user ${displayName} (${userId})`);
  } catch (err: any) {
    console.error(`[PostbackHandler] Order matching transaction failed for ${orderId}: ${err?.message || err}`);

    const existingOrder = await getOrder(orderId).catch(() => null);
    const orderNumber = existingOrder?.orderNumber || orderId;

    let userReason = 'เกิดข้อผิดพลาดในการจับคู่ กรุณาลองใหม่อีกครั้ง';
    if (err.message?.includes('ALREADY_MATCHED')) {
      userReason = 'แผลนี้มีผู้เล่นท่านอื่นกดจับคู่ตัดหน้าไปแล้วครับ ⚡️';
    } else if (err.message?.includes('CANNOT_MATCH_OWN_ORDER')) {
      userReason = 'ไม่สามารถดวลกับแผลที่ตนเองเป็นคนเปิดได้ครับ 🙅‍♂️';
    } else if (err.message?.includes('ORDER_NOT_FOUND')) {
      userReason = 'ไม่พบข้อมูลแผลนี้ในระบบ (อาจถูกยกเลิกไปแล้ว)';
    }

    const failureFlex = generateMatchFailureFlex(orderNumber, userReason);
    try {
      await client.replyMessage({
        replyToken,
        messages: [failureFlex],
      });
    } catch (replyErr) {
      console.error('[PostbackHandler] Failed to dispatch failure reply:', replyErr);
    }
  }
}
