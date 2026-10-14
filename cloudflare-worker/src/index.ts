import { Env, LineWebhookPayload, QueueMessage, LineEvent, PlayerProfile, Order } from './types.js';
import { verifyLineSignature } from './signature.js';
import { state } from './state.js';
import {
  setAdminPassword,
  verifyAdminLogin,
  changeAdminPassword,
  resetAdminPasswordWithRecoveryCode,
  getCredentialStatus,
  regenerateRecoveryCodes,
  validatePasswordStrength,
  PASSWORD_MAX_AGE_DAYS,
} from './credentials.js';
import { RocketStateDO } from './stateDO.js';
import {
  issueSessionToken,
  verifySessionToken,
  timingSafeEqual,
  
  SessionClaims,
  AdminRole,
} from './auth.js';
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
  removeFromPendingOrdersList,
  refundPlayerPoints,
  deduplicatePlayers,
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

function formatOrderForDashboard(b: Order): any {
  const isLow = b.side === 'low';
  const playerLowId = b.playerLowId || (isLow ? (b.creatorId || b.creatorLineUserId || '') : (b.matcherId || b.matcherLineUserId || ''));
  const playerLowName = b.playerLowName || (isLow ? b.creatorName : (b.matcherName || ''));
  const playerHighId = b.playerHighId || (!isLow ? (b.creatorId || b.creatorLineUserId || '') : (b.matcherId || b.matcherLineUserId || ''));
  const playerHighName = b.playerHighName || (!isLow ? b.creatorName : (b.matcherName || ''));

  return {
    ...b,
    id: b.id || `bet_${b.orderNumber}`,
    orderNumber: b.orderNumber,
    playerLowId,
    playerLowName,
    playerHighId,
    playerHighName,
    amount: Number(b.amount) || 0,
    type: b.betType || 'range',
    rangeMin: b.rangeMin,
    rangeMax: b.rangeMax,
    status: b.status,
    timestamp: b.createdAt ? new Date(b.createdAt).toLocaleTimeString('th-TH', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '',
  };
}

async function resolveTargetGroupIds(target: string | undefined, env: Env): Promise<string[]> {
  if (target && target !== 'ALL' && target !== 'GROUP_STREAM') {
    if (target.startsWith('PL')) {
      const rawLine = await state(env).get(`RAW_LINE_${target}`);
      if (rawLine) return [rawLine];
    }
    return [target];
  }

  const targetSet = new Set<string>();
  const activeGroupId = await state(env).get('ACTIVE_GROUP_ID');
  if (activeGroupId && /^[CR][0-9a-f]{32}$/i.test(activeGroupId.trim())) {
    targetSet.add(activeGroupId.trim());
  }

  const lineGroupsRaw = await state(env).get('LINE_GROUPS');
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

/**
 * Stable hash of a dashboard payload, used for ETag / If-None-Match.
 * JSON.stringify preserves key insertion order, and the payload is built the
 * same way every time, so this is stable across identical states.
 */
async function hashPayload(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload);
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

/** Parse JSON without throwing — used on data that may be absent or corrupt. */
function safeJson<T = any>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (_) {
    return null;
  }
}

async function appendChatLog(
  env: Env,
  log: { timestamp: string; userId: string; displayName: string; sender: string; text: string; type: string }
): Promise<void> {
  try {
    const stored = await state(env).appendChatLog(log);
    if (!stored) {
      const raw = await state(env).get('CHAT_LOGS');
      const logs = raw ? JSON.parse(raw) : [];
      logs.push(log);
      const trimmed = logs.slice(-100);
      await state(env).put('CHAT_LOGS', JSON.stringify(trimmed));
    }
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

      // ── High-Speed Interactive Execution (< 50ms) ──
      if (events.length > 0) {
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
                // Deduplicate redelivered webhook events if LINE provides webhookEventId
                if (event.webhookEventId) {
                  const seen = await state(env).get(`SEEN_EVENT_${event.webhookEventId}`);
                  if (seen) {
                    console.log(`[Worker] Duplicate webhookEventId ${event.webhookEventId} dropped.`);
                    return;
                  }
                  if (ctx) {
                    ctx.waitUntil(state(env).put(`SEEN_EVENT_${event.webhookEventId}`, '1', { expirationTtl: 600 }).catch(() => {}));
                  } else {
                    state(env).put(`SEEN_EVENT_${event.webhookEventId}`, '1', { expirationTtl: 600 }).catch(() => {});
                  }
                }
                await processLineEvent(event, env, ctx);
              }
            } catch (err: any) {
              console.error('[Worker] Event processing error:', err);
              try {
                await state(env).put('LAST_WEBHOOK_ERROR', JSON.stringify({
                  error: err?.message || String(err),
                  stack: err?.stack,
                  event,
                  time: new Date().toISOString()
                }));
              } catch (_) {}
            }
          })
        );

        // Immediate HTTP 200 OK (< 15ms) to satisfy LINE Webhook 1-second timeout SLA.
        // ctx.waitUntil keeps background isolate alive to finish all processing, KV updates & LINE messages.
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(interactiveProcessing);
        } else {
          await interactiveProcessing;
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

        // ── Admin authentication ──
        // The browser authenticates with a short-lived signed session token
        // (x-admin-session). The raw ADMIN_API_KEY is accepted ONLY from
        // server-to-server callers (the GAS mirror, scripts) and is never
        // issued to the frontend — previously it was embedded in the bundle by
        // Vite, which published the admin credential to every visitor.
        const superAdminKeys = [env.ADMIN_API_KEY].filter(Boolean);
        const admin1Keys = [env.ADMIN1_API_KEY].filter(Boolean);
        const validAdminKeys = [...superAdminKeys, ...admin1Keys];

        const sessionHeader = request.headers.get('x-admin-session') || body?.adminSession;
        let sessionClaims: SessionClaims | null = null;
        if (sessionHeader && env.SESSION_SECRET) {
          sessionClaims = await verifySessionToken(sessionHeader, env.SESSION_SECRET);
        }

        const apiKeyHeader: string | null | undefined =
          request.headers.get('x-admin-key') ||
          request.headers.get('x-admin-api-key') ||
          body?.adminKey ||
          body?.apiKey;
        // Timing-safe comparison so a wrong key cannot be discovered by timing.
        const isAdminKeyAuth = Boolean(
          apiKeyHeader && validAdminKeys.some((k) => timingSafeEqual(k, apiKeyHeader))
        );
        const isSuperAdminKeyAuth = Boolean(
          apiKeyHeader && superAdminKeys.some((k) => timingSafeEqual(k, apiKeyHeader))
        );

        const isAdmin = Boolean(sessionClaims || isAdminKeyAuth);
        const adminRole: AdminRole = sessionClaims
          ? sessionClaims.role
          : isSuperAdminKeyAuth
            ? 'superadmin'
            : 'admin';

        // `adminResetPasswordWithRecoveryCode` is deliberately unauthenticated: it IS
        // the forgotten-password path. It is safe because a single-use recovery
        // code must be presented, it is rate-limited, and every failed attempt
        // burns the presented code.
        // Caller IP for rate limiting. Read once per request so login and password
        // reset throttling share one key space per client.
        const cfClientIp =
          request.headers.get('cf-connecting-ip') ||
          request.headers.get('x-forwarded-for') ||
          'unknown';

        // Endpoints a password-change (restricted) session may reach. Without this a
        // session issued after expiry could still perform admin actions, which
        // defeats the point of blocking.
const PASSWORD_SCOPE_ALLOWED = new Set([
  'adminChangePassword',
  'adminGetPasswordStatus',
  'adminRegenerateRecoveryCodes',
  'adminResetPasswordWithRecoveryCode',
]);

// A restricted session must not be usable for anything else.
if (
  sessionClaims &&
  sessionClaims.scope === 'reset' &&
  !PASSWORD_SCOPE_ALLOWED.has(functionName)
) {
  return new Response(
    JSON.stringify({
      error: 'PasswordChangeRequired: ต้องเปลี่ยนรหัสผ่านก่อนจึงจะใช้งานระบบได้',
      requiresPasswordChange: true,
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }
  );
}

const isPublicAllowed =
          functionName === 'getDashboardData' ||
          functionName === 'adminLogin' ||
          functionName === 'getP2PResults' ||
          functionName === 'adminResetPasswordWithRecoveryCode';
        if (!isPublicAllowed && !isAdmin) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        let result: any = null;

        if (functionName === 'getDashboardData') {
          // One batched RPC for the scalar keys (instead of five separate round-trips),
          // with the list-shaped aggregates fetched in parallel alongside it.
          const [scalars, pendingBets, matchedBets, players, transactions] = await Promise.all([
            state(env).multi([
              'ACTIVE_ROUND',
              'ACTIVE_GROUP_ID',
              'LINE_GROUPS',
              'CHAT_LOGS',
              'CACHED_LINE_QUOTA',
            ]),
            getPendingOrdersList(env),
            getMatchedOrdersList(env),
            getPlayersList(env),
            getTransactionsList(env),
          ]);
          const [roundStr, activeGroupId, lineGroupsRaw, chatLogsRaw, cachedQuotaRaw] = scalars;

          const allOrders = [...pendingBets, ...matchedBets];
          const formattedBets = allOrders.map(formatOrderForDashboard);

          let parsedGroups = lineGroupsRaw ? JSON.parse(lineGroupsRaw) : [];
          if (!Array.isArray(parsedGroups)) parsedGroups = [];
          const validGroups = parsedGroups.filter((g: any) => g && g.id && /^[CR][0-9a-f]{32}$/i.test(String(g.id).trim()));
          const validActiveGroupId = (activeGroupId && /^[CR][0-9a-f]{32}$/i.test(activeGroupId.trim())) ? activeGroupId.trim() : 'C61efb2aa1ad6fc26fefdc41fb710b431';
          const lineGroups = validGroups.length > 0
            ? validGroups
            : [{ id: validActiveGroupId, name: '.Test', lastMessage: 'เชื่อมต่อแล้ว', timestamp: 'Live' }];
          const chatLogs = chatLogsRaw ? JSON.parse(chatLogsRaw) : [];

          // High-speed non-blocking quota resolution: serve immediately from cache (< 1ms)
          let lineQuota: any = null;
          if (cachedQuotaRaw) {
            try {
              lineQuota = JSON.parse(cachedQuotaRaw);
            } catch (_) {}
          }

          // If quota not in cache or older than 60s, refresh in background without blocking dashboard RPC
          const quotaAge = lineQuota?.cachedAt ? (Date.now() - lineQuota.cachedAt) : Infinity;
          if (!lineQuota || quotaAge > 60000) {
            const token = env.LINE_CHANNEL_ACCESS_TOKEN;
            if (token) {
              const refreshQuotaPromise = (async () => {
                try {
                  const [qRes, cRes] = await Promise.all([
                    fetch('https://api.line.me/v2/bot/message/quota', { headers: { Authorization: `Bearer ${token}` } }),
                    fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: { Authorization: `Bearer ${token}` } }),
                  ]);
                  if (qRes.ok && cRes.ok) {
                    const qJson: any = await qRes.json();
                    const cJson: any = await cRes.json();
                    const totalLimit = qJson.value || 0;
                    const used = cJson.totalUsage || 0;
                    const freshQuota = {
                      type: qJson.type || 'limited',
                      limit: totalLimit,
                      totalUsage: used,
                      remaining: Math.max(0, totalLimit - used),
                      isExhausted: totalLimit > 0 && used >= totalLimit,
                      cachedAt: Date.now(),
                    };
                    await state(env).put('CACHED_LINE_QUOTA', JSON.stringify(freshQuota), { expirationTtl: 300 });
                  }
                } catch (_) {}
              })();
              if (ctx) {
                ctx.waitUntil(refreshQuotaPromise);
              } else {
                refreshQuotaPromise.catch(() => {});
              }
            }
          }

          if (isAdmin) {
            result = {
              players,
              transactions,
              bets: formattedBets,
              chatLogs,
              activeGroupId: validActiveGroupId,
              lineGroups,
              activeRound: roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380, status: 'ACTIVE' },
              roundStatus: roundStr ? (JSON.parse(roundStr).status || 'ACTIVE') : 'ACTIVE',
              serverTime: new Date().toISOString(),
              lineQuota,
            };
          } else {
            const requestedUserId = args[0] ? String(args[0]).trim() : null;
            if (requestedUserId) {
              const matchedPlayer = players.find((p: any) => p.id === requestedUserId || p.lineUserId === requestedUserId);
              const userTransactions = transactions.filter((t: any) => t.playerId === requestedUserId);
              const formattedBets = pendingBets.map(formatOrderForDashboard);
              const userBets = formattedBets.filter((b: any) =>
                b.playerLowId === requestedUserId ||
                b.playerHighId === requestedUserId ||
                b.creatorId === requestedUserId ||
                b.creatorLineUserId === requestedUserId ||
                b.matcherId === requestedUserId ||
                b.matcherLineUserId === requestedUserId
              );
              const userChatLogs = chatLogs.filter((l: any) => l.userId === requestedUserId);
              result = {
                players: matchedPlayer ? [matchedPlayer] : [],
                transactions: userTransactions,
                bets: userBets,
                chatLogs: userChatLogs,
                activeGroupId: validActiveGroupId,
                lineGroups: [],
                activeRound: roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380, status: 'ACTIVE' },
                roundStatus: roundStr ? (JSON.parse(roundStr).status || 'ACTIVE') : 'ACTIVE',
                serverTime: new Date().toISOString(),
              };
            } else {
              result = {
                players: [],
                transactions: [],
                bets: pendingBets.filter((b: any) => b.status === 'pending_match').map((b: any) => {
                  const f = formatOrderForDashboard(b);
                  return {
                    id: f.id,
                    orderNumber: f.orderNumber,
                    side: f.side,
                    playerLowName: f.playerLowName,
                    playerHighName: f.playerHighName,
                    amount: f.amount,
                    type: f.type,
                    betType: f.betType,
                    rangeMin: f.rangeMin,
                    rangeMax: f.rangeMax,
                    status: f.status,
                    createdAt: f.createdAt,
                    timestamp: f.timestamp,
                  };
                }),
                chatLogs: [],
                activeGroupId: validActiveGroupId,
                lineGroups: [],
                activeRound: roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380, status: 'ACTIVE' },
                roundStatus: roundStr ? (JSON.parse(roundStr).status || 'ACTIVE') : 'ACTIVE',
                serverTime: new Date().toISOString(),
              };
            }
          }
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
          // Password authentication happens here and ONLY here. The response
          // carries a signed, expiring session token — never the API key, which
          // would reintroduce the bundle-embedded credential exposure.
          const username = (args[0] || '').toString().trim().toLowerCase();
          const password = (args[1] || '').toString().trim();

          const clientIp = cfClientIp;
          const rateKey = `login:${clientIp}`;

          const limit = await state(env).rateLimit(rateKey);
          if (!limit.allowed) {
            return new Response(
              JSON.stringify({
                success: false,
                error: `ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ ${Math.ceil(limit.retryAfterSeconds / 60)} นาทีแล้วลองใหม่`,
              }),
              {
                status: 429,
                headers: {
                  'Content-Type': 'application/json',
                  'Retry-After': String(limit.retryAfterSeconds),
                  ...corsHeaders,
                },
              }
            );
          }

          // Dedicated login passwords take precedence over the API key, so an
          // operator can change the console password without touching the
          // server-to-server secret.
          const superPass = env.ADMIN_PASSWORD || env.ADMIN_API_KEY;
          const superUsername = (env.ADMIN_USERNAME || 'admin').toLowerCase();
          const admin1Pass = env.ADMIN_PASSWORD_1 || env.ADMIN1_API_KEY;
          const admin1Username = (env.ADMIN1_USERNAME || 'admin1').toLowerCase();

          // The credential store is authoritative once a credential exists.
          // Expiry and "must change" are enforced HERE, so a stale password
          // cannot mint a session and reach any admin action.
          const outcome = await verifyAdminLogin(state(env), username, password);

          let authenticated: { username: string; role: AdminRole } | null = null;
          // Set when a restricted (password-change) session was issued above,
          // so the normal full-session path below is skipped.
          let alreadyResponded = false;

          if (outcome.status === 'ok') {
            authenticated = { username: outcome.username, role: outcome.role };
          } else if (outcome.status === 'expired' || outcome.status === 'must_change') {
            // Password is CORRECT but out of policy. A restricted session is
            // still issued so the operator can reach the change-password
            // screen; every other admin action is refused server-side.
            await state(env).clearRateLimit(rateKey);
            if (!env.SESSION_SECRET) {
              result = { success: false, error: 'Server misconfiguration: SESSION_SECRET is not configured' };
            } else {
              const resetStatus = await getCredentialStatus(state(env), username);
              result = {
                success: true,
                requiresPasswordChange: true,
                passwordExpired: outcome.status === 'expired',
                daysOverdue: outcome.status === 'expired' ? outcome.daysOverdue : 0,
                scope: 'reset',
                session: await issueSessionToken(
                  resetStatus.username || username,
                  resetStatus.role || 'admin',
                  env.SESSION_SECRET,
                  60 * 60,
                  'reset'
                ),
                username: resetStatus.username || username,
                role: resetStatus.role || 'admin',
                status: resetStatus,
                message:
                  outcome.status === 'expired'
                    ? `รหัสผ่านหมดอายุแล้ว (เกิน ${PASSWORD_MAX_AGE_DAYS} วัน) กรุณาตั้งรหัสผ่านใหม่ก่อนเข้าใช้งาน`
                    : 'กรุณาตั้งรหัสผ่านใหม่ก่อนเข้าใช้งาน',
              };
              alreadyResponded = true;
            }
          } else {
            // No stored credential yet: first login with the Wrangler secret
            // password. Hash it into the store so the plaintext secret can be
            // dropped from the deployment afterwards.
            if (superPass && username === superUsername && timingSafeEqual(password, superPass)) {
              const bootstrap = await setAdminPassword(state(env), 'Admin', 'superadmin', password, {
                mustChange: true,
                mustChangeReason: 'initial',
              });
              authenticated = { username: 'Admin', role: 'superadmin' };
              // First-run codes are shown once in the login response so the
              // operator can store them immediately. The session is
              // password-change scoped, matching mustChange.
              result = {
                success: true,
                bootstrapRecoveryCodes: bootstrap.recoveryCodes,
                requiresPasswordChange: true,
                scope: 'reset',
                status: await getCredentialStatus(state(env), 'Admin'),
                session: env.SESSION_SECRET
                  ? await issueSessionToken('Admin', 'superadmin', env.SESSION_SECRET, 60 * 60, 'reset')
                  : undefined,
                message: 'ครั้งแรก: กรุณาตั้งรหัสผ่านใหม่และบันทึก Recovery Codes',
              };
              alreadyResponded = true;
            } else if (admin1Pass && username === admin1Username && timingSafeEqual(password, admin1Pass)) {
              const bootstrap = await setAdminPassword(state(env), 'Admin1', 'admin', password, {
                mustChange: true,
                mustChangeReason: 'initial',
              });
              authenticated = { username: 'Admin1', role: 'admin' };
              result = {
                success: true,
                bootstrapRecoveryCodes: bootstrap.recoveryCodes,
                requiresPasswordChange: true,
                scope: 'reset',
                status: await getCredentialStatus(state(env), 'Admin1'),
                session: env.SESSION_SECRET
                  ? await issueSessionToken('Admin1', 'admin', env.SESSION_SECRET, 60 * 60, 'reset')
                  : undefined,
                message: 'ครั้งแรก: กรุณาตั้งรหัสผ่านใหม่และบันทึก Recovery Codes',
              };
              alreadyResponded = true;
            }
          }

          if (alreadyResponded) {
            // Restricted session already prepared above.
          } else if (!authenticated) {
            result = { success: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
          } else if (!env.SESSION_SECRET) {
            result = {
              success: false,
              error: 'Server misconfiguration: SESSION_SECRET is not configured',
            };
          } else {
            await state(env).clearRateLimit(rateKey);
            const status = await getCredentialStatus(state(env), authenticated.username);
            const combined = { ...(result && typeof result === 'object' ? result : {}), status };
            result = {
              ...combined,
              success: true,
              session: await issueSessionToken(authenticated.username, authenticated.role, env.SESSION_SECRET),
              username: authenticated.username,
              role: authenticated.role,
              expiresIn: 8 * 60 * 60,
            };
          }
        } else if (functionName === 'adminGetPasswordStatus') {
          const target = sessionClaims?.sub || args[0];
          if (!target) {
            result = { success: false, error: 'ไม่พบข้อมูลผู้ใช้' };
          } else {
            result = { success: true, status: await getCredentialStatus(state(env), String(target)) };
          }
        } else if (functionName === 'adminChangePassword') {
          // Self-service. Requires the session identity AND the current
          // password, so a stolen session alone cannot lock out the owner.
          if (!sessionClaims) {
            result = { success: false, error: 'กรุณาเข้าสู่ระบบก่อนเปลี่ยนรหัสผ่าน' };
          } else {
            const currentPassword = String(args[0] || '');
            const newPassword = String(args[1] || '');
            try {
              const changed = await changeAdminPassword(
                state(env),
                sessionClaims.sub,
                currentPassword,
                newPassword
              );
              // Re-issue the session: existing tokens stay valid but the
              // caller gets a fresh one for continuity.
              result = {
                success: true,
                recoveryCodes: changed.recoveryCodes,
                daysUntilExpiry: changed.daysUntilExpiry,
                maxAgeDays: PASSWORD_MAX_AGE_DAYS,
              };
            } catch (err) {
              result = { success: false, error: (err as Error)?.message || 'เปลี่ยนรหัสผ่านไม่สำเร็จ' };
            }
          }
        } else if (functionName === 'adminResetPasswordWithRecoveryCode') {
          // Unauthenticated by design — this is the forgotten-password path.
          // Guarded by: single-use code + strict rate limiting + code burn.
          const resetRateKey = `reset:${cfClientIp}`;
          const resetLimit = await state(env).rateLimit(resetRateKey);
          if (!resetLimit.allowed) {
            return new Response(
              JSON.stringify({
                success: false,
                error: `ลองรีเซ็ตหลายครั้งเกินไป กรุณารอ ${Math.ceil(resetLimit.retryAfterSeconds / 60)} นาทีแล้วลองใหม่`,
              }),
              {
                status: 429,
                headers: {
                  'Content-Type': 'application/json',
                  'Retry-After': String(resetLimit.retryAfterSeconds),
                  ...corsHeaders,
                },
              }
            );
          }
          try {
            const reset = await resetAdminPasswordWithRecoveryCode(
              state(env),
              String(args[0] || ''),
              String(args[1] || ''),
              String(args[2] || '')
            );
            await state(env).clearRateLimit(resetRateKey);
            result = {
              success: true,
              username: reset.username,
              role: reset.role,
              recoveryCodes: reset.recoveryCodes,
              daysUntilExpiry: reset.daysUntilExpiry,
              maxAgeDays: PASSWORD_MAX_AGE_DAYS,
            };
          } catch (err) {
            result = { success: false, error: (err as Error)?.message || 'รีเซ็ตรหัสผ่านไม่สำเร็จ' };
          }
        } else if (functionName === 'adminRegenerateRecoveryCodes') {
          // Codes are shown exactly once, so a lost set needs regenerating
          // without forcing a full password change. Requires the current
          // password so a stolen session cannot destroy the owner's codes.
          if (!sessionClaims) {
            result = { success: false, error: 'กรุณาเข้าสู่ระบบก่อนสร้าง Recovery Codes ใหม่' };
          } else {
            try {
              const regen = await regenerateRecoveryCodes(
                state(env),
                sessionClaims.sub,
                String(args[0] || '')
              );
              result = {
                success: true,
                recoveryCodes: regen.recoveryCodes,
                invalidated: regen.invalidated,
              };
            } catch (err) {
              result = { success: false, error: (err as Error)?.message || 'สร้าง Recovery Codes ใหม่ไม่สำเร็จ' };
            }
          }
        } else if (functionName === 'adminValidatePassword') {
          // Client-side-strength pre-check so the UI can guide without a
          // round-trip. The server re-validates regardless.
          result = validatePasswordStrength(String(args[0] || ''));
        } else if (functionName === 'adminApproveTransaction') {
          const txId = args[0];
          const txs = await getTransactionsList(env);
          const targetTx = txs.find(t => t.id === txId);
          if (targetTx) {
            if (targetTx.status === 'success' || targetTx.status === 'rejected') {
              result = { success: false, error: 'รายการนี้ได้รับการดำเนินการไปแล้ว', txId };
            } else {
              targetTx.status = 'success';
              targetTx.actualAmount = targetTx.requestedAmount;
              // Atomic status flip so a concurrent LINE OA deposit is preserved.
              const approvedAtomic = await state(env).patchTransactionStatus(
                txId, 'success', '', targetTx.requestedAmount
              );
              if (!approvedAtomic) {
                await state(env).put('TRANSACTIONS_LIST', JSON.stringify(txs));
              }

              const isWithdrawal = String(txId).startsWith('WD') || targetTx.type === 'withdraw';
              const playerId = targetTx.playerId;
              const txLine = targetTx.lineUserId;

              // 1. Authoritative resolution of LINE user ID and Short ID
              const rawLine = (txLine && txLine.startsWith('U'))
                ? txLine
                : (playerId && playerId.startsWith('U'))
                  ? playerId
                  : ((await state(env).get(`RAW_LINE_${playerId}`)) || '');
              const shortId = (playerId && playerId.startsWith('PL'))
                ? playerId
                : (rawLine ? `PL${rawLine.slice(-6).toUpperCase()}` : playerId);

              // 2. Fetch authoritative profile directly from entity keys (Single Source of Truth)
              let existingProfile: PlayerProfile | null = null;
              if (rawLine) {
                const raw = await state(env).get(`USER_${rawLine}`);
                if (raw) {
                  try { existingProfile = JSON.parse(raw); } catch (_) {}
                }
              }
              if (!existingProfile && shortId) {
                const raw = await state(env).get(`USER_${shortId}`);
                if (raw) {
                  try { existingProfile = JSON.parse(raw); } catch (_) {}
                }
              }
              if (!existingProfile) {
                const players = await getPlayersList(env);
                const p = players.find(x => x.id === playerId || x.shortId === shortId || (rawLine && x.lineUserId === rawLine));
                if (p) {
                  existingProfile = {
                    shortId: p.shortId || shortId,
                    lineUserId: p.lineUserId || rawLine,
                    displayName: p.displayName || p.name || targetTx.playerName || 'ผู้เล่น',
                    balance: Number(p.balance) || 0,
                    bankName: p.bankName || '',
                    accountNumber: p.bankAccount || p.accountNumber || '',
                    accountName: p.accountName || p.displayName || '',
                    registeredAt: Date.now(),
                    updatedAt: Date.now(),
                  };
                }
              }

              if (!existingProfile) {
                existingProfile = {
                  shortId,
                  lineUserId: rawLine,
                  displayName: targetTx.playerName || 'ผู้เล่น',
                  balance: 0,
                  registeredAt: Date.now(),
                  updatedAt: Date.now(),
                };
              }

              const effectiveLine = rawLine || existingProfile.lineUserId;
              const effectiveShort = shortId || existingProfile.shortId;

              if (isWithdrawal) {
                // Withdrawal: balance was already deducted upon request. Notify player of success.
                if (effectiveLine && effectiveLine.startsWith('U')) {
                  ctx?.waitUntil(pushToLine(effectiveLine, `💸 [ถอนเงินสำเร็จ]: ยอด ${targetTx.requestedAmount.toLocaleString()} บาท แอดมินได้โอนเข้าบัญชีของคุณเรียบร้อยแล้วครับ 🚀`, env).catch(e => console.error(e)));
                }
              } else {
                // Deposit: credit player balance directly on authoritative entity keys
                const oldBal = Number(existingProfile.balance) || 0;
                const newBal = oldBal + (Number(targetTx.requestedAmount) || 0);
                const updatedProfile: PlayerProfile = {
                  ...existingProfile,
                  shortId: effectiveShort,
                  lineUserId: effectiveLine,
                  displayName: targetTx.playerName || existingProfile.displayName || 'ผู้เล่น',
                  balance: newBal,
                  updatedAt: Date.now(),
                };

                const profileJson = JSON.stringify(updatedProfile);
                // Atomic fan-out so no reader can see a partially-credited profile.
                const entries: Array<[string, string]> = [[`USER_${effectiveShort}`, profileJson]];
                if (effectiveLine && effectiveLine.startsWith('U')) {
                  entries.push([`USER_${effectiveLine}`, profileJson]);
                  entries.push([`RAW_LINE_${effectiveShort}`, effectiveLine]);
                }
                const profileWritten = await state(env).writeMany(entries);
                if (!profileWritten) {
                  await Promise.all(entries.map(([k, v]) => state(env).put(k, v)));
                }
                await savePlayerProfile(updatedProfile, env, ctx);

                // Push notice to player
                if (effectiveLine && effectiveLine.startsWith('U')) {
                  ctx?.waitUntil(pushToLine(effectiveLine, `✅ อนุมัติยอดเงินฝาก ${targetTx.requestedAmount.toLocaleString()} บาท เรียบร้อยแล้วครับ!\nแต้มคงเหลือปัจจุบัน: ${newBal.toLocaleString()} pt 🚀`, env).catch(e => console.error(e)));
                }
              }

              result = { success: true, txId };
            }
          } else {
            result = { success: false, error: 'Transaction not found', txId };
          }
        } else if (functionName === 'adminRejectTransaction') {
          const txId = args[0];
          const reason = args[1] || 'ไม่พบยอดเงินเข้าบัญชี';
          const txs = await getTransactionsList(env);
          const targetTx = txs.find(t => t.id === txId);
          if (targetTx) {
            if (targetTx.status === 'success' || targetTx.status === 'rejected') {
              result = { success: false, error: 'รายการนี้ได้รับการดำเนินการไปแล้ว', txId };
            } else {
              targetTx.status = 'rejected';
              targetTx.reviewReason = reason;
              // Atomic status flip so a concurrent LINE OA deposit is preserved.
              const rejectedAtomic = await state(env).patchTransactionStatus(txId, 'rejected', reason);
              if (!rejectedAtomic) {
                await state(env).put('TRANSACTIONS_LIST', JSON.stringify(txs));
              }

              const isWithdrawal = String(txId).startsWith('WD') || targetTx.type === 'withdraw';
              const playerId = targetTx.playerId;
              const txLine = targetTx.lineUserId;

              // 1. Authoritative resolution of LINE user ID and Short ID
              const rawLine = (txLine && txLine.startsWith('U'))
                ? txLine
                : (playerId && playerId.startsWith('U'))
                  ? playerId
                  : ((await state(env).get(`RAW_LINE_${playerId}`)) || '');
              const shortId = (playerId && playerId.startsWith('PL'))
                ? playerId
                : (rawLine ? `PL${rawLine.slice(-6).toUpperCase()}` : playerId);

              let existingProfile: PlayerProfile | null = null;
              if (rawLine) {
                const raw = await state(env).get(`USER_${rawLine}`);
                if (raw) {
                  try { existingProfile = JSON.parse(raw); } catch (_) {}
                }
              }
              if (!existingProfile && shortId) {
                const raw = await state(env).get(`USER_${shortId}`);
                if (raw) {
                  try { existingProfile = JSON.parse(raw); } catch (_) {}
                }
              }
              if (!existingProfile) {
                const players = await getPlayersList(env);
                const p = players.find(x => x.id === playerId || x.shortId === shortId || (rawLine && x.lineUserId === rawLine));
                if (p) {
                  existingProfile = {
                    shortId: p.shortId || shortId,
                    lineUserId: p.lineUserId || rawLine,
                    displayName: p.displayName || p.name || targetTx.playerName || 'ผู้เล่น',
                    balance: Number(p.balance) || 0,
                    bankName: p.bankName || '',
                    accountNumber: p.bankAccount || p.accountNumber || '',
                    accountName: p.accountName || p.displayName || '',
                    registeredAt: Date.now(),
                    updatedAt: Date.now(),
                  };
                }
              }

              if (existingProfile) {
                const effectiveLine = rawLine || existingProfile.lineUserId;
                const effectiveShort = shortId || existingProfile.shortId;

                if (isWithdrawal) {
                  // Refund locked withdrawal points back to player profile across authoritative keys
                  const oldBal = Number(existingProfile.balance) || 0;
                  const newBal = oldBal + (Number(targetTx.requestedAmount) || 0);
                  const updatedProfile: PlayerProfile = {
                    ...existingProfile,
                    shortId: effectiveShort,
                    lineUserId: effectiveLine,
                    balance: newBal,
                    updatedAt: Date.now(),
                  };

                  const profileJson = JSON.stringify(updatedProfile);
                  const entries: Array<[string, string]> = [[`USER_${effectiveShort}`, profileJson]];
                  if (effectiveLine && effectiveLine.startsWith('U')) {
                    entries.push([`USER_${effectiveLine}`, profileJson]);
                    entries.push([`RAW_LINE_${effectiveShort}`, effectiveLine]);
                  }
                  const profileWritten = await state(env).writeMany(entries);
                  if (!profileWritten) {
                    await Promise.all(entries.map(([k, v]) => state(env).put(k, v)));
                  }
                  await savePlayerProfile(updatedProfile, env, ctx);

                  if (effectiveLine && effectiveLine.startsWith('U')) {
                    ctx?.waitUntil(pushToLine(effectiveLine, `❌ [ปฏิเสธการถอนเงิน]: ยอด ${targetTx.requestedAmount.toLocaleString()} pt (สาเหตุ: ${reason})\nระบบได้คืนแต้มเข้ากระเป๋าเรียบร้อย แต้มคงเหลือ: ${newBal.toLocaleString()} pt 🚀`, env).catch(e => console.error(e)));
                  }
                } else {
                  if (effectiveLine && effectiveLine.startsWith('U')) {
                    ctx?.waitUntil(pushToLine(effectiveLine, `❌ [ปฏิเสธการฝากเงิน]: ยอด ${targetTx.requestedAmount.toLocaleString()} บาท (สาเหตุ: ${reason})`, env).catch(e => console.error(e)));
                  }
                }
              }

              result = { success: true, txId };
            }
          } else {
            result = { success: false, error: 'Transaction not found', txId };
          }
        } else if (functionName === 'adminRequestCancelBet') {
          const rawId = args[0] ? String(args[0]).trim() : '';
          const orderNo = rawId.replace(/^bet_/, '');
          const rawOrder = await env.KV_ORDERS.get(`ORDER_${orderNo}`);
          if (rawOrder) {
            const order = JSON.parse(rawOrder) as Order;
            if (order.status === 'cancelled' || order.status === 'resolved') {
              result = { success: false, error: `แผล Order #${orderNo} อยู่ในสถานะ ${order.status} แล้ว` };
            } else {
              order.status = 'refunding';
              await env.KV_ORDERS.put(`ORDER_${orderNo}`, JSON.stringify(order));

              // Refund creator
              if (order.creatorId && Number(order.amount) > 0) {
                await refundPlayerPoints(order.creatorId, order.creatorLineUserId || undefined, Number(order.amount), env, ctx);
              }
              // Refund matcher if matched
              if (order.matcherId && Number(order.amount) > 0) {
                await refundPlayerPoints(order.matcherId, order.matcherLineUserId || undefined, Number(order.amount), env, ctx);
              }

              order.status = 'cancelled';
              await Promise.all([
                env.KV_ORDERS.put(`ORDER_${orderNo}`, JSON.stringify(order)),
                removeFromPendingOrdersList(orderNo, env),
                removeFromMatchedOrdersList(orderNo, env),
              ]);

              result = { success: true, orderNumber: orderNo };
            }
          } else {
            result = { success: false, error: `ไม่พบข้อมูลแผล Order #${orderNo}` };
          }
        } else if (functionName === 'adminSetPlayerBalance') {
          const userId = args[0];
          const newBal = Number(args[1]) || 0;
          const passedName = args[2] ? String(args[2]).trim() : '';

          const players = await getPlayersList(env);
          const player = players.find(p => p.id === userId || p.lineUserId === userId || (p.shortId && p.shortId === userId));
          const targetLineUserId = player?.lineUserId || (await state(env).get(`RAW_LINE_${userId}`)) || (userId.startsWith('U') ? userId : '');
          const shortId = player?.shortId || (userId.startsWith('PL') ? userId : `PL${(targetLineUserId || userId).slice(-6).toUpperCase()}`);
          const displayName = player?.name || player?.displayName || passedName || 'ผู้เล่น';
          let oldBal = player ? (Number(player.balance) || 0) : 0;

          // Check if direct profile exists under targetLineUserId or shortId
          let existingProfile: PlayerProfile | null = null;
          if (targetLineUserId) {
            const raw = await state(env).get(`USER_${targetLineUserId}`);
            if (raw) {
              try { existingProfile = JSON.parse(raw); } catch (_) {}
            }
          }
          if (!existingProfile && shortId) {
            const raw = await state(env).get(`USER_${shortId}`);
            if (raw) {
              try { existingProfile = JSON.parse(raw); } catch (_) {}
            }
          }
          if (existingProfile && existingProfile.balance !== undefined) {
            oldBal = Number(existingProfile.balance) || 0;
          }

          const updatedProfile: PlayerProfile = {
            ...(existingProfile || {}),
            shortId,
            lineUserId: targetLineUserId || existingProfile?.lineUserId || shortId,
            displayName: passedName || existingProfile?.displayName || displayName,
            balance: newBal,
            bankName: existingProfile?.bankName || player?.bankName || '',
            accountNumber: existingProfile?.accountNumber || player?.bankAccount || player?.accountNumber || '',
            accountName: existingProfile?.accountName || player?.accountName || displayName,
            registeredAt: existingProfile?.registeredAt || player?.registeredAt || Date.now(),
            updatedAt: Date.now(),
          };

          // Ledger-First: Record admin adjustment
          await addTransaction({
            id: `ADJ${Date.now().toString().slice(-6)}`,
            playerId: shortId,
            playerName: updatedProfile.displayName,
            requestedAmount: newBal - oldBal,
            actualAmount: newBal - oldBal,
            slipRef: 'ADMIN_ADJUST',
            status: 'success',
            reviewReason: `Admin set balance: ${oldBal} → ${newBal}`,
            timestamp: formatTime(),
            type: 'deposit',
            createdAt: Date.now(),
          }, env, ctx);

          // Save synchronously to both USER_${targetLineUserId} and USER_${shortId}
          if (targetLineUserId && targetLineUserId.startsWith('U')) {
            await state(env).put(`USER_${targetLineUserId}`, JSON.stringify(updatedProfile));
            await state(env).put(`RAW_LINE_${shortId}`, targetLineUserId);
          }
          await state(env).put(`USER_${shortId}`, JSON.stringify(updatedProfile));

          // Save to PLAYERS_LIST and Sheets
          await savePlayerProfile(updatedProfile, env, ctx);

          // Push DM to LINE user so they are immediately aware of their updated credit amount
          if (targetLineUserId && targetLineUserId.startsWith('U')) {
            try {
              const adjustFlex = generateCreditAdjustmentFlex(displayName, oldBal, newBal);
              const pushTask = Promise.all([
                pushToLine(targetLineUserId, adjustFlex, env).catch(e => console.error(e)),
                appendChatLog(env, {
                  timestamp: formatTime(),
                  userId: targetLineUserId,
                  displayName: 'แอดมิน',
                  sender: 'admin',
                  text: `💰 แจ้งเตือนปรับยอดเครดิต: ${oldBal.toLocaleString()} pt → ${newBal.toLocaleString()} pt`,
                  type: 'flex',
                }).catch(e => console.error(e))
              ]);
              if (typeof ctx?.waitUntil === 'function') {
                ctx.waitUntil(pushTask);
              }
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
          const rawLine = await state(env).get(`RAW_LINE_${userId}`) || userId;
          const profileRaw = await state(env).get(`USER_${rawLine}`);
          if (profileRaw) {
            const p = JSON.parse(profileRaw);
            p.displayName = newName;
            await savePlayerProfile(p, env, ctx);
          }
          result = { success: true };
        } else if (functionName === 'adminDeletePlayer') {
          // Accepts any identifier an admin is likely to hold: the Short ID
          // (PLxxxxxx), the LINE user ID (Uxxxxx), or a full storage key
          // ("USER_..." / "RAW_LINE_...").
          //
          // Previously this only deleted `USER_<rawLine>` plus, for PL ids,
          // `USER_<id>` — so passing a Short ID left `USER_<lineUserId>` and
          // `RAW_LINE_<shortId>` behind. getPlayersList() rebuilds the directory
          // by scanning USER_*, so the player silently reappeared in the Admin
          // Console right after being deleted. Every alias is now resolved and
          // removed together.
          const input = String(args[0] || '').trim();
          if (!input) {
            result = { success: false, error: 'กรุณาระบุรหัสผู้เล่นที่ต้องการลบ' };
          } else {
            const bare = input.replace(/^(?:USER_|RAW_LINE_)/, '').trim();

            // Gather every identifier this player is known by.
            const [byShortId, byLineId, rawLine] = await Promise.all([
              state(env).get(`RAW_LINE_${bare}`),
              state(env).get(`USER_${bare}`),
              state(env).get(`USER_${bare}`),
            ]);
            const lineUserId = byShortId || (byLineId ? safeJson<any>(byLineId)?.lineUserId : undefined) || '';
            const shortId = byLineId ? safeJson<any>(byLineId)?.shortId : undefined;

            const idsToDelete = new Set<string>();
            if (bare) idsToDelete.add(bare);
            if (lineUserId) idsToDelete.add(lineUserId);
            if (shortId) idsToDelete.add(shortId);

            const keysToDelete: string[] = [];
            for (const id of idsToDelete) {
              keysToDelete.push(`USER_${id}`);
              keysToDelete.push(`RAW_LINE_${id}`);
            }

            await Promise.all(keysToDelete.map((k) => state(env).delete(k)));

            // Drop the directory entry, matching on any known identifier.
            const listRaw = await state(env).get('PLAYERS_LIST');
            let removedFromList = 0;
            if (listRaw) {
              const list = JSON.parse(listRaw);
              const filtered = list.filter(
                (p: any) =>
                  p &&
                  !idsToDelete.has(p.shortId) &&
                  !idsToDelete.has(p.id) &&
                  !idsToDelete.has(p.lineUserId)
              );
              removedFromList = list.length - filtered.length;
              await state(env).put('PLAYERS_LIST', JSON.stringify(filtered));
            }

            result = {
              success: true,
              deletedIds: Array.from(idsToDelete),
              deletedKeys: keysToDelete,
              removedFromDirectory: removedFromList,
            };
          }
        } else if (functionName === 'adminSetActiveGroupId') {
          const gid = args[0];
          await state(env).put('ACTIVE_GROUP_ID', gid);
          result = { success: true, activeGroupId: gid };
        } else if (functionName === 'adminOpenRound') {
          const roundName = args[0] || 'บั้งไฟสด';
          await state(env).put('ACTIVE_ROUND', JSON.stringify({
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
          // Strict privilege check: Super Admin only
          const isSuperAdmin = adminRole === 'superadmin';
          if (!isSuperAdmin) {
            return new Response(JSON.stringify({ 
              error: 'Forbidden: สิทธิ์ไม่เพียงพอ เฉพาะ Super Admin เท่านั้นที่สามารถล้างระเบียนข้อมูลระบบ (Factory Reset) ได้' 
            }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          // 1. Clear atomic order state in KV
          await clearAllPendingOrders(env);
          // 2. Clear players, transactions, and logs in KV
          await state(env).delete('PLAYERS_LIST');
          await state(env).delete('TRANSACTIONS_LIST');
          await state(env).delete('CHAT_LOGS');
          // 3. Clear all cached player profiles and raw LINE mappings
          try {
            const userScan = await state(env).list({ prefix: 'USER_' });
            if (userScan.keys && userScan.keys.length > 0) {
              await Promise.all(userScan.keys.map((k) => state(env).delete(k.name)));
            }
            const rawScan = await state(env).list({ prefix: 'RAW_LINE_' });
            if (rawScan.keys && rawScan.keys.length > 0) {
              await Promise.all(rawScan.keys.map((k) => state(env).delete(k.name)));
            }
          } catch (_) {}

          // 4. Forward database reset to Google Apps Script / Google Sheets.
          //
          // GAS is a REPORTING MIRROR only — the Durable Object is the system
          // of record, so steps 1-3 above have already completed the reset.
          // A mirror failure must therefore never mask that success.
          //
          // Previously any GAS problem (missing ADMIN_API_KEY script property,
          // an unreachable or signed-in-only deployment) either threw or
          // silently replaced the response with the mirror's error, leaving
          // admins thinking the reset had failed when it had not.
          let sheetsResetResult: any = null;
          let sheetsWarning: string | null = null;
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

              // A GAS deployment that requires sign-in answers with a 302 to a
              // Google login page; treating that as success hid a real outage.
              const contentType = res.headers.get('content-type') || '';
              if (!contentType.includes('application/json')) {
                sheetsWarning = res.status === 302 || res.status === 301
                  ? 'Google Apps Script deployment requires sign-in (anonymous access is off). Re-deploy GAS with "Execute as: Me" and "Who has access: Anyone".'
                  : `Google Apps Script returned ${res.status} with a non-JSON body.`;
                console.warn('[Worker] GAS reset: unexpected response', res.status, contentType);
              } else {
                const json: any = await res.json();
                const payload = json?.data || json;
                if (payload && payload.success === false) {
                  // e.g. ADMIN_API_KEY Script Property is not configured.
                  sheetsWarning = `Google Sheets mirror not cleared: ${payload.error || 'unknown error'}`;
                  console.warn('[Worker] GAS reset rejected:', payload.error);
                } else {
                  sheetsResetResult = payload;
                }
              }
            } catch (err) {
              sheetsWarning = `Could not reach Google Apps Script mirror: ${(err as Error)?.message || err}`;
              console.warn('[Worker] GAS reset database error:', err);
            }
          } else {
            sheetsWarning = 'GAS_FALLBACK_URL is not configured.';
          }

          result = {
            success: true,
            scope: 'live-state',
            message: 'Live state (Durable Object + KV) cleared successfully.',
            sheetsMirrorCleared: sheetsResetResult !== null,
            ...(sheetsWarning ? { sheetsWarning } : {}),
            ...(sheetsResetResult ? { sheets: sheetsResetResult } : {}),
            players: [],
            transactions: [],
            bets: [],
            chatLogs: [],
            activeGroupId: (await state(env).get('ACTIVE_GROUP_ID')) || '',
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
            const rawMerged = [...kvPlayers];
            for (const sp of sheetsData.players) {
              rawMerged.push({
                id: sp.id || sp.shortId,
                shortId: sp.id || sp.shortId,
                lineUserId: sp.lineUserId || sp.id,
                name: sp.name || sp.displayName || 'ผู้เล่น',
                displayName: sp.name || sp.displayName || 'ผู้เล่น',
                balance: Number(sp.balance) || 0,
                bankName: sp.bankName || '',
                bankAccount: sp.bankAccount || sp.accountNumber || '',
                accountName: sp.accountName || sp.name || '',
              });
            }
            const merged = deduplicatePlayers(rawMerged);
            const avatars = ['🐉', '🐯', '🦅', '🦁', '🐻', '🐼', '🦊', '🦉'];
            result = {
              players: merged.map((p, idx) => ({
                id: p.shortId || p.id || p.lineUserId,
                shortId: p.shortId || p.id,
                name: p.displayName || p.name || 'ผู้เล่น',
                displayName: p.displayName || p.name || 'ผู้เล่น',
                balance: Number(p.balance) || 0,
                joinDate: p.registeredAt ? new Date(p.registeredAt).toLocaleDateString('th-TH') : '-',
                bankName: p.bankName || '',
                bankAccount: p.accountNumber || p.bankAccount || '',
                accountName: p.accountName || p.displayName || p.name || '',
                isUser: false,
                avatar: avatars[idx % avatars.length],
                lineUserId: p.lineUserId || '',
              })),
              transactions: Array.isArray(sheetsData.transactions) && sheetsData.transactions.length > 0
                ? [...kvTx, ...sheetsData.transactions].slice(0, 100)
                : kvTx,
              bets: kvBets.map(formatOrderForDashboard),
              activeGroupId: (await state(env).get('ACTIVE_GROUP_ID')) || '',
            };
          } else {
            result = {
              players: kvPlayers,
              transactions: kvTx,
              bets: kvBets.map(formatOrderForDashboard),
              activeGroupId: (await state(env).get('ACTIVE_GROUP_ID')) || '',
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
                const roundStr = await state(env).get('ACTIVE_ROUND');
                const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', status: 'ACTIVE' };
                round.targetMin = Number(rangeMatch[1]);
                round.targetMax = Number(rangeMatch[2]);
                round.updatedAt = Date.now();
                await state(env).put('ACTIVE_ROUND', JSON.stringify(round));
              }

              if (clean === 'กติกา' || clean === 'rule' || clean === 'rules' || clean === 'วิธีเล่น' || clean === 'คู่มือ') {
                payload = generateRuleGuideFlex();
              } else if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
                const primaryTarget = targets[0];
                const rawLine = (await state(env).get(`RAW_LINE_${primaryTarget}`)) || primaryTarget;
                const profileRaw = await state(env).get(`USER_${rawLine}`);
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
                const roundStr = await state(env).get('ACTIVE_ROUND');
                const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
                round.status = 'CLOSED';
                round.updatedAt = Date.now();
                await state(env).put('ACTIVE_ROUND', JSON.stringify(round));
              } else if (clean.startsWith('เปิดรอบ') || clean.startsWith('เปิดรับดวล')) {
                const roundStr = await state(env).get('ACTIVE_ROUND');
                const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
                round.status = 'ACTIVE';
                round.updatedAt = Date.now();
                await state(env).put('ACTIVE_ROUND', JSON.stringify(round));
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
          await state(env).put('ACTIVE_ROUND', JSON.stringify(roundData));

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
          const roundStr = await state(env).get('ACTIVE_ROUND');
          const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
          round.status = 'CLOSED';
          round.updatedAt = Date.now();
          await state(env).put('ACTIVE_ROUND', JSON.stringify(round));

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
          const roundStr = await state(env).get('ACTIVE_ROUND');
          const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
          round.status = 'VOID';
          round.updatedAt = Date.now();
          await state(env).put('ACTIVE_ROUND', JSON.stringify(round));

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
          const lastDelivery = await state(env).get('LAST_DELIVERY_DEBUG');
          const lastError = await state(env).get('LAST_LINE_ERROR');
          const lastSuccess = await state(env).get('LAST_LINE_SUCCESS');
          result = {
            success: true,
            simulatedText: text,
            lastDelivery: lastDelivery ? JSON.parse(lastDelivery) : null,
            lastError: lastError ? JSON.parse(lastError) : null,
            lastSuccess: lastSuccess ? JSON.parse(lastSuccess) : null,
          };
        } else if (functionName === 'adminDiscoverGroupIds') {
          const activeGroupId = await state(env).get('ACTIVE_GROUP_ID');
          const lineGroupsRaw = await state(env).get('LINE_GROUPS');
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
          const rawLine = (await state(env).get(`RAW_LINE_${userId}`)) || userId;
          const profileRaw = await state(env).get(`USER_${rawLine}`);
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
          const activeRoundStr = await state(env).get('ACTIVE_ROUND');
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
                  const winnerLineUserId = winnerLineId === order.creatorId ? order.creatorLineUserId : (order.matcherLineUserId || undefined);
                  await refundPlayerPoints(winnerLineId, winnerLineUserId, amt * 2, env, ctx);
                } else if (winnerSide === 'draw') {
                  if (order.creatorId) {
                    await refundPlayerPoints(order.creatorId, order.creatorLineUserId, amt, env, ctx);
                  }
                  if (order.matcherId) {
                    await refundPlayerPoints(order.matcherId, order.matcherLineUserId || undefined, amt, env, ctx);
                  }
                }
          }


          activeRound.status = 'CLOSED';
          activeRound.finalTime = finalSeconds;
          activeRound.updatedAt = Date.now();
          await state(env).put('ACTIVE_ROUND', JSON.stringify(activeRound));

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
          const activeGroupId = await state(env).get('ACTIVE_GROUP_ID');
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

          const activeGroupId = await state(env).get('ACTIVE_GROUP_ID');
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
        } else if (functionName === 'adminGetDebugLogs') {
          const [lastOrderDebug, lastLineError, lastLineSuccess, lastWebhookError, lastDelivery] = await Promise.all([
            state(env).get('LAST_ORDER_CREATE_DEBUG'),
            state(env).get('LAST_LINE_ERROR'),
            state(env).get('LAST_LINE_SUCCESS'),
            state(env).get('LAST_WEBHOOK_ERROR'),
            state(env).get('LAST_DELIVERY_DEBUG'),
          ]);
          result = {
            lastOrderDebug: lastOrderDebug ? JSON.parse(lastOrderDebug) : null,
            lastLineError: lastLineError ? JSON.parse(lastLineError) : null,
            lastLineSuccess: lastLineSuccess ? JSON.parse(lastLineSuccess) : null,
            lastWebhookError: lastWebhookError ? JSON.parse(lastWebhookError) : null,
            lastDelivery: lastDelivery ? JSON.parse(lastDelivery) : null,
          };
        } else if (functionName === 'adminStateStats') {
          // Operational introspection for the strongly-consistent state store.
          // Super Admin only, same as the destructive actions it sits beside.
          const isSuperAdmin = adminRole === 'superadmin';
          if (!isSuperAdmin) {
            result = { error: 'Forbidden: เฉพาะ Super Admin เท่านั้นที่สามารถดูสถานะระบบจัดเก็บข้อมูลได้' };
          } else {
            const stats = await state(env).stats();
            result = { stats, usingDurableObject: Boolean((env as any).ROCKET_STATE) };
          }
        } else if (functionName === 'adminResetTestData') {
          // 1. Clean pending bets list
          await state(env).put('PENDING_ORDERS_LIST', JSON.stringify([]));

          // 2. Fix player balance to 1900 and deduplicate PLAYERS_LIST
          const targetUserId = 'Ua34bcbb1d365c657cc1a7f3576c76e26';
          const targetShortId = 'PLC76E26';
          const cleanProfile = {
            shortId: targetShortId,
            lineUserId: targetUserId,
            displayName: 'ITT (อิท)',
            balance: 1900,
            bankName: 'GSB',
            accountNumber: '085739573623',
            accountName: 'เอกราช ลครศรี',
            registeredAt: 1790662664117,
            updatedAt: Date.now(),
          };
          await state(env).put(`USER_${targetUserId}`, JSON.stringify(cleanProfile));
          await state(env).put(`USER_${targetShortId}`, JSON.stringify(cleanProfile));
          await state(env).put(`RAW_LINE_${targetShortId}`, targetUserId);

          const listRaw = await state(env).get('PLAYERS_LIST');
          let list = listRaw ? JSON.parse(listRaw) : [];
          if (!Array.isArray(list)) list = [];
          const deduped = list.filter((p: any) => p.lineUserId !== targetUserId && p.shortId !== targetShortId && p.id !== targetShortId);
          deduped.push({
            id: targetShortId,
            name: cleanProfile.displayName,
            displayName: cleanProfile.displayName,
            shortId: targetShortId,
            lineUserId: targetUserId,
            balance: 1900,
            bankName: cleanProfile.bankName,
            accountNumber: cleanProfile.accountNumber,
            bankAccount: cleanProfile.accountNumber,
            accountName: cleanProfile.accountName,
            registeredAt: cleanProfile.registeredAt,
            updatedAt: cleanProfile.updatedAt,
          });
          await state(env).put('PLAYERS_LIST', JSON.stringify(deduped));
          result = { success: true, restoredBalance: 1900, pendingCleared: true };
        }

        // Conditional-request support for the dashboard poll.
        //
        // The Admin Console polls several times per second. The payload
        // includes `serverTime`, so every response differs byte-for-byte and a
        // naive client can never tell "nothing changed" from "something
        // changed" — it re-downloads and re-parses the full state each time.
        //
        // We hash the payload with serverTime factored out. When the client
        // sends back a matching If-None-Match we answer 304 with an empty
        // body, so an idle console costs almost no bandwidth and the client
        // skips its JSON parse entirely.
        const responseBody = JSON.stringify({ success: true, data: result });
        if (functionName === 'getDashboardData' && result) {
          const { serverTime: _ignored, ...stable } = result as any;
          const etag = `"${await hashPayload(stable)}"`;
          const ifNoneMatch = request.headers.get('if-none-match');
          if (ifNoneMatch === etag) {
            return new Response(null, { status: 304, headers: { ETag: etag, ...corsHeaders } });
          }
          return new Response(responseBody, {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
              ETag: etag,
              ...corsHeaders,
            },
          });
        }

        return new Response(responseBody, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            ...corsHeaders,
          },
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

// Re-export the Durable Object class so Wrangler registers it as a DO entrypoint.
// A single instance (`rocket-global-state`) owns every read/write of live business
// state, making LINE OA <-> Admin Console updates immediately visible worldwide
// instead of inheriting Workers KV's up-to-60s cross-region propagation delay.
export { RocketStateDO };
