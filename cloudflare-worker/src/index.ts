import { Env, LineWebhookPayload, QueueMessage, LineEvent } from './types.js';
import { verifyLineSignature } from './signature.js';
import { createCoordinatorClient } from './financial/client.js';
import { CoordinatorError, type LedgerOrder } from './financial/types.js';
import {
  processLineEvent,
  clearAllPendingOrders,
  releaseHeldPreQuoteOrders,
  voidAllRoundOrders,
  getPendingOrdersList,
  getPlayersList,
  savePlayerProfile,
  getTransactionsList,
  pushToLine,
  logUserMessage,
  getMatchedOrdersList,
  getSettledOrdersList,
  mapCoordinatorOrder,
  mapCoordinatorOrders,
} from './queueHandler.js';
import {
  generateRuleGuideFlex,
  generateBalanceFlex,
  generateCreditAdjustmentFlex,
  generateDepositFlex,
  generateDepositInvoiceFlex,
  generatePendingBoardFlex,
  generateWithdrawalFlex,
  generateOrderFlex,
  generateRocketLaunchedFlex,
} from './flexTemplates.js';
export { FinancialCoordinator } from './financial/FinancialCoordinator';

function formatTime(timestamp?: number): string {
  const d = timestamp ? new Date(timestamp) : new Date();
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

async function resolveTargetGroupIds(target: string | undefined, env: Env): Promise<string[]> {
  if (target && target !== 'ALL' && target !== 'GROUP_STREAM') {
    if (target.startsWith('PL')) {
      const rawLine = await env.KV_CACHE.get(`RAW_LINE_${target}`);
      if (rawLine) return [rawLine];
    }
    return [target];
  }

  const targetSet = new Set<string>();
  const activeGroupId = await env.KV_CACHE.get('ACTIVE_GROUP_ID');
  if (activeGroupId && /^[CR][0-9a-f]{32}$/i.test(activeGroupId.trim())) {
    targetSet.add(activeGroupId.trim());
  }

  const lineGroupsRaw = await env.KV_CACHE.get('LINE_GROUPS');
  if (lineGroupsRaw) {
    try {
      const groups = JSON.parse(lineGroupsRaw);
      if (Array.isArray(groups)) {
        groups.forEach((g: any) => {
          if (g && g.id && typeof g.id === 'string' && /^[CR][0-9a-f]{32}$/i.test(g.id.trim())) {
            targetSet.add(g.id.trim());
          }
        });
      }
    } catch (_) {}
  }

  return Array.from(targetSet);
}

async function appendChatLog(
  env: Env,
  log: { timestamp: string; userId: string; displayName: string; sender: string; text: string; type: string }
): Promise<void> {
  try {
    const raw = await env.KV_CACHE.get('CHAT_LOGS');
    const logs = raw ? JSON.parse(raw) : [];
    logs.push(log);
    const trimmed = logs.slice(-100);
    await env.KV_CACHE.put('CHAT_LOGS', JSON.stringify(trimmed));
  } catch (err) {
    console.warn('[appendChatLog Error]:', err);
  }
}

export default {
  /**
   * Cloudflare Worker HTTP Fetch Handler
   * Handles /webhook with immediate (< 20ms) HTTP 200 response and offloads to Queue.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── CORS Headers for Admin Web Portal ──
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key, x-admin-api-key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── 1. Health Check Endpoint ──
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          platform: 'Cloudflare Workers (Edge V8)',
          concurrency: 'High-Throughput (10-20 TPS)',
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // ── 2. LINE Webhook Endpoint (/webhook) ──
    if (url.pathname === '/webhook') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // Read raw body string once to ensure HMAC signature integrity
      const rawBody = await request.text();
      const signature = request.headers.get('x-line-signature');

      // Verify HMAC-SHA256 signature using WebCrypto (< 1ms)
      const isValid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
      if (!isValid) {
        console.warn('[Webhook] Rejected invalid or missing LINE signature');
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      let payload: LineWebhookPayload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Malformed JSON' }), { status: 400 });
      }

      const events = payload.events || [];

      // ── High-Speed Interactive Execution (< 150ms) ──
      if (events.length > 0) {
        // Replay-probe isolation: LINE Console "Verify" button sends a synthetic
        // event with a fake replyToken (no real user behind it). Reply/push calls
        // on it fail noisily and pollute logs — acknowledge without processing.
        const isVerifyProbe = events.some(
          (e) => e.replyToken && /^0000[0-9a-f]{26,}$/.test(e.replyToken)
        );

        const interactiveProcessing = await Promise.allSettled(
          events.map((event) => isVerifyProbe ? Promise.resolve() : processLineEvent(event, env, ctx))
        );

        if (env.LINE_EVENTS_QUEUE) {
          const queueBatch = events.map((event) => ({
            body: {
              id: event.webhookEventId || event.message?.id || crypto.randomUUID(),
              receivedAt: Date.now(),
              event,
            } as QueueMessage,
          }));
          ctx.waitUntil(env.LINE_EVENTS_QUEUE.sendBatch(queueBatch));
        }

        const processingFailure = interactiveProcessing.find(
          (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
        );
        if (processingFailure) {
          console.error('[Worker] Event processing failed; requesting webhook retry:', processingFailure.reason);
          return new Response(JSON.stringify({ error: 'Event processing failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Universal Dashboard RPC Endpoint (/api/run) ──
    if (url.pathname === '/api/run' && request.method === 'POST') {
      try {
        const body = (await request.json()) as any;
        const { functionName, args = [] } = body;

        const bearerToken = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
        const authHeader = request.headers.get('x-admin-key')
          || request.headers.get('x-admin-api-key')
          || bearerToken
          || body?.adminKey
          || body?.apiKey;
        const isReadOnly = functionName === 'getDashboardData' || functionName === 'adminLogin';
        if (functionName !== 'getDashboardData' && !env.ADMIN_API_KEY) {
          return new Response(JSON.stringify({ error: 'Admin authentication is not configured' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        if (!isReadOnly && authHeader !== env.ADMIN_API_KEY) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        let result: any = null;

        if (functionName === 'getDashboardData') {
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          const activeGroupId = await env.KV_CACHE.get('ACTIVE_GROUP_ID');
          const pendingBets = await getPendingOrdersList(env);
          const players = await getPlayersList(env);
          const transactions = await getTransactionsList(env);
          const lineGroupsRaw = await env.KV_CACHE.get('LINE_GROUPS');
          let parsedGroups = lineGroupsRaw ? JSON.parse(lineGroupsRaw) : [];
          if (!Array.isArray(parsedGroups)) parsedGroups = [];
          const validGroups = parsedGroups.filter((g: any) => g && g.id && /^[CR][0-9a-f]{32}$/i.test(String(g.id).trim()));
          const validActiveGroupId = (activeGroupId && /^[CR][0-9a-f]{32}$/i.test(activeGroupId.trim())) ? activeGroupId.trim() : 'C61efb2aa1ad6fc26fefdc41fb710b431';
          const lineGroups = validGroups.length > 0
            ? validGroups
            : [{ id: validActiveGroupId, name: '.Test', lastMessage: 'เชื่อมต่อแล้ว', timestamp: 'Live' }];
          const chatLogsRaw = await env.KV_CACHE.get('CHAT_LOGS');
          const chatLogs = chatLogsRaw ? JSON.parse(chatLogsRaw) : [];

          let lineQuota: any = null;
          try {
            const token = env.LINE_CHANNEL_ACCESS_TOKEN;
            if (token) {
              const [qRes, cRes] = await Promise.all([
                fetch('https://api.line.me/v2/bot/message/quota', { headers: { Authorization: `Bearer ${token}` } }),
                fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: { Authorization: `Bearer ${token}` } }),
              ]);
              if (qRes.ok && cRes.ok) {
                const qJson: any = await qRes.json();
                const cJson: any = await cRes.json();
                const totalLimit = qJson.value || 0;
                const used = cJson.totalUsage || 0;
                lineQuota = {
                  type: qJson.type || 'limited',
                  limit: totalLimit,
                  totalUsage: used,
                  remaining: Math.max(0, totalLimit - used),
                  isExhausted: totalLimit > 0 && used >= totalLimit,
                };
              }
            }
          } catch (_) {}

          result = {
            players,
            transactions,
            bets: pendingBets,
            chatLogs,
            activeGroupId: validActiveGroupId,
            lineGroups,
            activeRound: roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380, status: 'ACTIVE' },
            roundStatus: roundStr ? (JSON.parse(roundStr).status || 'ACTIVE') : 'ACTIVE',
            serverTime: new Date().toISOString(),
            lineQuota,
          };
        } else if (functionName === 'getP2PResults') {
          const settledOrders = await getSettledOrdersList(env);
          const p2p: any[] = [];
          for (const order of settledOrders) {
            if (order.winnerSide && order.winnerSide !== 'draw') {
              const winnerName = order.winnerName || '-';
              const loserName =
                order.winnerSide === 'low'
                  ? (order.side === 'high' ? (order.matcherName || order.creatorName) : order.creatorName)
                  : (order.side === 'high' ? (order.matcherName || order.creatorName) : order.creatorName);
              p2p.push({
                orderNumber: order.orderNumber,
                amount: Number(order.amount) || 0,
                winnerSide: order.winnerSide,
                winnerName,
                loserName,
                finalTime: order.finalTime || null,
                settleAt: order.settledAt || null,
              });
            }
          }
          result = { success: true, p2pResults: p2p };
        } else if (functionName === 'getHeldPreQuoteOrders') {
          const pending = await getPendingOrdersList(env);
          const held = pending.filter(order => order.status === 'pending_hold' && order.betType === 'pre_quote');
          result = { success: true, heldPreQuoteOrders: held };
        } else if (functionName === 'adminGetLineQuota') {
          try {
            const token = env.LINE_CHANNEL_ACCESS_TOKEN;
            const headers = { Authorization: `Bearer ${token}` };
            const [qRes, cRes, epRes] = await Promise.all([
              fetch('https://api.line.me/v2/bot/message/quota', { headers }),
              fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers }),
              fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { headers }),
            ]);
            const qJson: any = await qRes.json();
            const cJson: any = await cRes.json();
            let webhookEndpoint = '';
            try {
              const epJson: any = await epRes.json();
              webhookEndpoint = epJson.endpoint || '';
            } catch (_) {}
            const totalLimit = qJson.value || 0;
            const used = cJson.totalUsage || 0;
            result = {
              webhookEndpoint,
              type: qJson.type || 'limited',
              limit: totalLimit,
              totalUsage: used,
              remaining: Math.max(0, totalLimit - used),
              isExhausted: totalLimit > 0 && used >= totalLimit,
            };
          } catch (e: any) {
            result = { error: e?.message || 'Failed to fetch quota' };
          }
        } else if (functionName === 'adminLogin') {
          const username = args[0] || '';
          const password = args[1] || '';
          if ((username.toLowerCase() === 'admin') && (password === env.ADMIN_API_KEY)) {
            result = {
              success: true,
              adminKey: env.ADMIN_API_KEY,
              sessionToken: env.ADMIN_API_KEY,
              username: 'Admin',
            };
          } else {
            result = { success: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
          }
        } else if (functionName === 'adminApproveTransaction') {
          const txId = String(args[0] || '');
          const coordinator = createCoordinatorClient(env);
          const snapshot = await coordinator.getSnapshot();
          const targetTx = snapshot.transactions.find((transaction) => transaction.transactionId === txId);
          if (!targetTx) throw new CoordinatorError('NOT_FOUND', 'Transaction not found');
          const reviewed = await coordinator.reviewTransaction({
            idempotencyKey: `admin-review:${txId}:approve`,
            transactionId: txId,
            decision: 'approve',
            actualAmountHundredths: targetTx.requestedAmountHundredths,
            actorId: 'admin',
            reason: 'Approved by admin',
          });
          const account = snapshot.accounts.find((item) => item.playerId === targetTx.playerId);
          const rawLine = account?.lineUserId || '';
          const balance = (await coordinator.getAccount(targetTx.playerId))?.balanceHundredths || 0;
          if (rawLine) {
            const message = reviewed.type === 'withdrawal'
              ? `💸 [ถอนเงินสำเร็จ]: ยอด ${(reviewed.requestedAmountHundredths / 100).toLocaleString()} บาท แอดมินได้โอนเข้าบัญชีของคุณเรียบร้อยแล้วครับ 🚀`
              : `✅ อนุมัติยอดเงินฝาก ${(reviewed.actualAmountHundredths! / 100).toLocaleString()} บาท เรียบร้อยแล้วครับ!\nแต้มคงเหลือปัจจุบัน: ${(balance / 100).toLocaleString()} pt 🚀`;
            ctx?.waitUntil(pushToLine(rawLine, message, env).catch((error) => console.error('[Worker] Transaction approval notification failed:', error)));
          }
          result = { success: true, txId };
        } else if (functionName === 'adminRejectTransaction') {
          const txId = String(args[0] || '');
          const reason = String(args[1] || 'ไม่พบยอดเงินเข้าบัญชี');
          const coordinator = createCoordinatorClient(env);
          const snapshot = await coordinator.getSnapshot();
          const targetTx = snapshot.transactions.find((transaction) => transaction.transactionId === txId);
          if (!targetTx) throw new CoordinatorError('NOT_FOUND', 'Transaction not found');
          const reviewed = await coordinator.reviewTransaction({
            idempotencyKey: `admin-review:${txId}:reject`,
            transactionId: txId,
            decision: 'reject',
            actualAmountHundredths: 0,
            actorId: 'admin',
            reason,
          });
          const rawLine = snapshot.accounts.find((item) => item.playerId === targetTx.playerId)?.lineUserId || '';
          const balance = (await coordinator.getAccount(targetTx.playerId))?.balanceHundredths || 0;
          if (rawLine) {
            const message = reviewed.type === 'withdrawal'
              ? `❌ [ปฏิเสธการถอนเงิน]: ยอด ${(reviewed.requestedAmountHundredths / 100).toLocaleString()} pt (สาเหตุ: ${reason})\nระบบได้คืนแต้มเข้ากระเป๋าเรียบร้อย แต้มคงเหลือ: ${(balance / 100).toLocaleString()} pt 🚀`
              : `❌ [ปฏิเสธการฝากเงิน]: ยอด ${(reviewed.requestedAmountHundredths / 100).toLocaleString()} บาท (สาเหตุ: ${reason})`;
            ctx?.waitUntil(pushToLine(rawLine, message, env).catch((error) => console.error('[Worker] Transaction rejection notification failed:', error)));
          }
          result = { success: true, txId };
        } else if (functionName === 'adminRequestCancelBet') {
          const orderNumber = String(args[0] || '').trim().replace(/#/g, '');
          if (!orderNumber) throw new CoordinatorError('INVALID_INPUT', 'order number is required');
          const coordinator = createCoordinatorClient(env);
          const cancelled = await coordinator.cancelOrder({
            idempotencyKey: `admin-cancel:${orderNumber}`,
            orderNumber,
            actorId: 'admin',
          });
          await env.KV_ORDERS.put(`ORDER_${orderNumber}`, JSON.stringify(await mapCoordinatorOrder(cancelled, env)));
          result = { success: true, orderNumber };
        } else if (functionName === 'adminVoidRound') {
          const activeRoundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          if (!activeRoundStr) throw new CoordinatorError('INVALID_STATE', 'There is no active round to void');
          const activeRound = JSON.parse(activeRoundStr);
          if (!activeRound.roundId) throw new CoordinatorError('INVALID_STATE', 'Active round has no coordinator ID');
          const coordinator = createCoordinatorClient(env);
          const voided = await coordinator.voidRound({
            idempotencyKey: `admin-void:${activeRound.roundId}`,
            roundId: activeRound.roundId,
          });
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify({
            ...activeRound,
            status: 'VOID',
            quoteReleased: voided.round.quoteReleased,
            updatedAt: voided.round.updatedAt,
          }));
          result = { success: true, refundedOrderNumbers: voided.refundedOrderNumbers };
        } else if (functionName === 'adminSetPlayerBalance') {
          const userId = String(args[0] || '');
          const newBal = Number(args[1]);
          const passedName = args[2] ? String(args[2]).trim() : '';
          const requestId = String(body.requestId || '');
          if (!requestId) throw new CoordinatorError('INVALID_INPUT', 'requestId is required for balance adjustment');
          if (!Number.isSafeInteger(newBal) || newBal < 0) {
            throw new CoordinatorError('INVALID_INPUT', 'Balance must be a nonnegative whole-point amount');
          }
          const coordinator = createCoordinatorClient(env);
          const snapshot = await coordinator.getSnapshot();
          const account = snapshot.accounts.find((item) =>
            item.playerId === userId || item.lineUserId === userId
          );
          if (!account) throw new CoordinatorError('NOT_FOUND', 'Player account not found');
          const targetBalanceHundredths = newBal * 100;
          if (!Number.isSafeInteger(targetBalanceHundredths)) {
            throw new CoordinatorError('INVALID_INPUT', 'Balance exceeds the supported range');
          }
          const oldBal = account.balanceHundredths / 100;
          const displayName = passedName || account.displayName;
          const updated = await coordinator.adjustBalance({
            idempotencyKey: `admin-adjust:${requestId}`,
            playerId: account.playerId,
            targetBalanceHundredths,
            actorId: 'admin',
            reason: `Admin set balance to ${newBal}`,
          });
          if (passedName && account.lineUserId) {
            const raw = await env.KV_CACHE.get(`USER_${account.lineUserId}`);
            if (raw) {
              const profile = JSON.parse(raw);
              profile.displayName = passedName;
              profile.balance = updated.balanceHundredths / 100;
              await env.KV_CACHE.put(`USER_${account.lineUserId}`, JSON.stringify(profile));
            }
          }
          const targetLineUserId = account.lineUserId || '';
          if (targetLineUserId.startsWith('U')) {
            const adjustFlex = generateCreditAdjustmentFlex(displayName, oldBal, newBal);
            ctx?.waitUntil(Promise.all([
              pushToLine(targetLineUserId, adjustFlex, env).catch(error => console.error('[Worker] Credit adjustment notification failed:', error)),
              appendChatLog(env, {
                timestamp: formatTime(),
                userId: targetLineUserId,
                displayName: 'แอดมิน',
                sender: 'admin',
                text: `💰 แจ้งเตือนปรับยอดเครดิต: ${oldBal.toLocaleString()} pt → ${newBal.toLocaleString()} pt`,
                type: 'flex',
              }).catch(error => console.error('[Worker] Credit adjustment chat log failed:', error))
            ]));
          }

          result = { success: true, balance: updated.balanceHundredths / 100 };
        } else if (functionName === 'adminCreatePlayer') {
          const lineId = String(args[0] || '');
          const name = String(args[1] || 'ผู้เล่นใหม่');
          const bal = Number(args[2]) || 0;
          const requestId = String(body.requestId || '');
          if (!requestId) throw new CoordinatorError('INVALID_INPUT', 'requestId is required to create a player');
          if (!lineId) throw new CoordinatorError('INVALID_INPUT', 'LINE user ID is required');
          if (!Number.isSafeInteger(bal) || bal < 0) {
            throw new CoordinatorError('INVALID_INPUT', 'Opening balance must be a nonnegative whole-point amount');
          }
          const shortId = lineId && lineId.length <= 8 ? lineId.toUpperCase() : `PL${lineId.slice(-6).toUpperCase()}`;
          const account = await createCoordinatorClient(env).createPlayer({
            idempotencyKey: `admin-create-player:${requestId}`,
            playerId: shortId,
            lineUserId: lineId,
            displayName: name,
            openingBalanceHundredths: bal * 100,
          });
          const newP = {
            shortId,
            lineUserId: lineId,
            displayName: account.displayName,
            balance: account.balanceHundredths / 100,
            registeredAt: account.createdAt,
            updatedAt: account.updatedAt,
          };
          await env.KV_CACHE.put(`USER_${lineId}`, JSON.stringify(newP));
          await env.KV_CACHE.put(`RAW_LINE_${shortId}`, lineId);

          if (bal > 0 && lineId && lineId.startsWith('U')) {
            try {
              const adjustFlex = generateCreditAdjustmentFlex(newP.displayName, 0, bal);
              ctx?.waitUntil(Promise.all([
                pushToLine(lineId, adjustFlex, env).catch(e => console.error(e)),
                appendChatLog(env, {
                  timestamp: formatTime(),
                  userId: lineId,
                  displayName: 'แอดมิน',
                  sender: 'admin',
                  text: `💰 แจ้งเตือนยอดเครดิตเริ่มต้น: ${bal.toLocaleString()} pt`,
                  type: 'flex',
                }).catch(e => console.error(e))
              ]));
            } catch (pushErr) {
              console.error('[Worker] Error pushing initial credit to DM:', pushErr);
            }
          }

          result = { success: true, player: newP };
        } else if (functionName === 'adminUpdatePlayerName') {
          const userId = args[0];
          const newName = args[1];
          const rawLine = await env.KV_CACHE.get(`RAW_LINE_${userId}`) || userId;
          const profileRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
          if (profileRaw) {
            const p = JSON.parse(profileRaw);
            p.displayName = newName;
            await savePlayerProfile(p, env, ctx);
          }
          result = { success: true };
        } else if (functionName === 'adminDeletePlayer') {
          const userId = String(args[0] || '');
          const requestId = String(body.requestId || '');
          if (!requestId) throw new CoordinatorError('INVALID_INPUT', 'requestId is required to deactivate a player');
          const snapshot = await createCoordinatorClient(env).getSnapshot();
          const account = snapshot.accounts.find((item) =>
            item.playerId === userId || item.lineUserId === userId
          );
          if (!account) throw new CoordinatorError('NOT_FOUND', 'Player account not found');
          await createCoordinatorClient(env).deactivatePlayer({
            idempotencyKey: `admin-deactivate-player:${requestId}`,
            playerId: account.playerId,
            actorId: 'admin',
          });
          result = { success: true };
        } else if (functionName === 'adminSetActiveGroupId') {
          const gid = args[0];
          await env.KV_CACHE.put('ACTIVE_GROUP_ID', gid);
          result = { success: true, activeGroupId: gid };
        } else if (functionName === 'adminOpenRound') {
          const roundName = args[0] || 'บั้งไฟสด';
          const requestId = String(body.requestId || '');
          if (!requestId) throw new CoordinatorError('INVALID_INPUT', 'requestId is required to open a round');
          const round = await createCoordinatorClient(env).openRound({
            idempotencyKey: `admin-open-round:${requestId}`,
            roundId: `round-${requestId}`,
            name: String(roundName),
          });
          await Promise.all([
            getPendingOrdersList(env),
            getMatchedOrdersList(env),
          ]);
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify({
            roundId: round.roundId,
            name: roundName,
            targetMin: 330,
            targetMax: 380,
            status: 'ACTIVE',
            isChotoy: false,
            quoteReleased: false,
            updatedAt: Date.now(),
          }));
          result = { success: true, round: roundName };
        } else if (
          functionName === 'clearPendingBets' ||
          functionName === 'adminClearOrders' ||
          functionName === 'resetOrders' ||
          functionName === 'clearCache'
        ) {
          const res = await clearAllPendingOrders(env);
          result = { success: true, message: 'Cleared pending orders and board cache', cleared: res.cleared };
        } else if (functionName === 'resetGoogleSheetsDatabase') {
          throw new CoordinatorError('INVALID_STATE', 'Financial authority cannot be reset through the legacy dashboard action');
        } else if (functionName === 'syncWithSheets') {
          const kvPlayers = await getPlayersList(env);
          const kvTx = await getTransactionsList(env);
          const kvBets = await getPendingOrdersList(env);
          result = {
            players: kvPlayers,
            transactions: kvTx,
            bets: kvBets,
            activeGroupId: (await env.KV_CACHE.get('ACTIVE_GROUP_ID')) || '',
          };
        } else if (functionName === 'sendAdminMessageToLine') {
          const target = args[0];
          const messageText = args[1];
          const targets = await resolveTargetGroupIds(target, env);

          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ (กรุณาตรวจสอบ Active Group ID)' };
          } else {
            let payload: any = messageText;
            const isObj = typeof messageText === 'object' && messageText !== null;
            const clean = !isObj ? String(messageText || '').replace(/\s+/g, '').toLowerCase() : '';

            if (!isObj) {
              const rangeMatch = String(messageText).match(/(\d{3})\s*[-/]\s*(\d{3})/);
              if (rangeMatch) {
                const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
                const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', status: 'ACTIVE' };
                round.targetMin = Number(rangeMatch[1]);
                round.targetMax = Number(rangeMatch[2]);
                round.updatedAt = Date.now();
                await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));
              }

              if (clean === 'กติกา' || clean === 'rule' || clean === 'rules' || clean === 'วิธีเล่น' || clean === 'คู่มือ') {
                payload = generateRuleGuideFlex();
              } else if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
                const primaryTarget = targets[0];
                const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${primaryTarget}`)) || primaryTarget;
                const profileRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
                const profile = profileRaw ? JSON.parse(profileRaw) : null;
                payload = generateBalanceFlex(profile?.displayName || 'ผู้เล่น', profile?.balance || 0);
              } else if (clean === 'บั้งไฟออก' || clean === 'rocketout') {
                payload = generateRocketLaunchedFlex();
              } else if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit' || clean === 'ฝาก') {
                payload = generateDepositFlex();
              } else if (clean === 'กระดานดวล' || clean === 'กระดาน' || clean === 'board') {
                const pending = await getPendingOrdersList(env);
                payload = generatePendingBoardFlex(pending);
              } else if (clean.includes('ปิดรับดวล') || clean.startsWith('ปิดรอบ') || clean.startsWith('ล็อครอบ')) {
                const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
                const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
                round.status = 'CLOSED';
                round.updatedAt = Date.now();
                await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));
              } else if (clean.startsWith('เปิดรอบ') || clean.startsWith('เปิดรับดวล')) {
                const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
                const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
                round.status = 'ACTIVE';
                round.updatedAt = Date.now();
                await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));
              }
            }

            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, payload, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'แอดมิน',
              sender: 'admin',
              text: typeof payload === 'object' ? '[Flex Message]' : String(messageText),
              type: typeof payload === 'object' ? 'flex' : 'text',
            });

            result = {
              success: allSuccess,
              count: targets.length,
              targets,
              error: allSuccess
                ? undefined
                : (quotaError?.error || 'ส่งเข้าบางกลุ่มไม่สำเร็จ (กรุณาเช็คสิทธิ์ LINE OA ในกลุ่ม)'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminBroadcastRocketLaunched') {
          const target = args[0];
          const rocketLaunchFlex = generateRocketLaunchedFlex();

          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
          } else {
            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, rocketLaunchFlex, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[🚀 บั้งไฟออกแล้ว]',
              type: 'flex',
            });

            result = {
              success: allSuccess,
              targets,
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งข้อความเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminBroadcastQuote') {
          const target = args[0];
          const name = (args[1] && String(args[1]).trim()) ? String(args[1]).trim() : 'ช่างบั้งไฟสด';
          const min = Number(args[2]) || 330;
          const max = Number(args[3]) || 380;
          const isChotoy = Boolean(args[4]);
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          if (!roundStr) throw new CoordinatorError('INVALID_STATE', 'There is no active round to quote');
          const currentRound = JSON.parse(roundStr);
          if (!currentRound.roundId) throw new CoordinatorError('INVALID_STATE', 'Active round has no coordinator ID');
          const requestId = String(body.requestId || '');
          if (!requestId) throw new CoordinatorError('INVALID_INPUT', 'requestId is required to release a quote');
          const quoteResult = await releaseHeldPreQuoteOrders(
            currentRound.roundId,
            `admin-release-quote:${requestId}`,
            min,
            max,
            env,
            ctx,
          );

          const roundData = {
            roundId: currentRound.roundId,
            name,
            targetMin: min,
            targetMax: max,
            status: 'ACTIVE',
            isChotoy,
            quoteReleased: true,
            updatedAt: Date.now(),
          };
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(roundData));

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
                  { type: 'text', text: '🚀 เปิดราคาดวลบั้งไฟ 🚀', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center', wrap: true },
                  { type: 'text', text: name, color: '#FFFFFFE6', size: 'sm', align: 'center', margin: 'xs', weight: 'bold', wrap: true },
                ],
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                  { type: 'text', text: `⏱️ ช่วงราคา: ${min}-${max} วิ${isChotoy ? ' (ชตย)' : ''}`, weight: 'bold', color: '#0284C7', size: 'sm', align: 'center', wrap: true },
                  { type: 'text', text: '⚡ พิมพ์ ชล / ชถ (±5, ±10) ได้ทันที', color: '#64748B', size: 'xs', align: 'center', wrap: true },
                ],
              },
            },
          };

          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ (กรุณาตรวจสอบ Active Group ID)' };
          } else {
            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, quoteFlex, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: name,
              sender: 'admin',
              text: `[เปิดราคา: ${name} (${min}-${max}s)]`,
              type: 'flex',
            });

            result = {
              success: allSuccess,
              targets,
              round: roundData,
              releasedOrders: quoteResult.converted,
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งข้อความเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminBroadcastFinalCall') {
          const target = args[0];
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          if (!roundStr) throw new CoordinatorError('INVALID_STATE', 'There is no active round to close');
          const round = JSON.parse(roundStr);
          if (!round.roundId) throw new CoordinatorError('INVALID_STATE', 'Active round has no coordinator ID');
          const requestId = String(body.requestId || '');
          if (!requestId) throw new CoordinatorError('INVALID_INPUT', 'requestId is required to close a round');
          const closeResult = await createCoordinatorClient(env).closeRound({
            idempotencyKey: `admin-close-round:${requestId}`,
            roundId: round.roundId,
          });
          round.status = 'CLOSED';
          round.updatedAt = Date.now();
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));
          await getPendingOrdersList(env);
          const coordinator = createCoordinatorClient(env);
          await Promise.all(closeResult.cancelledOrderNumbers.map(async (orderNo) => {
            const cancelled = await coordinator.getOrder(orderNo);
            if (cancelled) {
              await env.KV_ORDERS.put(`ORDER_${orderNo}`, JSON.stringify(await mapCoordinatorOrder(cancelled, env)));
            }
          }));

          const finalFlex = {
            type: 'flex',
            altText: '⛔ ปิดรับดวลรอบนี้แล้ว ⛔',
            contents: {
              type: 'bubble',
              size: 'kilo',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#BE123C',
                paddingAll: 'md',
                contents: [
                  { type: 'text', text: '⛔ ปิดรับดวลรอบนี้แล้ว ⛔', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center', wrap: true },
                ],
              },
              body: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#FFF1F2',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '🔒 แผลเปิดที่ไม่ติดคู่ดวล ถูกยกเลิกโดยอัตโนมัติ', size: 'xs', color: '#475569', align: 'center', wrap: true },
                  { type: 'text', text: '⚠️ หลังจากนี้ ห้ามพิมพ์รายการใดๆ ทั้งสิ้นครับ', size: 'xs', color: '#DC2626', weight: 'bold', align: 'center', wrap: true },
                ],
              },
            },
          };

          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
          } else {
            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, finalFlex, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[⛔ ปิดรับดวลรอบนี้แล้ว]',
              type: 'flex',
            });

            result = {
              success: allSuccess,
              targets,
              cancelledOrders: closeResult.cancelledOrderNumbers.length,
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminBroadcastVoidRound') {
          const target = args[0];
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          if (!roundStr) throw new CoordinatorError('INVALID_STATE', 'There is no active round to void');
          const round = JSON.parse(roundStr);
          if (!round.roundId) throw new CoordinatorError('INVALID_STATE', 'Active round has no coordinator ID');
          await voidAllRoundOrders(env, ctx);
          round.status = 'VOID';
          round.updatedAt = Date.now();
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));

          const voidFlex = {
            type: 'flex',
            altText: '⛔ ช่าง ⛔ (โมฆะรอบ)',
            contents: {
              type: 'bubble',
              size: 'kilo',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#FECDD3',
                paddingAll: 'md',
                contents: [
                  { type: 'text', text: '⛔ ช่าง ⛔ (โมฆะรอบ)', weight: 'bold', color: '#9F1239', size: 'sm', align: 'center', wrap: true },
                ],
              },
              body: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#FFF1F2',
                spacing: 'xs',
                contents: [
                  { type: 'text', text: 'ยกเลิกและคืนแต้มทุกแผลดวล 100% เรียบร้อยครับ 🚀', weight: 'bold', color: '#BE123C', size: 'xs', align: 'center', wrap: true },
                ],
              },
            },
          };

          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
          } else {
            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, voidFlex, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[⛔ โมฆะรอบการแข่งขัน]',
              type: 'flex',
            });

            result = {
              success: allSuccess,
              targets,
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminBroadcastRuleGuide') {
          const target = args[0];
          const ruleFlex = generateRuleGuideFlex();
          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
          } else {
            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, ruleFlex, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[📖 คู่มือกติกา]',
              type: 'flex',
            });

            result = {
              success: allSuccess,
              targets,
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminBroadcastScamWarning') {
          const target = args[0];
          const warnFlex = generateRocketLaunchedFlex();

          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
          } else {
            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, warnFlex, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[🚀 บั้งไฟออกแล้ว]',
              type: 'flex',
            });

            result = {
              success: allSuccess,
              targets,
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminTestPushGroupMessage') {
          const target = args[0];
          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ — กรุณาตรวจสอบ Active Group ID' };
          } else {
            const timeStr = formatTime();
            const msg = `🔔 ทดสอบการส่งข้อความแจ้งเตือนจากระบบ Admin Web Portal (เวลา: ${timeStr}) 🚀\nสถานะการเชื่อมต่อ: สมบูรณ์ 100% 🟢`;
            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, msg, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: timeStr,
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: msg,
              type: 'text',
            });

            result = {
              success: allSuccess,
              targets,
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminTestDepositInvoice') {
          const target = args[0] || 'Ua34bcbb1d365c657cc1a7f3576c76e26';
          const amt = Number(args[1]) || 1000;
          const invoiceFlex = generateDepositInvoiceFlex(amt);
          const pushResult = await pushToLine(target, invoiceFlex, env);
          result = { success: pushResult.success, pushResult, invoiceFlex };
        } else if (functionName === 'adminSimulatePrivateUserMessage') {
          const text = args[0] || '1000';
          const userId = args[1] || 'Ua34bcbb1d365c657cc1a7f3576c76e26';
          const mockEvent: LineEvent = {
            type: 'message',
            timestamp: Date.now(),
            webhookEventId: crypto.randomUUID(),
            source: {
              type: 'user',
              userId: userId,
            },
            message: {
              id: `sim_${Date.now()}`,
              type: 'text',
              text: String(text),
            },
          };
          await processLineEvent(mockEvent, env, ctx);
          const lastDelivery = await env.KV_CACHE.get('LAST_DELIVERY_DEBUG');
          const lastError = await env.KV_CACHE.get('LAST_LINE_ERROR');
          const lastSuccess = await env.KV_CACHE.get('LAST_LINE_SUCCESS');
          result = {
            success: true,
            simulatedText: text,
            lastDelivery: lastDelivery ? JSON.parse(lastDelivery) : null,
            lastError: lastError ? JSON.parse(lastError) : null,
            lastSuccess: lastSuccess ? JSON.parse(lastSuccess) : null,
          };
        } else if (functionName === 'adminDiscoverGroupIds') {
          const activeGroupId = await env.KV_CACHE.get('ACTIVE_GROUP_ID');
          const lineGroupsRaw = await env.KV_CACHE.get('LINE_GROUPS');
          const lineGroups = lineGroupsRaw ? JSON.parse(lineGroupsRaw) : [];
          const discovered: { id: string; source: string }[] = [];
          if (activeGroupId) {
            discovered.push({ id: activeGroupId, source: 'KV ACTIVE_GROUP_ID' });
          }
          if (Array.isArray(lineGroups)) {
            lineGroups.forEach((g: any) => {
              if (g?.id && !discovered.some((d) => d.id === g.id)) {
                discovered.push({ id: g.id, source: 'KV LINE_GROUPS' });
              }
            });
          }
          result = { activeGroupId: activeGroupId || '', lineGroups, discovered };
        } else if (functionName === 'adminSetPlayerBank') {
          const userId = args[0];
          const bankName = args[1] || '';
          const bankAccount = args[2] || '';
          const accountName = args[3] || '';
          const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${userId}`)) || userId;
          const profileRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
          if (profileRaw) {
            const p = JSON.parse(profileRaw);
            p.bankName = bankName;
            p.accountNumber = bankAccount;
            p.accountName = accountName;
            p.updatedAt = Date.now();
            await savePlayerProfile(p, env, ctx);
          }
          result = { success: true };
        } else if (functionName === 'adminResolveBets') {
          const finalSeconds = Number(args[0]);
          if (!Number.isFinite(finalSeconds) || finalSeconds < 0) {
            throw new CoordinatorError('INVALID_INPUT', 'Final time must be a nonnegative number');
          }
          const activeRoundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          if (!activeRoundStr) throw new CoordinatorError('INVALID_STATE', 'There is no active round to settle');
          const activeRound = JSON.parse(activeRoundStr);
          if (!activeRound.roundId) throw new CoordinatorError('INVALID_STATE', 'Active round has no coordinator ID');
          const requestId = String(body.requestId || '');
          if (!requestId) throw new CoordinatorError('INVALID_INPUT', 'requestId is required to settle a round');
          const coordinator = createCoordinatorClient(env);
          if (String(activeRound.status).toLowerCase() === 'active') {
            const closed = await coordinator.closeRound({
              idempotencyKey: `admin-resolve-close:${requestId}`,
              roundId: activeRound.roundId,
            });
            await getPendingOrdersList(env);
            for (const orderNo of closed.cancelledOrderNumbers) {
              const cancelled = await coordinator.getOrder(orderNo);
              if (cancelled) {
                await env.KV_ORDERS.put(`ORDER_${orderNo}`, JSON.stringify(await mapCoordinatorOrder(cancelled, env)));
              }
            }
          }
          const settlement = await coordinator.resolveRound({
            idempotencyKey: `admin-resolve:${requestId}`,
            roundId: activeRound.roundId,
            finalSeconds,
          });
          const committedOrders = await Promise.all(settlement.orders.map((settled) =>
            coordinator.getOrder(settled.orderNumber)
          ));
          if (committedOrders.some((order) => order === null)) {
            throw new CoordinatorError('INTERNAL', 'Settled order projection is missing');
          }
          const mappedOrders = await mapCoordinatorOrders(
            committedOrders.filter((order): order is LedgerOrder => order !== null),
            env,
          );
          const resolvedOrders: any[] = await Promise.all(settlement.orders.map(async (settled, index) => {
            const order = mappedOrders[index];
            const winnerName = settled.winnerSide === 'draw'
              ? '-'
              : settled.winnerSide === order.side
                ? order.creatorName
                : order.matcherName || '-';
            const resolved = {
              ...order,
              status: 'settled',
              finalTime: finalSeconds,
              winnerSide: settled.winnerSide,
              winnerName,
              settledAt: Date.now(),
              winnerCredit: settled.winnerCreditHundredths / 100,
              houseFee: settled.houseFeeHundredths / 100,
            };
            await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(resolved));
            return resolved;
          }));
          await Promise.all([
            getSettledOrdersList(env),
            getMatchedOrdersList(env),
          ]);
          activeRound.status = 'CLOSED';
          activeRound.finalTime = finalSeconds;
          activeRound.updatedAt = Date.now();
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(activeRound));
          const tMin = Number(activeRound.targetMin) || 330;
          const tMax = Number(activeRound.targetMax) || 380;
          const targets = await resolveTargetGroupIds('ALL', env);
          if (targets.length > 0) {
            const settleFlex = {
              type: 'flex',
              altText: `🏁 สรุปผลเวลาบิน [${activeRound.name || 'บั้งไฟสด'}] เวลา ${finalSeconds} วินาที`,
              contents: {
                type: 'bubble',
                size: 'mega',
                header: {
                  type: 'box',
                  layout: 'vertical',
                  backgroundColor: '#0F172A',
                  paddingAll: 'md',
                  contents: [
                    { type: 'text', text: '🏁 สรุปผลการแข่งขัน 🏁', weight: 'bold', color: '#FDE047', size: 'sm', align: 'center' },
                    { type: 'text', text: `บั้งไฟ [${activeRound.name || 'บั้งไฟสด'}]`, color: '#FFFFFF', size: 'md', weight: 'bold', align: 'center', margin: 'xs' },
                    { type: 'text', text: `⏱️ เวลาบินจริง: ${finalSeconds} วินาที`, color: '#38BDF8', size: 'lg', weight: 'bold', align: 'center', margin: 'xs' },
                  ],
                },
                body: {
                  type: 'box',
                  layout: 'vertical',
                  spacing: 'sm',
                  contents: [
                    { type: 'text', text: `ช่วงราคาเป้าหมาย: ${tMin}-${tMax} วิ`, size: 'xs', color: '#64748B', align: 'center' },
                    { type: 'text', text: `ชำระผลตัดสินเรียบร้อย ${resolvedOrders.length} แผลดวล 🚀`, size: 'sm', color: '#059669', weight: 'bold', align: 'center' },
                  ],
                },
              },
            };
            await Promise.all(targets.map((to) => pushToLine(to, settleFlex, env)));

            // Task 3: P2P per-pair result breakdown broadcast to active groups
            const pairBodies: any[] = resolvedOrders
              .filter((o) => o.winnerSide && o.winnerSide !== 'draw')
              .slice(0, 20)
              .map((o) => {
                const winName = o.winnerName || '-';
                const loseName = o.winnerSide === 'low'
                  ? (o.side === 'high' ? o.matcherName || o.creatorName : o.creatorName)
                  : (o.side === 'high' ? o.matcherName || o.creatorName : o.creatorName);
                return {
                  type: 'box',
                  layout: 'horizontal',
                  spacing: 'sm',
                  contents: [
                    { type: 'text', text: `#${o.orderNumber}`, size: 'xs', color: '#64748B', flex: 2, wrap: true },
                    { type: 'text', text: `💰 ${Number(o.amount).toLocaleString()}`, size: 'xs', color: '#0F172A', weight: 'bold', flex: 2, align: 'end' },
                    { type: 'text', text: `👑 ${String(winName).slice(0, 14)}`, size: 'xs', color: '#059669', weight: 'bold', flex: 4, wrap: true },
                    { type: 'text', text: `💥 ${String(loseName).slice(0, 14)}`, size: 'xs', color: '#DC2626', flex: 4, wrap: true },
                  ],
                };
              });
            if (pairBodies.length > 0) {
              const p2pFlex = {
                type: 'flex',
                altText: `🤝 ผลดวลตัวต่อตัว ${pairBodies.length} แผล (รับยอดสุทธิ 1.9 เท่าหลังหักค่าธรรมเนียม 10%)`,
                contents: {
                  type: 'bubble',
                  size: 'giga',
                  header: {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#064E3B',
                    paddingAll: 'md',
                    contents: [
                      { type: 'text', text: '🤝 ผลดวลตัวต่อตัว (P2P)', weight: 'bold', color: '#FDE047', size: 'sm', align: 'center' },
                      { type: 'text', text: `รอบ [${activeRound.name || 'บั้งไฟสด'}] | เวลา ${finalSeconds}s`, color: '#FFFFFF', size: 'xs', align: 'center', margin: 'xs' },
                    ],
                  },
                  body: {
                    type: 'box',
                    layout: 'vertical',
                    spacing: 'sm',
                    contents: pairBodies,
                  },
                },
              };
              await Promise.all(targets.map((to) => pushToLine(to, p2pFlex, env)));
            }
          }

          result = { success: true, resolvedCount: resolvedOrders.length, finalTime: finalSeconds };
        } else if (functionName === 'simulateTextMessageFromDashboard') {
          const text = args[0];
          const userId = args[1] || 'user';
          const activeGroupId = await env.KV_CACHE.get('ACTIVE_GROUP_ID');
          const targetGroup = args[3] || activeGroupId || 'C_SIMULATED_GROUP';

          const mockEvent: LineEvent = {
            type: 'message',
            timestamp: Date.now(),
            source: {
              type: 'group',
              groupId: targetGroup,
              userId: userId,
            },
            message: {
              id: `sim_${Date.now()}`,
              type: 'text',
              text: String(text),
            },
          };

          await processLineEvent(mockEvent, env, ctx);
          result = { success: true, simulatedText: text };
        } else if (functionName === 'saveOpenBet') {
          const creatorId = String(args[1] || '');
          const creatorName = String(args[2] || '');
          const side = args[3] === 'low' || args[3] === 'high' ? args[3] : 'low';
          const amount = Number(args[4]);
          const targetMin = Number(args[5]);
          const targetMax = Number(args[6]);
          const requestId = String(body.requestId || '');
          if (!requestId) throw new CoordinatorError('INVALID_INPUT', 'requestId is required to create an order');
          if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount * 100)) {
            throw new CoordinatorError('INVALID_INPUT', 'Order stake must be a positive whole-point amount');
          }
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          if (!roundStr) throw new CoordinatorError('INVALID_STATE', 'There is no active round');
          const round = JSON.parse(roundStr);
          if (!round.roundId) throw new CoordinatorError('INVALID_STATE', 'Active round has no coordinator ID');
          const activeGroupId = await env.KV_CACHE.get('ACTIVE_GROUP_ID');
          const order = await createCoordinatorClient(env).createOrder({
            idempotencyKey: `dashboard-create-order:${requestId}`,
            roundId: round.roundId,
            creatorId,
            creatorName,
            side,
            stakeHundredths: amount * 100,
            betType: round.quoteReleased ? 'range' : 'pre_quote',
            rangeMin: Number.isFinite(targetMin) ? targetMin : 330,
            rangeMax: Number.isFinite(targetMax) ? targetMax : 380,
            groupId: activeGroupId || 'dashboard',
          });
          const newOrder = {
            orderNumber: order.orderNumber,
            creatorId: order.creatorId,
            creatorName: order.creatorName,
            side: order.side,
            amount: order.stakeHundredths / 100,
            betType: order.betType,
            rangeMin: order.rangeMin,
            rangeMax: order.rangeMax,
            status: order.status,
            groupId: order.groupId,
            createdAt: order.createdAt,
          };
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(newOrder));
          const orderFlex = generateOrderFlex(newOrder as any);
          if (activeGroupId) {
            await pushToLine(activeGroupId, orderFlex, env);
          }
          result = { success: true, order: newOrder };
        }

        return new Response(JSON.stringify({ success: true, data: result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err: any) {
        const status = err instanceof CoordinatorError ? err.status : 500;
        const body = err instanceof CoordinatorError
          ? { error: { code: err.code, message: err.message } }
          : { error: err?.message || 'Server error' };
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },

  /**
   * Cloudflare Worker Queue Consumer Handler
   * Acknowledges and archives events for telemetry / persistence
   */
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        // Events are already processed inline during the Webhook fetch() for sub-100ms reply speed.
        // The Queue securely archives and acks the event without double-spending replyTokens.
        message.ack();
      } catch (err) {
        console.error('[Queue Consumer] Error acknowledging message:', message.id, err);
        message.ack();
      }
    }
  },
};
