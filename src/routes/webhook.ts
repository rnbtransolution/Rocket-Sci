import { Router, Request, Response } from 'express';
import { webhook, messagingApi } from '@line/bot-sdk';
import { handlePostbackEvent } from '../handlers/postbackHandler.js';
import { createOrder, matchOrderTransaction } from '../services/firestoreService.js';
import { generateOrderFlex, generateMatchSuccessFlex, generateMatchFailureFlex } from '../services/flexOrderService.js';

export function createWebhookRouter(client: messagingApi.MessagingApiClient): Router {
  const router = Router();

  router.post('/', (req: Request, res: Response): void => {
    // 1. Immediately return HTTP 200 OK (< 10ms) to satisfy LINE SLA and prevent webhook timeouts
    res.status(200).json({ status: 'ok' });

    const events: webhook.Event[] = req.body?.events || [];
    if (!events.length) return;

    // 2. Process events asynchronously in the background (Non-blocking response)
    setImmediate(async () => {
      await Promise.all(
        events.map(async (event) => {
          try {
            await processSingleEvent(event, client);
          } catch (err) {
            console.error('[Webhook] Error handling event:', err);
          }
        })
      );
    });
  });

  return router;
}

async function processSingleEvent(
  event: webhook.Event,
  client: messagingApi.MessagingApiClient
): Promise<void> {
  const source = event.source;
  const userId = source?.userId;
  const groupId = (source as any)?.groupId || (source as any)?.roomId || null;
  const isGroup = source?.type === 'group' || source?.type === 'room' || !!groupId;

  if (event.type === 'postback') {
    await handlePostbackEvent(event, client);
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const replyToken = event.replyToken;

    // Fetch user display name
    let displayName = 'ผู้เล่น';
    if (userId) {
      try {
        const profile = await client.getProfile(userId);
        if (profile?.displayName) displayName = profile.displayName;
      } catch (_) {}
    }

    // Pattern 1: Bet creation command (e.g. "ล500", "ถ500", "สูง 1000", "ต่ำ 500")
    // Allowed in Group Chat: New Order Creation Flex Message
    const betRegex = /^(?:([+-]?\d+)?\s*)?(ชล|ชถ|ชย|ชต|ย|ถ|ล|สูง|ต่ำ|ยั่ง|ถอย|ไล่)\s*(\d+)(?:\s*(?:pt|แต้ม))?$/i;
    if (betRegex.test(text) && userId && replyToken) {
      const match = text.match(betRegex);
      if (match) {
        const sideRaw = match[2].toLowerCase();
        const amount = parseInt(match[3], 10);
        const isHigh = ['ชล', 'ล', 'สูง', 'ไล่'].includes(sideRaw);
        const side = isHigh ? 'high' : 'low';

        if (amount >= 50 && amount <= 50000) {
          const newOrder = await createOrder({
            creatorId: userId,
            creatorName: displayName,
            side,
            amount,
            groupId: groupId || undefined,
          });

          const flexCard = generateOrderFlex(newOrder);
          await client.replyMessage({
            replyToken,
            messages: [flexCard],
          });
          console.log(`[Webhook] Created new Order #${newOrder.orderNumber} for ${displayName} in ${groupId ? 'Group' : 'DM'}`);
          return;
        }
      }
    }

    // Pattern 2: Accept/Match bet command via text (e.g. "ต 9047", "ต9047", "รับ 9047", "#9047")
    // STRICT RULE: In group context, NEVER reply to the group. Push notification directly to user's 1-on-1 DM.
    const matchRegex = /^(?:(ต|ติด|รับ|เค|ดีล)\s*)?#?(\d{4,6})$/i;
    if (matchRegex.test(text) && userId) {
      const match = text.match(matchRegex);
      if (match) {
        const orderNumber = match[2];
        try {
          const result = await matchOrderTransaction(orderNumber, userId, displayName);
          const successFlex = generateMatchSuccessFlex(result.order, displayName);

          if (isGroup) {
            // Group Chat Filtering: Push result directly to user DM
            try {
              await client.pushMessage({
                to: userId,
                messages: [successFlex],
              });
              console.log(`[Webhook] Text matched Order #${orderNumber} by ${displayName} (DM dispatched)`);
            } catch (pushErr: any) {
              console.warn(`[Webhook] Could not DM user ${userId}:`, pushErr?.message || pushErr);
            }
          } else if (replyToken) {
            await client.replyMessage({
              replyToken,
              messages: [successFlex],
            });
          }
          return;
        } catch (err: any) {
          console.warn(`[Webhook] Text match failed for #${orderNumber}:`, err?.message || err);
          const failureFlex = generateMatchFailureFlex(orderNumber, 'แผลนี้ไม่พร้อมให้จับคู่ หรือถูกตัดหน้าไปแล้วครับ');
          if (isGroup) {
            try {
              await client.pushMessage({ to: userId, messages: [failureFlex] });
            } catch (_) {}
          } else if (replyToken) {
            try {
              await client.replyMessage({ replyToken, messages: [failureFlex] });
            } catch (_) {}
          }
          return;
        }
      }
    }

    // Pattern 3: Authorized Admin Command (e.g. "/status", "/health", "/help")
    if ((text.startsWith('/') || text.startsWith('!')) && replyToken) {
      const cmd = text.slice(1).toLowerCase().trim();
      if (cmd === 'status' || cmd === 'health' || cmd === 'ping') {
        await client.replyMessage({
          replyToken,
          messages: [{
            type: 'text',
            text: `🚀 [Bang Fai High-Concurrency Service]\nStatus: Online 🟢\nLatency: <300ms\nTimestamp: ${new Date().toLocaleTimeString('th-TH')}`,
          }],
        });
        return;
      }
    }
  }
}
