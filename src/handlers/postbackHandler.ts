import { webhook, messagingApi } from '@line/bot-sdk';
import { matchOrderTransaction, getOrder } from '../services/firestoreService.js';
import { generateMatchSuccessFlex, generateMatchFailureFlex } from '../services/flexOrderService.js';

export async function handlePostbackEvent(
  event: webhook.PostbackEvent,
  client: messagingApi.MessagingApiClient
): Promise<void> {
  const userId = event.source?.userId;
  const isGroup = event.source?.type === 'group' || event.source?.type === 'room';

  if (!userId) {
    console.warn('[PostbackHandler] Missing userId in postback event');
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
    
    // 2. Direct Message Notification (1-on-1 DM):
    // STRICT RULE: Never reply back to the Group Chat (groupId) for user actions.
    // Do NOT use replyToken in group context for postback interactions.
    // Send the result notification directly to the user's personal LINE chat (userId).
    const successFlex = generateMatchSuccessFlex(result.order, displayName);
    try {
      await client.pushMessage({
        to: userId,
        messages: [successFlex],
      });
      console.log(`[PostbackHandler] DM sent to ${displayName} (${userId}) for matched Order #${result.order.orderNumber}`);
    } catch (pushErr: any) {
      console.warn(`[PostbackHandler] Could not DM user ${userId} (user may not have added LINE OA as friend):`, pushErr?.message || pushErr);
    }
  } catch (err: any) {
    console.warn(`[PostbackHandler] Order matching transaction failed for ${orderId}: ${err?.message || err}`);

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

    // Push failure / too-late notification to user's personal 1-on-1 DM
    try {
      await client.pushMessage({
        to: userId,
        messages: [failureFlex],
      });
      console.log(`[PostbackHandler] DM failure notice sent to ${displayName} (${userId}) for Order #${orderNumber}`);
    } catch (pushErr: any) {
      console.warn(`[PostbackHandler] Could not DM failure notice to user ${userId} (user may not have added LINE OA as friend):`, pushErr?.message || pushErr);
    }
  }
}
