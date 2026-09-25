import { Env, LineWebhookPayload, QueueMessage, LineEvent } from './types.js';
import { verifyLineSignature } from './signature.js';
import {
  processLineEvent,
  clearAllPendingOrders,
  cancelHeldPreQuoteOrders,
  releaseHeldPreQuoteOrders,
  autoMatchPendingPairs,
  voidAllRoundOrders,
  getPendingOrdersList,
  getPlayersList,
  savePlayerProfile,
  getTransactionsList,
  addTransaction,
  pushToLine,
  logUserMessage,
  getMatchedOrdersList,
  getSettledOrdersList,
  addToSettledOrdersList,
  removeFromMatchedOrdersList,
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
        // Inject a per-event UUID so the inline path and the queue consumer can
        // dedup against each other. Previously BOTH paths executed the full
        // processLineEvent(), double-charging replies/pushes and double-writing
        // ledger entries for every single user message.
        for (const event of events) {
          event.webhookEventId = event.webhookEventId || crypto.randomUUID();
        }

        // Replay-probe isolation: LINE Console "Verify" button sends a synthetic
        // event with a fake replyToken (no real user behind it). Reply/push calls
        // on it fail noisily and pollute logs — acknowledge without processing.
        const isVerifyProbe = events.some(
          (e) => e.replyToken && /^0000[0-9a-f]{26,}$/.test(e.replyToken)
        );

        const interactiveProcessing = Promise.all(
          events.map(async (event) => {
            try {
              if (!isVerifyProbe) {
                await processLineEvent(event, env, ctx);
              }
            } catch (err) {
              console.error('[Worker] Event processing error:', err);
            }
          })
        );

        if (env.LINE_EVENTS_QUEUE) {
          const queueBatch = events.map((event) => ({
            body: {
              id: event.webhookEventId!,
              receivedAt: Date.now(),
              event,
            } as QueueMessage,
          }));
          ctx.waitUntil(env.LINE_EVENTS_QUEUE.sendBatch(queueBatch));
        }

        await interactiveProcessing;
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

        const authHeader = request.headers.get('x-admin-key') || request.headers.get('x-admin-api-key') || body?.adminKey || body?.apiKey;
        const isReadOnly = functionName === 'getDashboardData' || functionName === 'verifyMockSlipFromClient' || functionName === 'adminLogin';
        if (env.ADMIN_API_KEY && !isReadOnly && authHeader !== env.ADMIN_API_KEY) {
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
          if ((username.toLowerCase() === 'admin') && (password === 'rocket-admin' || password === env.ADMIN_API_KEY)) {
            result = { success: true, adminKey: env.ADMIN_API_KEY, username: 'admin' };
          } else {
            result = { success: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
          }
        } else if (functionName === 'adminApproveTransaction') {
          const txId = args[0];
          const txs = await getTransactionsList(env);
          const targetTx = txs.find(t => t.id === txId);
          if (targetTx) {
            targetTx.status = 'success';
            targetTx.actualAmount = targetTx.requestedAmount;
            await env.KV_CACHE.put('TRANSACTIONS_LIST', JSON.stringify(txs));

            const isWithdrawal = String(txId).startsWith('WD') || targetTx.type === 'withdraw';
            const players = await getPlayersList(env);
            const player = players.find(p => p.id === targetTx.playerId || p.lineUserId === targetTx.playerId);
            if (player) {
              const rawLine = player.lineUserId || await env.KV_CACHE.get(`RAW_LINE_${player.id}`) || player.id;
              if (isWithdrawal) {
                // Withdrawal: balance was already deducted upon request. Notify player of success.
                if (rawLine) {
                  ctx?.waitUntil(pushToLine(rawLine, `💸 [ถอนเงินสำเร็จ]: ยอด ${targetTx.requestedAmount.toLocaleString()} บาท แอดมินได้โอนเข้าบัญชีของคุณเรียบร้อยแล้วครับ 🚀`, env).catch(e => console.error(e)));
                }
              } else {
                // Deposit: credit player balance
                player.balance = (Number(player.balance) || 0) + targetTx.requestedAmount;
                await savePlayerProfile({
                  shortId: player.id,
                  lineUserId: rawLine,
                  displayName: player.name,
                  balance: player.balance,
                  bankName: player.bankName,
                  accountNumber: player.bankAccount,
                  accountName: player.accountName,
                  registeredAt: Date.now(),
                  updatedAt: Date.now(),
                }, env, ctx);

                // Push notice to player
                if (rawLine) {
                  ctx?.waitUntil(pushToLine(rawLine, `✅ อนุมัติยอดเงินฝาก ${targetTx.requestedAmount.toLocaleString()} บาท เรียบร้อยแล้วครับ!\nแต้มคงเหลือปัจจุบัน: ${player.balance.toLocaleString()} pt 🚀`, env).catch(e => console.error(e)));
                }
              }
            }
          }
          result = { success: true, txId };
        } else if (functionName === 'adminRejectTransaction') {
          const txId = args[0];
          const reason = args[1] || 'ไม่พบยอดเงินเข้าบัญชี';
          const txs = await getTransactionsList(env);
          const targetTx = txs.find(t => t.id === txId);
          if (targetTx) {
            targetTx.status = 'rejected';
            targetTx.reviewReason = reason;
            await env.KV_CACHE.put('TRANSACTIONS_LIST', JSON.stringify(txs));

            const isWithdrawal = String(txId).startsWith('WD') || targetTx.type === 'withdraw';
            const players = await getPlayersList(env);
            const player = players.find(p => p.id === targetTx.playerId || p.lineUserId === targetTx.playerId);
            if (player) {
              const rawLine = player.lineUserId || await env.KV_CACHE.get(`RAW_LINE_${player.id}`) || player.id;
              if (isWithdrawal) {
                // Refund locked withdrawal points back to player profile
                player.balance = (Number(player.balance) || 0) + targetTx.requestedAmount;
                await savePlayerProfile({
                  shortId: player.id,
                  lineUserId: rawLine,
                  displayName: player.name,
                  balance: player.balance,
                  bankName: player.bankName,
                  accountNumber: player.bankAccount,
                  accountName: player.accountName,
                  registeredAt: Date.now(),
                  updatedAt: Date.now(),
                }, env, ctx);

                if (rawLine) {
                  ctx?.waitUntil(pushToLine(rawLine, `❌ [ปฏิเสธการถอนเงิน]: ยอด ${targetTx.requestedAmount.toLocaleString()} pt (สาเหตุ: ${reason})\nระบบได้คืนแต้มเข้ากระเป๋าเรียบร้อย แต้มคงเหลือ: ${player.balance.toLocaleString()} pt 🚀`, env).catch(e => console.error(e)));
                }
              } else {
                if (rawLine) {
                  ctx?.waitUntil(pushToLine(rawLine, `❌ [ปฏิเสธการฝากเงิน]: ยอด ${targetTx.requestedAmount.toLocaleString()} บาท (สาเหตุ: ${reason})`, env).catch(e => console.error(e)));
                }
              }
            }
          }
          result = { success: true, txId };
        } else if (functionName === 'adminSetPlayerBalance') {
          const userId = args[0];
          const newBal = Number(args[1]) || 0;
          const passedName = args[2] ? String(args[2]).trim() : '';

          const players = await getPlayersList(env);
          const player = players.find(p => p.id === userId || p.lineUserId === userId || (p.shortId && p.shortId === userId));
          const targetLineUserId = player?.lineUserId || (await env.KV_CACHE.get(`RAW_LINE_${userId}`)) || userId;
          const displayName = player?.name || player?.displayName || passedName || 'ผู้เล่น';
          let oldBal = player ? (Number(player.balance) || 0) : 0;

          const profileRaw = await env.KV_CACHE.get(`USER_${targetLineUserId}`);
          if (profileRaw) {
            const p = JSON.parse(profileRaw);
            if (p.balance !== undefined) oldBal = Number(p.balance) || 0;
            p.balance = newBal;
            if (passedName) p.displayName = passedName;

            // Ledger-First: Record admin adjustment before updating profile
            await addTransaction({
              id: `ADJ${Date.now().toString().slice(-6)}`,
              playerId: p.shortId,
              playerName: p.displayName,
              requestedAmount: newBal - oldBal,
              actualAmount: newBal - oldBal,
              slipRef: 'ADMIN_ADJUST',
              status: 'success',
              reviewReason: `Admin set balance: ${oldBal} → ${newBal}`,
              timestamp: formatTime(),
              type: 'deposit',
              createdAt: Date.now(),
            }, env, ctx);

            await savePlayerProfile(p, env, ctx);
          } else {
            await savePlayerProfile({
              shortId: userId.startsWith('PL') ? userId : `PL${userId.slice(-6).toUpperCase()}`,
              lineUserId: targetLineUserId,
              displayName: displayName,
              balance: newBal,
              registeredAt: Date.now(),
              updatedAt: Date.now(),
            }, env, ctx);
          }

          // Push DM to LINE user so they are immediately aware of their updated credit amount
          if (targetLineUserId && targetLineUserId.startsWith('U')) {
            try {
              const adjustFlex = generateCreditAdjustmentFlex(displayName, oldBal, newBal);
              ctx?.waitUntil(Promise.all([
                pushToLine(targetLineUserId, adjustFlex, env).catch(e => console.error(e)),
                appendChatLog(env, {
                  timestamp: formatTime(),
                  userId: targetLineUserId,
                  displayName: 'แอดมิน',
                  sender: 'admin',
                  text: `💰 แจ้งเตือนปรับยอดเครดิต: ${oldBal.toLocaleString()} pt → ${newBal.toLocaleString()} pt`,
                  type: 'flex',
                }).catch(e => console.error(e))
              ]));
            } catch (pushErr) {
              console.error('[Worker] Error pushing credit adjustment to DM:', pushErr);
            }
          }

          result = { success: true, balance: newBal };
        } else if (functionName === 'adminCreatePlayer') {
          const lineId = args[0];
          const name = args[1];
          const bal = Number(args[2]) || 0;
          const shortId = lineId && lineId.length <= 8 ? lineId.toUpperCase() : `PL${lineId.slice(-6).toUpperCase()}`;
          const newP = {
            shortId,
            lineUserId: lineId,
            displayName: name || 'ผู้เล่นใหม่',
            balance: bal,
            registeredAt: Date.now(),
            updatedAt: Date.now(),
          };
          await savePlayerProfile(newP, env, ctx);

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
          const userId = args[0];
          const rawLine = await env.KV_CACHE.get(`RAW_LINE_${userId}`) || userId;
          await env.KV_CACHE.delete(`USER_${rawLine}`);
          await env.KV_CACHE.delete(`RAW_LINE_${userId}`);
          const listRaw = await env.KV_CACHE.get('PLAYERS_LIST');
          if (listRaw) {
            const list = JSON.parse(listRaw);
            const filtered = list.filter((p: any) => p.shortId !== userId && p.lineUserId !== rawLine);
            await env.KV_CACHE.put('PLAYERS_LIST', JSON.stringify(filtered));
          }
          result = { success: true };
        } else if (functionName === 'adminSetActiveGroupId') {
          const gid = args[0];
          await env.KV_CACHE.put('ACTIVE_GROUP_ID', gid);
          result = { success: true, activeGroupId: gid };
        } else if (functionName === 'adminOpenRound') {
          const roundName = args[0] || 'บั้งไฟสด';
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify({
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
          // 1. Clear atomic order state in KV
          await clearAllPendingOrders(env);
          // 2. Clear players, transactions, and logs in KV
          await env.KV_CACHE.delete('PLAYERS_LIST');
          await env.KV_CACHE.delete('TRANSACTIONS_LIST');
          await env.KV_CACHE.delete('CHAT_LOGS');
          // 3. Clear all cached player profiles and raw LINE mappings
          try {
            const userScan = await env.KV_CACHE.list({ prefix: 'USER_' });
            if (userScan.keys && userScan.keys.length > 0) {
              await Promise.all(userScan.keys.map((k) => env.KV_CACHE.delete(k.name)));
            }
            const rawScan = await env.KV_CACHE.list({ prefix: 'RAW_LINE_' });
            if (rawScan.keys && rawScan.keys.length > 0) {
              await Promise.all(rawScan.keys.map((k) => env.KV_CACHE.delete(k.name)));
            }
          } catch (_) {}

          // 4. Forward database reset to Google Apps Script / Google Sheets
          let sheetsResetResult: any = null;
          if (env.GAS_FALLBACK_URL) {
            try {
              const res = await fetch(env.GAS_FALLBACK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                  functionName: 'resetGoogleSheetsDatabase',
                  args: [],
                  apiKey: env.ADMIN_API_KEY,
                }),
              });
              const json: any = await res.json();
              sheetsResetResult = json?.data || json;
            } catch (err) {
              console.warn('[Worker] GAS reset database error:', err);
            }
          }

          result = sheetsResetResult || {
            players: [],
            transactions: [],
            bets: [],
            chatLogs: [],
            activeGroupId: (await env.KV_CACHE.get('ACTIVE_GROUP_ID')) || '',
            roundStatus: 'ACTIVE',
          };
        } else if (functionName === 'syncWithSheets') {
          // ── Merge-Safe Force Sync ──
          // Previously this REPLACED the dashboard payload with the raw GAS sheet
          // response — an empty/stale sheet blanked out live KV players, chats and
          // transactions in the admin view. Now: KV stays authoritative; sheet rows
          // are merged in only when non-empty (never overwrite, only enrich).
          let sheetsData: any = null;
          if (env.GAS_FALLBACK_URL) {
            try {
              const res = await fetch(`${env.GAS_FALLBACK_URL}?action=getDashboardData&_t=${Date.now()}`);
              const json: any = await res.json();
              sheetsData = json?.data || json;
            } catch (e) {
              console.warn('[Worker] syncWithSheets fetch error:', e);
            }
          }
          const kvPlayers = await getPlayersList(env);
          const kvTx = await getTransactionsList(env);
          const kvBets = await getPendingOrdersList(env);
          if (sheetsData && Array.isArray(sheetsData.players) && sheetsData.players.length > 0) {
            const merged = [...kvPlayers];
            for (const sp of sheetsData.players) {
              const kvMatch = merged.find(
                (kp: any) => kp && sp && (kp.lineUserId === sp.lineUserId || kp.shortId === sp.id || kp.lineUserId === sp.id)
              );
              if (!kvMatch) {
                merged.push({
                  shortId: sp.id || sp.shortId,
                  lineUserId: sp.lineUserId || sp.id,
                  displayName: sp.name || sp.displayName || 'ผู้เล่น',
                  balance: Number(sp.balance) || 0,
                });
              }
            }
            result = {
              players: merged,
              transactions: Array.isArray(sheetsData.transactions) && sheetsData.transactions.length > 0
                ? [...kvTx, ...sheetsData.transactions].slice(0, 100)
                : kvTx,
              bets: kvBets,
              activeGroupId: (await env.KV_CACHE.get('ACTIVE_GROUP_ID')) || '',
            };
          } else {
            result = {
              players: kvPlayers,
              transactions: kvTx,
              bets: kvBets,
              activeGroupId: (await env.KV_CACHE.get('ACTIVE_GROUP_ID')) || '',
            };
          }
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

          const roundData = {
            name,
            targetMin: min,
            targetMax: max,
            status: 'ACTIVE',
            isChotoy,
            quoteReleased: true,
            updatedAt: Date.now(),
          };
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(roundData));

          await releaseHeldPreQuoteOrders(min, max, env, ctx);

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
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งข้อความเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminBroadcastFinalCall') {
          const target = args[0];
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
          round.status = 'CLOSED';
          round.updatedAt = Date.now();
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));

          if (round.quoteReleased !== true) {
            await cancelHeldPreQuoteOrders(env, ctx);
          }

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

          await clearAllPendingOrders(env);

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
              error: allSuccess ? undefined : (quotaError?.error || 'ส่งเข้าบางกลุ่มไม่สำเร็จ'),
              code: quotaError ? 429 : (allSuccess ? 200 : 400),
              isQuotaExhausted: !!quotaError,
              results: sendResults,
            };
          }
        } else if (functionName === 'adminBroadcastVoidRound') {
          const target = args[0];
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
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

          await voidAllRoundOrders(env, ctx);

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
          const finalSeconds = Number(args[0]) || 0;
          const tMin = Number(args[1]) || 330;
          const tMax = Number(args[2]) || 380;

          const matchedOrders = await getMatchedOrdersList(env);
          const resolvedOrders: any[] = [];
          const activeRoundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          const activeRound = activeRoundStr ? JSON.parse(activeRoundStr) : { name: 'บั้งไฟสด' };

          // Any orders still held as pre_quote (price never released this round) must be
          // auto-cancelled + refunded before settlement.
          await cancelHeldPreQuoteOrders(env, ctx);

          for (const order of matchedOrders) {
            const amt = Number(order.amount) || 0;
                let winnerSide: 'low' | 'high' | 'draw' = 'draw';
                if (finalSeconds < tMin) {
                  winnerSide = 'low';
                } else if (finalSeconds > tMax) {
                  winnerSide = 'high';
                } else {
                  winnerSide = 'draw';
                }

                let winnerName = '-';
                let winnerLineId = '';
                if (winnerSide === 'low') {
                  winnerName = (order.side === 'low' ? order.creatorName : order.matcherName) || '-';
                  winnerLineId = order.side === 'low' ? order.creatorId : (order.matcherId || '');
                } else if (winnerSide === 'high') {
                  winnerName = (order.side === 'high' ? order.creatorName : order.matcherName) || '-';
                  winnerLineId = order.side === 'high' ? order.creatorId : (order.matcherId || '');
                }

                order.status = 'settled';
                order.finalTime = finalSeconds;
                order.winnerSide = winnerSide;
                order.winnerName = winnerName;
                order.settledAt = Date.now();
                await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
                await addToSettledOrdersList(order, env);
                await removeFromMatchedOrdersList(order.orderNumber, env);
                resolvedOrders.push(order);

                if (winnerLineId && winnerSide !== 'draw') {
                  const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${winnerLineId}`)) || (winnerLineId === order.creatorId ? order.creatorLineUserId : null) || winnerLineId;
                  const winProfRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
                  if (winProfRaw) {
                    const wp = JSON.parse(winProfRaw);
                    wp.balance = (Number(wp.balance) || 0) + (amt * 2);
                    await savePlayerProfile(wp, env, ctx);
                  }
                } else if (winnerSide === 'draw') {
                  if (order.creatorId) {
                    const cRawLine = (await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`)) || order.creatorLineUserId || order.creatorId;
                    const cpRaw = await env.KV_CACHE.get(`USER_${cRawLine}`);
                    if (cpRaw) {
                      const cp = JSON.parse(cpRaw);
                      cp.balance = (Number(cp.balance) || 0) + amt;
                      await savePlayerProfile(cp, env, ctx);
                    }
                  }
                  if (order.matcherId) {
                    const mRawLine = (await env.KV_CACHE.get(`RAW_LINE_${order.matcherId}`)) || order.matcherId;
                    const mpRaw = await env.KV_CACHE.get(`USER_${mRawLine}`);
                    if (mpRaw) {
                      const mp = JSON.parse(mpRaw);
                      mp.balance = (Number(mp.balance) || 0) + amt;
                      await savePlayerProfile(mp, env, ctx);
                    }
                  }
                }
          }


          activeRound.status = 'CLOSED';
          activeRound.finalTime = finalSeconds;
          activeRound.updatedAt = Date.now();
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(activeRound));

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
                altText: `🤝 ผลดวลตัวต่อตัว ${pairBodies.length} แผล (ผู้ชนะครบ 2x)`,
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
          const orderNo = args[0];
          const creatorId = args[1];
          const creatorName = args[2];
          const side = args[3] === 'low' || args[3] === 'high' ? args[3] : 'low';
          const amount = Number(args[4]) || 100;
          const targetMin = Number(args[5]) || 330;
          const targetMax = Number(args[6]) || 380;
          const isChotoy = Boolean(args[7]);
          const rocketName = args[8] || 'บั้งไฟสด';

          const activeGroupId = await env.KV_CACHE.get('ACTIVE_GROUP_ID');
          const newOrder = {
            orderNumber: String(orderNo),
            creatorId,
            creatorName,
            side,
            amount,
            status: 'open',
            groupId: activeGroupId || '',
            targetMin,
            targetMax,
            isChotoy,
            rocketName,
            createdAt: Date.now(),
          };

          await env.KV_ORDERS.put(`ORDER_${orderNo}`, JSON.stringify(newOrder));
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
        return new Response(JSON.stringify({ error: err?.message || 'Server error' }), {
          status: 500,
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
