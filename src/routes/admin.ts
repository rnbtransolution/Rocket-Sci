import { Router, Request, Response } from 'express';
import { messagingApi } from '@line/bot-sdk';
import { getActiveGroups, recordActiveGroup } from '../handlers/groupHandler.js';
import { createOrder } from '../services/firestoreService.js';
import { generateOrderFlex } from '../services/flexOrderService.js';

export function createAdminRouter(client: messagingApi.MessagingApiClient): Router {
  const router = Router();

  /**
   * Helper: Validate Admin Secret Key
   */
  const checkAdminAuth = (req: Request, res: Response, next: () => void): void => {
    const secretKey = process.env.ADMIN_SECRET_KEY || process.env.ADMIN_API_KEY || '';
    if (!secretKey) {
      console.warn('[Admin Auth] Warning: Neither ADMIN_SECRET_KEY nor ADMIN_API_KEY is configured on server');
      res.status(500).json({
        success: false,
        reason: 'SERVER_MISCONFIGURED',
        error: 'ADMIN_SECRET_KEY is not configured on server',
      });
      return;
    }

    const providedKey =
      req.body?.adminKey ||
      req.body?.apiKey ||
      (req.headers['x-admin-key'] as string) ||
      (req.headers['x-admin-api-key'] as string) ||
      (req.query?.adminKey as string) ||
      (req.query?.apiKey as string) ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!providedKey || providedKey !== secretKey) {
      console.warn(`[Admin Auth] Rejected unauthorized request to ${req.originalUrl || req.path}. Provided key: ${providedKey ? '***' : 'none'}`);
      res.status(401).json({
        success: false,
        reason: 'INVALID_ADMIN_KEY',
        error: 'Unauthorized: Missing or invalid adminKey',
      });
      return;
    }

    next();
  };

  /**
   * GET /api/admin/groups
   * Returns the list of active group chats recorded in Firestore
   */
  router.get('/groups', checkAdminAuth, async (req: Request, res: Response): Promise<void> => {
    console.log('[Admin API] Incoming request to GET /api/admin/groups');
    try {
      const groups = await getActiveGroups();
      console.log(`[Admin API] Retrieved ${groups.length} active group(s)`);
      res.status(200).json({
        success: true,
        count: groups.length,
        groups,
      });
    } catch (err: any) {
      console.error('[Admin API] Error fetching active groups:', err);
      res.status(500).json({
        success: false,
        reason: 'FETCH_GROUPS_FAILED',
        error: err?.message || 'Failed to fetch active groups',
      });
    }
  });

  /**
   * POST /api/admin/push-order
   * Pushes an Order Flex message to a target group or the most recent active group
   */
  router.post('/push-order', checkAdminAuth, async (req: Request, res: Response): Promise<void> => {
    console.log('[Admin API] Incoming request to POST /api/admin/push-order:', JSON.stringify(req.body));
    try {
      const { targetGroupId, orderData } = req.body || {};

      if (!orderData || typeof orderData !== 'object') {
        console.warn('[Admin API] Push failed: Missing orderData object');
        res.status(400).json({
          success: false,
          reason: 'MISSING_ORDER_DATA',
          error: 'Missing required orderData object in request body',
        });
        return;
      }

      const rocketName = (orderData.rocketName || 'ค่ายบั้งไฟพญานาค').trim();
      const predictionType = (orderData.predictionType || 'สูง').trim();
      const amount = parseInt(orderData.amount, 10) || 500;

      if (amount <= 0) {
        console.warn(`[Admin API] Push failed: Invalid amount ${amount}`);
        res.status(400).json({
          success: false,
          reason: 'INVALID_AMOUNT',
          error: 'Invalid order amount (must be > 0)',
        });
        return;
      }

      // Determine betting side (high vs low) from predictionType
      const predLower = predictionType.toLowerCase();
      const isHigh =
        predLower.includes('สูง') ||
        predLower.includes('ชล') ||
        predLower.includes('ล') ||
        predLower.includes('ไล่') ||
        predLower.includes('high');
      const side = isHigh ? 'high' : 'low';

      // 1. Resolve target group ID(s)
      let targetGroupIds: string[] = [];
      if (targetGroupId && typeof targetGroupId === 'string' && targetGroupId.trim() !== '') {
        targetGroupIds = [targetGroupId.trim()];
        console.log(`[Admin API] Targeting specific group ID: ${targetGroupIds[0]}`);
      } else {
        // Fallback Group Logic: Fetch most recent active group ID from Firestore
        console.log('[Admin API] No targetGroupId provided. Looking up latest active group from Firestore...');
        const activeGroups = await getActiveGroups();
        if (!activeGroups || activeGroups.length === 0) {
          console.warn('[Admin API] Push failed: No active groups found in Firestore active_groups');
          res.status(400).json({
            success: false,
            reason: 'NO_ACTIVE_GROUP_FOUND',
            error: 'No target group found. Please add the bot to a LINE group first.',
          });
          return;
        }
        // Use the most recent active group ID (first element)
        const mostRecentGroup = activeGroups[0];
        targetGroupIds = [mostRecentGroup.groupId];
        console.log(`[Admin API] Selected most recent active group: ${mostRecentGroup.groupId} ("${mostRecentGroup.groupName || 'Unknown'}")`);
      }

      // 2. Persist order into Firestore with status OPEN so players can match it
      const newOrder = await createOrder({
        creatorId: 'ADMIN',
        creatorName: `ค่าย: ${rocketName}`,
        side,
        amount,
        rocketName,
        groupId: targetGroupIds[0],
      });

      // 3. Generate interactive Order Flex Message
      const flexPayload = generateOrderFlex(newOrder);

      // 4. Dispatch push message(s) to LINE
      const results: { groupId: string; success: boolean; error?: string }[] = [];

      await Promise.all(
        targetGroupIds.map(async (gid) => {
          try {
            console.log(`[Admin API] Dispatching pushMessage to group ${gid} for Order #${newOrder.orderNumber}...`);
            await client.pushMessage({
              to: gid,
              messages: [flexPayload],
            });
            results.push({ groupId: gid, success: true });
            console.log(`[Admin API] Successfully pushed Order #${newOrder.orderNumber} to group ${gid}`);
          } catch (err: any) {
            const errDetail = err?.response?.data?.message || err?.message || String(err);
            console.error(`[Admin API] Failed pushing Order #${newOrder.orderNumber} to group ${gid}:`, errDetail);
            results.push({ groupId: gid, success: false, error: errDetail });
          }
        })
      );

      const pushedCount = results.filter((r) => r.success).length;
      if (pushedCount === 0) {
        res.status(502).json({
          success: false,
          reason: 'LINE_PUSH_FAILED',
          error: results[0]?.error || 'Failed to push message to LINE group',
          orderNumber: newOrder.orderNumber,
          order: newOrder,
          results,
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: `Order #${newOrder.orderNumber} pushed successfully to ${pushedCount}/${targetGroupIds.length} group(s)`,
        orderNumber: newOrder.orderNumber,
        order: newOrder,
        results,
      });
    } catch (err: any) {
      console.error('[Admin API] Unexpected error in /api/admin/push-order:', err);
      res.status(500).json({
        success: false,
        reason: 'INTERNAL_SERVER_ERROR',
        error: err?.message || 'Internal server error processing push order',
      });
    }
  });

  // Also mount RPC route under router
  router.post('/run', handleAdminRpc(client));

  return router;
}

