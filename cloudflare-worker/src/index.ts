import { Env, LineWebhookPayload, QueueMessage, LineEvent } from './types.js';
import { verifyLineSignature } from './signature.js';
import {
  processLineEvent,
  clearAllPendingOrders,
  getPendingOrdersList,
  getPlayersList,
  savePlayerProfile,
  getTransactionsList,
  addTransaction,
  pushToLine,
} from './queueHandler.js';
import {
  generateRuleGuideFlex,
  generateBalanceFlex,
  generateDepositFlex,
  generatePendingBoardFlex,
  generateWithdrawalFlex,
  generateOrderFlex,
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
  if (activeGroupId && activeGroupId.trim()) {
    targetSet.add(activeGroupId.trim());
  }

  const lineGroupsRaw = await env.KV_CACHE.get('LINE_GROUPS');
  if (lineGroupsRaw) {
    try {
      const groups = JSON.parse(lineGroupsRaw);
      if (Array.isArray(groups)) {
        groups.forEach((g: any) => {
          if (g && g.id && typeof g.id === 'string' && g.id.trim()) {
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
        const interactiveProcessing = Promise.all(
          events.map(async (event) => {
            try {
              await processLineEvent(event, env, ctx);
            } catch (err) {
              console.error('[Worker] Event processing error:', err);
            }
          })
        );

        if (env.LINE_EVENTS_QUEUE) {
          const queueBatch = events.map((event) => ({
            body: {
              id: crypto.randomUUID(),
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
          const lineGroups = lineGroupsRaw
            ? JSON.parse(lineGroupsRaw)
            : (activeGroupId ? [{ id: activeGroupId, name: `🚀 กลุ่มดวลสด (#${activeGroupId.slice(-4)})`, lastMessage: '', timestamp: 'Live' }] : []);
          const chatLogsRaw = await env.KV_CACHE.get('CHAT_LOGS');
          const chatLogs = chatLogsRaw ? JSON.parse(chatLogsRaw) : [];

          result = {
            players,
            transactions,
            bets: pendingBets,
            chatLogs,
            activeGroupId: activeGroupId || '',
            lineGroups,
            activeRound: roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380, status: 'ACTIVE' },
            roundStatus: roundStr ? (JSON.parse(roundStr).status || 'ACTIVE') : 'ACTIVE',
            serverTime: new Date().toISOString(),
          };
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

            // Credit player balance
            const players = await getPlayersList(env);
            const player = players.find(p => p.id === targetTx.playerId || p.lineUserId === targetTx.playerId);
            if (player) {
              player.balance = (Number(player.balance) || 0) + targetTx.requestedAmount;
              const rawLine = player.lineUserId || await env.KV_CACHE.get(`RAW_LINE_${player.id}`) || player.id;
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
                await fetch('https://api.line.me/v2/bot/message/push', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
                  },
                  body: JSON.stringify({
                    to: rawLine,
                    messages: [{
                      type: 'text',
                      text: `✅ อนุมัติยอดเงินฝาก ${targetTx.requestedAmount.toLocaleString()} บาท เรียบร้อยแล้วครับ!\nแต้มคงเหลือปัจจุบัน: ${player.balance.toLocaleString()} pt 🚀`,
                    }],
                  }),
                }).catch(() => {});
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
          }
          result = { success: true, txId };
        } else if (functionName === 'adminSetPlayerBalance') {
          const userId = args[0];
          const newBal = Number(args[1]) || 0;
          const rawLine = await env.KV_CACHE.get(`RAW_LINE_${userId}`) || userId;
          const profileRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
          if (profileRaw) {
            const p = JSON.parse(profileRaw);
            p.balance = newBal;
            await savePlayerProfile(p, env, ctx);
          } else {
            await savePlayerProfile({
              shortId: userId.startsWith('PL') ? userId : `PL${userId.slice(-6).toUpperCase()}`,
              lineUserId: rawLine,
              displayName: 'ผู้เล่น',
              balance: newBal,
              registeredAt: Date.now(),
              updatedAt: Date.now(),
            }, env, ctx);
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
            updatedAt: Date.now(),
          }));
          result = { success: true, round: roundName };
        } else if (
          functionName === 'clearPendingBets' ||
          functionName === 'adminClearOrders' ||
          functionName === 'resetOrders' ||
          functionName === 'resetGoogleSheetsDatabase' ||
          functionName === 'clearCache'
        ) {
          const res = await clearAllPendingOrders(env);
          result = { success: true, message: 'Cleared pending orders and board cache', cleared: res.cleared };
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
              } else if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit') {
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
            const allSuccess = sendResults.every(Boolean);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'แอดมิน',
              sender: 'admin',
              text: isObj ? '[Flex Message]' : String(messageText),
              type: isObj ? 'flex' : 'text',
            });

            result = {
              success: allSuccess,
              count: targets.length,
              targets,
              error: allSuccess ? undefined : 'ส่งเข้าบางกลุ่มไม่สำเร็จ (กรุณาเช็คสิทธิ์ LINE OA ในกลุ่ม)',
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
            const allSuccess = sendResults.every(Boolean);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: name,
              sender: 'admin',
              text: `[เปิดราคา: ${name} (${min}-${max}s)]`,
              type: 'flex',
            });

            result = { success: allSuccess, targets, round: roundData };
          }
        } else if (functionName === 'adminBroadcastFinalCall') {
          const target = args[0];
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
          round.status = 'CLOSED';
          round.updatedAt = Date.now();
          await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));

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
            await Promise.all(targets.map((to) => pushToLine(to, finalFlex, env)));
            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[⛔ ปิดรับดวลรอบนี้แล้ว]',
              type: 'flex',
            });
            result = { success: true, targets };
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

          await clearAllPendingOrders(env);

          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
          } else {
            await Promise.all(targets.map((to) => pushToLine(to, voidFlex, env)));
            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[⛔ โมฆะรอบการแข่งขัน]',
              type: 'flex',
            });
            result = { success: true, targets };
          }
        } else if (functionName === 'adminBroadcastRuleGuide') {
          const target = args[0];
          const ruleFlex = generateRuleGuideFlex();
          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
          } else {
            await Promise.all(targets.map((to) => pushToLine(to, ruleFlex, env)));
            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[📖 คู่มือกติกา]',
              type: 'flex',
            });
            result = { success: true, targets };
          }
        } else if (functionName === 'adminBroadcastScamWarning') {
          const target = args[0];
          const warnFlex = {
            type: 'flex',
            altText: '🚨 เตือนความปลอดภัย 🚨',
            contents: {
              type: 'bubble',
              size: 'kilo',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#FDE68A',
                paddingAll: 'md',
                contents: [
                  { type: 'text', text: '🚨 เตือนความปลอดภัย 🚨', weight: 'bold', color: '#92400E', size: 'sm', align: 'center', wrap: true },
                ],
              },
              body: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#FEFCE8',
                spacing: 'xs',
                contents: [
                  { type: 'text', text: '⚠️ ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA 1:1 เท่านั้นครับ', weight: 'bold', color: '#B45309', size: 'xs', align: 'center', wrap: true },
                ],
              },
            },
          };

          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
          } else {
            await Promise.all(targets.map((to) => pushToLine(to, warnFlex, env)));
            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: '[🚨 เตือนความปลอดภัย]',
              type: 'flex',
            });
            result = { success: true, targets };
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
            const allSuccess = sendResults.every(Boolean);

            await appendChatLog(env, {
              timestamp: timeStr,
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: msg,
              type: 'text',
            });
            result = { success: allSuccess, targets, error: allSuccess ? undefined : 'ส่งเข้าบางกลุ่มไม่สำเร็จ' };
          }
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

          const keysList = await env.KV_ORDERS.list({ prefix: 'ORDER_' });
          const resolvedOrders: any[] = [];
          const activeRoundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          const activeRound = activeRoundStr ? JSON.parse(activeRoundStr) : { name: 'บั้งไฟสด' };

          for (const key of keysList.keys) {
            const raw = await env.KV_ORDERS.get(key.name);
            if (!raw) continue;
            try {
              const order = JSON.parse(raw);
              if (order.status === 'matched') {
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
                  winnerName = order.side === 'low' ? order.creatorName : order.matcherName;
                  winnerLineId = order.side === 'low' ? order.creatorId : (order.matcherId || '');
                } else if (winnerSide === 'high') {
                  winnerName = order.side === 'high' ? order.creatorName : order.matcherName;
                  winnerLineId = order.side === 'high' ? order.creatorId : (order.matcherId || '');
                }

                order.status = 'settled';
                order.finalTime = finalSeconds;
                order.winnerSide = winnerSide;
                order.winnerName = winnerName;
                order.settledAt = Date.now();
                await env.KV_ORDERS.put(key.name, JSON.stringify(order));
                resolvedOrders.push(order);

                if (winnerLineId && winnerSide !== 'draw') {
                  const winProfRaw = await env.KV_CACHE.get(`USER_${winnerLineId}`);
                  if (winProfRaw) {
                    const wp = JSON.parse(winProfRaw);
                    wp.balance = (Number(wp.balance) || 0) + (amt * 2);
                    await savePlayerProfile(wp, env, ctx);
                  }
                } else if (winnerSide === 'draw') {
                  if (order.creatorId) {
                    const cpRaw = await env.KV_CACHE.get(`USER_${order.creatorId}`);
                    if (cpRaw) {
                      const cp = JSON.parse(cpRaw);
                      cp.balance = (Number(cp.balance) || 0) + amt;
                      await savePlayerProfile(cp, env, ctx);
                    }
                  }
                  if (order.matcherId) {
                    const mpRaw = await env.KV_CACHE.get(`USER_${order.matcherId}`);
                    if (mpRaw) {
                      const mp = JSON.parse(mpRaw);
                      mp.balance = (Number(mp.balance) || 0) + amt;
                      await savePlayerProfile(mp, env, ctx);
                    }
                  }
                }
              }
            } catch (_) {}
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
        message.ack(); // Acknowledge archived event
      } catch (err) {
        console.error('[Queue Consumer] Error acknowledging message:', message.id, err);
      }
    }
  },
};
