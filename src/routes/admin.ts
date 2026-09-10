import { Router, Request, Response } from 'express';
import { messagingApi } from '@line/bot-sdk';
import { getActiveGroups } from '../handlers/groupHandler.js';
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
      (req.headers['x-admin-key'] as string) ||
      (req.headers['x-admin-api-key'] as string) ||
      (req.query?.adminKey as string) ||
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

  return router;
}