/**
 * Universal RPC Handler for React Dashboard calls (runBackendFunction / api/run)
 */
export function handleAdminRpc(client: messagingApi.MessagingApiClient) {
  return async (req: Request, res: Response): Promise<void> => {
    const secretKey = process.env.ADMIN_SECRET_KEY || process.env.ADMIN_API_KEY || '';
    const providedKey =
      req.body?.adminKey ||
      req.body?.apiKey ||
      (req.headers['x-admin-key'] as string) ||
      (req.headers['x-admin-api-key'] as string) ||
      (req.query?.adminKey as string) ||
      (req.query?.apiKey as string) ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');

    const { functionName, args = [] } = req.body || {};

    if (!functionName) {
      res.status(400).json({ success: false, reason: 'MISSING_FUNCTION_NAME', error: 'Missing functionName' });
      return;
    }

    // Require auth for mutations
    if (functionName !== 'getDashboardData') {
      if (secretKey && providedKey !== secretKey) {
        console.warn(`[Admin RPC] Rejected unauthorized call to "${functionName}". Provided key: ${providedKey ? '***' : 'none'}`);
        res.status(401).json({ success: false, reason: 'INVALID_ADMIN_KEY', error: 'Unauthorized: Invalid adminKey' });
        return;
      }
    }

    try {
      console.log(`[Admin RPC] Executing "${functionName}" with args:`, JSON.stringify(args).slice(0, 150));
      let data: any = null;

      switch (functionName) {
        case 'getDashboardData': {
          const activeGroups = await getActiveGroups();
          data = {
            activeGroupId: activeGroups[0]?.groupId || null,
            lineGroups: activeGroups.map((g) => ({ id: g.groupId, name: g.groupName || g.groupId })),
            players: [],
            transactions: [],
            bets: [],
            flightLogs: [],
          };
          break;
        }

        case 'adminDiscoverGroupIds': {
          const activeGroups = await getActiveGroups();
          data = {
            discovered: activeGroups.map((g) => ({ id: g.groupId, source: 'Firestore active_groups' })),
          };
          break;
        }

        case 'adminSetActiveGroupId': {
          const targetGid = args[0];
          if (targetGid) await recordActiveGroup(targetGid, client);
          data = { success: true, activeGroupId: targetGid };
          break;
        }

        case 'adminTestPushGroupMessage': {
          const target = args[0];
          const activeGroups = await getActiveGroups();
          const targetId = (target && target !== 'ALL') ? target : activeGroups[0]?.groupId;
          if (!targetId) {
            data = { success: false, reason: 'NO_ACTIVE_GROUP_FOUND', error: 'No active group found' };
            break;
          }
          await client.pushMessage({
            to: targetId,
            messages: [{ type: 'text', text: '⚡ ทดสอบการส่งข้อความแจ้งเตือนจากระบบแอดมิน (Admin Test Push 🟢)' }],
          });
          data = { success: true, targetId };
          break;
        }

        case 'sendAdminMessageToLine': {
          const target = args[0];
          const messageText = args[1] || '';
          const activeGroups = await getActiveGroups();
          const targetIds = (target && target !== 'ALL') ? [target] : activeGroups.map((g) => g.groupId);
          if (!targetIds.length) {
            data = { success: false, reason: 'NO_ACTIVE_GROUP_FOUND', error: 'No active groups found' };
            break;
          }
          await Promise.all(
            targetIds.map((gid) => client.pushMessage({ to: gid, messages: [{ type: 'text', text: messageText }] }))
          );
          data = { success: true, targets: targetIds };
          break;
        }

        case 'adminBroadcastQuote': {
          const [target, name, min, max, isChotoy] = args;
          const activeGroups = await getActiveGroups();
          const targetIds = (target && target !== 'ALL') ? [target] : activeGroups.map((g) => g.groupId);
          if (!targetIds.length) {
            data = { success: false, reason: 'NO_ACTIVE_GROUP_FOUND', error: 'No active groups found' };
            break;
          }

          const quoteFlex = {
            type: 'flex',
            altText: `🚀 บั้งไฟ [${name}] | ช่วงราคา ${min}-${max} วิ${isChotoy ? ' (ชตย)' : ''}`,
            contents: {
              type: 'bubble',
              size: 'mega',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#0284C7',
                paddingAll: 'md',
                contents: [
                  { type: 'text', text: '🚀 เปิดราคาดวลบั้งไฟ 🚀', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center' },
                  { type: 'text', text: name || 'บั้งไฟ', color: '#FFFFFFE6', size: 'sm', align: 'center', margin: 'xs', weight: 'bold' }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                  { type: 'text', text: `⏱️ ช่วงราคา: ${min}-${max} วิ${isChotoy ? ' (ชตย)' : ''}`, weight: 'bold', color: '#0284C7', size: 'sm', align: 'center' },
                  { type: 'text', text: '⚡ พิมพ์ ชล / ชถ (±5, ±10) ได้ทันที', color: '#64748B', size: 'xs', align: 'center' }
                ]
              }
            }
          };

          await Promise.all(targetIds.map((gid) => client.pushMessage({ to: gid, messages: [quoteFlex as any] })));
          data = { success: true, targets: targetIds };
          break;
        }

        case 'adminBroadcastFinalCall': {
          const target = args[0];
          const activeGroups = await getActiveGroups();
          const targetIds = (target && target !== 'ALL') ? [target] : activeGroups.map((g) => g.groupId);
          if (!targetIds.length) {
            data = { success: false, reason: 'NO_ACTIVE_GROUP_FOUND', error: 'No active groups found' };
            break;
          }

          const finalFlex = {
            type: 'flex',
            altText: '⛔ ปิดรับดวลรอบนี้แล้ว ⛔',
            contents: {
              type: 'bubble',
              size: 'mega',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#DC2626',
                paddingAll: 'md',
                contents: [
                  { type: 'text', text: '⛔ ปิดรับดวลรอบนี้แล้ว ⛔', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center' }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '🔒 แผลเปิดที่ไม่ติดคู่ดวล ถูกยกเลิกโดยอัตโนมัติ', size: 'xs', color: '#475569', align: 'center' },
                  { type: 'text', text: '⚠️ หลังจากนี้ ห้ามพิมพ์รายการใดๆ ทั้งสิ้นครับ', size: 'xs', color: '#DC2626', weight: 'bold', align: 'center' }
                ]
              }
            }
          };

          await Promise.all(targetIds.map((gid) => client.pushMessage({ to: gid, messages: [finalFlex as any] })));
          data = { success: true, targets: targetIds };
          break;
        }

        case 'adminBroadcastVoidRound': {
          const target = args[0];
          const activeGroups = await getActiveGroups();
          const targetIds = (target && target !== 'ALL') ? [target] : activeGroups.map((g) => g.groupId);
          if (!targetIds.length) {
            data = { success: false, reason: 'NO_ACTIVE_GROUP_FOUND', error: 'No active groups found' };
            break;
          }

          const voidFlex = {
            type: 'flex',
            altText: '⚠️ ประกาศโมฆะรอบการแข่งขัน ⚠️',
            contents: {
              type: 'bubble',
              size: 'mega',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#6B7280',
                paddingAll: 'md',
                contents: [
                  { type: 'text', text: '⚠️ ประกาศโมฆะรอบการแข่งขัน ⚠️', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center' }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: 'บั้งไฟแตก/บั้งไฟมีปัญหา ระบบคืนแต้มทุกรายการ', size: 'xs', color: '#374151', align: 'center' }
                ]
              }
            }
          };

          await Promise.all(targetIds.map((gid) => client.pushMessage({ to: gid, messages: [voidFlex as any] })));
          data = { success: true, targets: targetIds };
          break;
        }

        case 'adminBroadcastRuleGuide': {
          const target = args[0];
          const activeGroups = await getActiveGroups();
          const targetIds = (target && target !== 'ALL') ? [target] : activeGroups.map((g) => g.groupId);
          if (!targetIds.length) {
            data = { success: false, reason: 'NO_ACTIVE_GROUP_FOUND', error: 'No active groups found' };
            break;
          }

          const ruleFlex = {
            type: 'flex',
            altText: '📖 กติกาการดวลบั้งไฟ',
            contents: {
              type: 'bubble',
              size: 'mega',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#0F172A',
                paddingAll: 'md',
                contents: [
                  { type: 'text', text: '📖 กติกาการดวลบั้งไฟ 📖', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center' }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'xs',
                contents: [
                  { type: 'text', text: '• ช่วงราคาห่าง 50 วินาทีพอดี (เช่น 300-350)', size: 'xs', color: '#334155' },
                  { type: 'text', text: '• ชล = ช่างไล่ (สูง) | ชถ = ช่างถอย (ต่ำ)', size: 'xs', color: '#334155' },
                  { type: 'text', text: '• แผลที่แมตช์แล้วไม่สามารถยกเลิกได้', size: 'xs', color: '#334155' }
                ]
              }
            }
          };

          await Promise.all(targetIds.map((gid) => client.pushMessage({ to: gid, messages: [ruleFlex as any] })));
          data = { success: true, targets: targetIds };
          break;
        }

        case 'adminBroadcastScamWarning': {
          const target = args[0];
          const activeGroups = await getActiveGroups();
          const targetIds = (target && target !== 'ALL') ? [target] : activeGroups.map((g) => g.groupId);
          if (!targetIds.length) {
            data = { success: false, reason: 'NO_ACTIVE_GROUP_FOUND', error: 'No active groups found' };
            break;
          }

          const scamFlex = {
            type: 'flex',
            altText: '🚨 ประกาศเตือนความปลอดภัย 🚨',
            contents: {
              type: 'bubble',
              size: 'mega',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#DC2626',
                paddingAll: 'md',
                contents: [
                  { type: 'text', text: '🚨 ประกาศเตือนความปลอดภัย 🚨', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center' }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'xs',
                contents: [
                  { type: 'text', text: 'ระวังมิจฉาชีพทักแชตส่วนตัวแอบอ้างเป็นแอดมิน', size: 'xs', color: '#DC2626', weight: 'bold', align: 'center' },
                  { type: 'text', text: 'โอนเงินเฉพาะบัญชีที่ระบบแจ้งในบอทเท่านั้น!', size: 'xs', color: '#1E293B', align: 'center' }
                ]
              }
            }
          };

          await Promise.all(targetIds.map((gid) => client.pushMessage({ to: gid, messages: [scamFlex as any] })));
          data = { success: true, targets: targetIds };
          break;
        }

        default:
          data = { success: false, reason: 'UNKNOWN_FUNCTION', error: `Function ${functionName} not implemented in RPC` };
      }

      res.status(200).json({ success: true, data });
    } catch (err: any) {
      console.error(`[Admin RPC] Error executing ${functionName}:`, err);
      res.status(500).json({ success: false, reason: 'RPC_FAILED', error: err?.message || 'Server error' });
    }
  };
}
