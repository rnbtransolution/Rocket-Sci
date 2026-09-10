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
      console.warn('[Admin] Neither ADMIN_SECRET_KEY nor ADMIN_API_KEY is configured on server');
      res.status(500).json({
        success: false,
        error: 'ADMIN_SECRET_KEY is not configured on server',
      });
      return;
    }

    const providedKey =
      req.body?.adminKey ||
      (req.query?.adminKey as string) ||
      (req.headers['x-admin-api-key'] as string) ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!providedKey || providedKey !== secretKey) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid adminKey',
      });
      return;
    }

    next();
  };

  /**
   * GET /api/admin/groups
   * Returns the list of active group chats recorded in Firestore
   */
  router.get('/groups', checkAdminAuth, async (_req: Request, res: Response): Promise<void> => {
    try {
      const groups = await getActiveGroups();
      res.status(200).json({
        success: true,
        count: groups.length,
        groups,
      });
    } catch (err: any) {
      console.error('[Admin] Error fetching active groups:', err);
      res.status(500).json({
        success: false,
        error: err?.message || 'Failed to fetch active groups',
      });
    }
  });

  /**
   * POST /api/admin/push-order
   * Pushes an Order Flex message to a target group or all active groups
   */
  router.post('/push-order', checkAdminAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      const { targetGroupId, orderData } = req.body || {};

      if (!orderData || typeof orderData !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Missing required orderData object',
        });
        return;
      }

      const rocketName = (orderData.rocketName || 'ค่ายบั้งไฟพญานาค').trim();
      const predictionType = (orderData.predictionType || 'สูง').trim();
      const amount = parseInt(orderData.amount, 10) || 500;

      if (amount <= 0) {
        res.status(400).json({
          success: false,
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

      // 1. Persist order into Firestore with status OPEN so players can match it
      const newOrder = await createOrder({
        creatorId: 'ADMIN',
        creatorName: `ค่าย: ${rocketName}`,
        side,
        amount,
        rocketName,
        groupId: targetGroupId || undefined,
      });

      // 2. Generate interactive Order Flex Message
      const flexPayload = generateOrderFlex(newOrder);

      // 3. Resolve target group ID(s)
      let targetGroupIds: string[] = [];
      if (targetGroupId && typeof targetGroupId === 'string' && targetGroupId.trim() !== '') {
        targetGroupIds = [targetGroupId.trim()];
      } else {
        const activeGroups = await getActiveGroups();
        if (!activeGroups.length) {
          res.status(400).json({
            success: false,
            error: 'No active groups found in Firestore active_groups. Specify targetGroupId or let bot join a group first.',
            order: newOrder,
          });
          return;
        }
        targetGroupIds = activeGroups.map((g) => g.groupId);
      }

      // 4. Dispatch push message(s) to LINE
      const results: { groupId: string; success: boolean; error?: string }[] = [];

      await Promise.all(
        targetGroupIds.map(async (gid) => {
          try {
            await client.pushMessage({
              to: gid,
              messages: [flexPayload],
            });
            results.push({ groupId: gid, success: true });
            console.log(`[Admin] Successfully pushed Order #${newOrder.orderNumber} to group ${gid}`);
          } catch (err: any) {
            console.error(`[Admin] Failed to push Order #${newOrder.orderNumber} to group ${gid}:`, err?.message || err);
            results.push({ groupId: gid, success: false, error: err?.message || String(err) });
          }
        })
      );

      const pushedCount = results.filter((r) => r.success).length;
      res.status(200).json({
        success: pushedCount > 0,
        message: `Order #${newOrder.orderNumber} pushed to ${pushedCount}/${targetGroupIds.length} group(s)`,
        orderNumber: newOrder.orderNumber,
        order: newOrder,
        results,
      });
    } catch (err: any) {
      console.error('[Admin] Error in /api/admin/push-order:', err);
      res.status(500).json({
        success: false,
        error: err?.message || 'Internal server error processing push order',
      });
    }
  });

  return router;
}
