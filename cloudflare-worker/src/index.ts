import { LINE_ICONS } from './lineIcons.js';
import { Env, LineWebhookPayload, QueueMessage, LineEvent, PlayerProfile, Order, InFlightRound } from './types.js';
import { verifyLineSignature } from './signature.js';
import { state } from './state.js';
import { getPaymentBank, setPaymentBank } from './paymentBank.js';
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
import {
  setDangerPin,
  verifyDangerPin,
  isPinConfigured,
  validatePinFormat,
} from './dangerPin.js';
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
  getOrCreatePlayerProfile,
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
  ledger,
  getOrderRecord,
  mirrorTransactionToSheets,
  refundOrderOnce,
  deduplicatePlayers,
  getInFlightRounds,
  saveInFlightRounds,
  parkCurrentRoundToInFlight,
  newRoundId,
  bangkokDay,
  dailySettledKey,
  getDailySettledOrders,
  voidInFlightRound,
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
  generateDailySummaryFlex,
  generateQuoteFlex,
  generateNoticeFlex,
  generateVoidRoundFlex,
  generateSettlementFlex,
  setPublicBaseUrl,
} from './flexTemplates.js';

function formatTime(timestamp?: number): string {
  const d = timestamp ? new Date(timestamp) : new Date();
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/**
 * An order as an unauthenticated caller may see it: the fields the LINE group
 * already shows. No player IDs, LINE user IDs, group IDs or settlement money.
 */
function publicOrderView(b: Order): any {
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
    rocketName: f.rocketName ?? null,
    status: f.status,
    createdAt: f.createdAt,
    timestamp: f.timestamp,
  };
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
/**
 * The platform's cut of a won bet.
 *
 * Charged on the LOSER's stake only — the winner's own stake is returned
 * untouched. A winner on a 500pt bet therefore receives 500 + 450 = 950, and
 * the platform keeps 50. Set to 0 to run settlement with no rake.
 *
 * Mirrors the GAS implementation (Code.gs ~3135). Kept as a named constant so
 * the rate is one edit rather than a literal buried in the settlement loop,
 * which is how it came to be missing in the first place.
 */
const PLATFORM_COMMISSION_RATE = 0.10;

/**
 * Settle orders against a flight time, each in its own atomic ledger step.
 *
 * The Durable Object re-reads the stored order, refuses anything no longer
 * `matched`, computes the winner and the 10% fee from the STORED amount and
 * parties, credits the winner (or both stakes on a draw), and moves the order
 * from the matched list to the settled list — all at once. Settlement used to
 * check a KV copy and then pay in separate writes, so a second "settle" click,
 * or a cancel landing in between, could pay the same order twice.
 */
async function settleOrdersAtomically(
  candidates: Order[],
  finalSeconds: number,
  tMin: number,
  tMax: number,
  env: Env,
  ctx: ExecutionContext | undefined,
  skip: Set<string> = new Set()
): Promise<{ settled: Order[]; failed: Array<{ orderNumber: string; reason: string }> }> {
  const settled: Order[] = [];
  const failed: Array<{ orderNumber: string; reason: string }> = [];
  const seen = new Set<string>();
  // The daily summary's source. SETTLED_ORDERS_LIST keeps only the latest 100
  // and is wiped by "ปิดรอบพอร์ทัล", so it cannot back a whole day of duels.
  const dayKey = dailySettledKey(bangkokDay());
  for (const item of candidates) {
    if (!item || !item.orderNumber || seen.has(item.orderNumber) || skip.has(item.orderNumber)) continue;
    seen.add(item.orderNumber);
    const res = await ledger(env, {
      orders: [{
        orderNumber: item.orderNumber,
        ...(item.createdAt ? { expectCreatedAt: Number(item.createdAt) } : {}),
        expectStatus: ['matched'],
        settle: { finalSeconds, tMin, tMax, commissionRate: PLATFORM_COMMISSION_RATE },
      }],
      lists: [
        { key: 'MATCHED_ORDERS_LIST', op: 'remove', orderNumber: item.orderNumber },
        { key: 'SETTLED_ORDERS_LIST', op: 'upsert', orderNumber: item.orderNumber, cap: 100 },
        { key: dayKey, op: 'append', orderNumber: item.orderNumber, cap: 1000 },
      ],
    }, ctx);
    if (res.ok) {
      settled.push(res.orders[item.orderNumber] as Order);
    } else if (res.reason === 'order_status') {
      console.warn(`[Worker] skipping order #${item.orderNumber} at settlement: status is "${res.current?.status}", not "matched"`);
    } else {
      console.error(`[Worker] settlement of #${item.orderNumber} failed: ${res.reason} ${res.detail || ''}`);
      failed.push({ orderNumber: item.orderNumber, reason: String(res.reason) });
    }
  }
  return { settled, failed };
}

/**
 * Every settled order of a round, for the group's result card. A retry after a
 * partial failure only settles what was left, so the card is rebuilt from the
 * stored records of the whole round rather than from that call's results —
 * otherwise the group would get one card per attempt, each missing pairs.
 */
async function roundSettledOrders(orderNumbers: Iterable<string>, justSettled: Order[], env: Env): Promise<Order[]> {
  const byNumber = new Map(justSettled.map((o) => [o.orderNumber, o]));
  const out: Order[] = [];
  for (const n of new Set(orderNumbers)) {
    if (!n) continue;
    const o = byNumber.get(n) || (await getOrderRecord(n, env));
    if (o && o.status === 'settled') out.push(o);
  }
  return out.sort((a, b) => (Number(a.settledAt) || 0) - (Number(b.settledAt) || 0));
}

/**
 * Refuse a settlement retry whose flight time differs from the one the round
 * was already partly paid on. 409 like any other refused money operation, so
 * the console cannot read it as success.
 */
function settleRetryRefusal(error: string, lockedFinalTime: number, headers: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ success: false, error, data: { success: false, error, lockedFinalTime } }),
    { status: 409, headers: { 'Content-Type': 'application/json', ...headers } }
  );
}

/** A flight time the admin actually entered. `Number('') || 0` settled every order as a low-side win. */
function parseFlightSeconds(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
    setPublicBaseUrl(env.PUBLIC_BASE_URL, url.origin);

    // ── CORS Headers for Admin Web Portal ──
    //
    // `x-admin-session` MUST be listed here. It is the header the portal sends
    // on every authenticated call (dashboard poll, approve, change password),
    // and a custom header makes the request preflighted: if the browser's
    // Access-Control-Request-Headers is not answered here, it rejects the
    // response before the Worker is ever invoked and fetch() throws a bare
    // "Failed to fetch".
    //
    // That is exactly what made the console look disconnected from LINE OA —
    // login succeeded (no session header yet, so no preflight), and then every
    // subsequent call died in the browser with no server-side error to find.
    // It was introduced with the session-token auth refactor, which added the
    // header without adding it to this allow-list.
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key, x-admin-api-key, x-admin-session',
      // The console polls every 0.5–3s, each poll preflights, and the browser
      // default of 5s would double the request count against the Workers daily
      // cap for no benefit. 10 minutes collapses that to one preflight per tab.
      'Access-Control-Max-Age': '600',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── 0. LINE card watermark icons (public, immutable) ──
    const iconMatch = request.method === 'GET' ? url.pathname.match(/^\/icons\/([a-z]+)\.png$/) : null;
    if (iconMatch) {
      const b64 = (LINE_ICONS as Record<string, string>)[iconMatch[1]];
      if (!b64) return new Response('Not found', { status: 404 });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bytes, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
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
                // An atomic claim, not get-then-put: a redelivery arriving
                // while the first copy is still in flight must not run a
                // second time (a bet or match would be placed twice).
                if (event.webhookEventId) {
                  const first = await state(env).claimExclusive(
                    `EVENT:${event.webhookEventId}`,
                    { at: Date.now() },
                    10 * 60 * 1000
                  );
                  if (!first) {
                    console.log(`[Worker] Duplicate webhookEventId ${event.webhookEventId} dropped.`);
                    return;
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

// getP2PResults is admin-only: it lists every duel with commission and
        // payout, and nothing outside the Admin Console reads it.
        const isPublicAllowed =
          functionName === 'getDashboardData' ||
          functionName === 'adminLogin' ||
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
          const [scalars, pendingBets, matchedBets, players, transactions, inFlightRounds] = await Promise.all([
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
            getInFlightRounds(env),
          ]);
          const [roundStr, activeGroupId, lineGroupsRaw, chatLogsRaw, cachedQuotaRaw] = scalars;

          const allOrders = [...pendingBets, ...matchedBets];
          const formattedBets = allOrders.map(formatOrderForDashboard);
          const formattedInFlightRounds = (inFlightRounds || []).map((r: InFlightRound) => ({
            ...r,
            matchedOrders: (r.matchedOrders || []).map(formatOrderForDashboard),
          }));

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
              inFlightRounds: formattedInFlightRounds,
              chatLogs,
              activeGroupId: validActiveGroupId,
              lineGroups,
              activeRound: roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380, status: 'ACTIVE' },
              roundStatus: roundStr ? (JSON.parse(roundStr).status || 'ACTIVE') : 'ACTIVE',
              serverTime: new Date().toISOString(),
              lineQuota,
            };
          } else {
            // Unauthenticated callers get the public board only — what the
            // LINE group already sees. There used to be a per-player view
            // keyed on args[0]: anyone who sent a PL code got that player's
            // balance, transactions and chat log with no login. And the
            // in-flight rounds went out whole, LINE user IDs and all.
            result = {
              players: [],
              transactions: [],
              bets: pendingBets.filter((b: any) => b.status === 'pending_match').map(publicOrderView),
              inFlightRounds: (inFlightRounds || []).map((r: InFlightRound) => ({
                roundId: r.roundId,
                name: r.name,
                targetMin: r.targetMin,
                targetMax: r.targetMax,
                isChotoy: r.isChotoy,
                quoteReleased: r.quoteReleased,
                launchedAt: r.launchedAt,
                matchedOrders: (r.matchedOrders || []).map(publicOrderView),
              })),
              chatLogs: [],
              activeGroupId: '',
              lineGroups: [],
              activeRound: roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380, status: 'ACTIVE' },
              roundStatus: roundStr ? (JSON.parse(roundStr).status || 'ACTIVE') : 'ACTIVE',
              serverTime: new Date().toISOString(),
            };
          }
        } else if (functionName === 'getP2PResults') {
          const settledOrders = await getSettledOrdersList(env);
          const p2p: any[] = [];
          for (const order of settledOrders) {
            if (order.winnerSide && order.winnerSide !== 'draw') {
              const isCreatorWinner = order.winnerSide === order.side;
              const winnerName = (isCreatorWinner ? order.creatorName : order.matcherName) || order.winnerName || '-';
              const loserName = (isCreatorWinner ? order.matcherName : order.creatorName) || '-';
              p2p.push({
                orderNumber: order.orderNumber,
                amount: Number(order.amount) || 0,
                winnerSide: order.winnerSide,
                winnerName,
                loserName,
                finalTime: order.finalTime || null,
                settleAt: order.settledAt || null,
                // Exposed so the operator can reconcile platform revenue per
                // round rather than inferring it from balances.
                commission: Number(order.commission) || 0,
                payout: Number(order.payout) || 0,
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
              // Hand back a FULL-scope session.
              //
              // The session used to reach this endpoint is scope:'reset' — the
              // one minted at login when the credential was flagged mustChange.
              // Returning only recovery codes left the browser holding that
              // restricted token forever: every subsequent call (getDashboardData
              // included) was refused with 403 PasswordChangeRequired, so the
              // console rendered permanently empty. That is what made LINE OA
              // deposits look like they never reached the Admin Portal.
              // The password is now rotated, so the restricted scope has done its
              // job and must be upgraded in the same response.
              result = {
                success: true,
                recoveryCodes: changed.recoveryCodes,
                daysUntilExpiry: changed.daysUntilExpiry,
                maxAgeDays: PASSWORD_MAX_AGE_DAYS,
                ...(env.SESSION_SECRET
                  ? {
                      session: await issueSessionToken(
                        sessionClaims.sub,
                        sessionClaims.role,
                        env.SESSION_SECRET
                      ),
                      username: sessionClaims.sub,
                      role: sessionClaims.role,
                      expiresIn: 8 * 60 * 60,
                    }
                  : {}),
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
              // A recovery code + a new password is a complete authentication,
              // so the operator is signed straight in instead of being bounced
              // back to the login form (which would otherwise leave any stale
              // restricted token in session storage).
              ...(env.SESSION_SECRET
                ? {
                    session: await issueSessionToken(reset.username, reset.role, env.SESSION_SECRET),
                    expiresIn: 8 * 60 * 60,
                  }
                : {}),
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
          if (!targetTx) {
            result = { success: false, error: 'Transaction not found', txId };
          } else {
            const isWithdrawal = String(txId).startsWith('WD') || targetTx.type === 'withdraw';
            const requested = Number(targetTx.requestedAmount) || 0;
            // Status flip and credit in ONE atomic step, conditional on the
            // stored status. Two approve clicks (or two admins) used to both
            // pass the "already processed" check and credit the deposit twice.
            const res = await ledger(env, {
              transactions: [{
                id: txId,
                mustExist: true,
                expectStatusNotIn: ['success', 'rejected'],
                patch: { status: 'success', actualAmount: requested },
                creditRequested: !isWithdrawal && requested > 0,
              }],
            }, ctx);

            if (!res.ok) {
              result = res.reason === 'tx_status'
                ? { success: false, error: 'รายการนี้ได้รับการดำเนินการไปแล้ว', txId }
                : { success: false, error: `อนุมัติไม่สำเร็จ (${res.reason}) — ไม่มีการเปลี่ยนแปลงยอดเงิน`, txId, ledgerFailure: true };
            } else {
              const tx = res.transactions[txId] || targetTx;
              const credited = res.balances[0];
              const effectiveLine = credited?.lineUserId ||
                (tx.lineUserId && tx.lineUserId.startsWith('U') ? tx.lineUserId : '') ||
                (await state(env).get(`RAW_LINE_${tx.playerId}`)) || '';
              mirrorTransactionToSheets(tx, env, ctx);

              if (effectiveLine && effectiveLine.startsWith('U')) {
                const text = isWithdrawal
                  ? generateNoticeFlex('โอนเงินถอนแล้ว', `โอน ${requested.toLocaleString()} บาท เข้าบัญชีของคุณแล้ว`, 'out')
                  : generateNoticeFlex('เติมเครดิตแล้ว', `ฝาก ${requested.toLocaleString()} บาท\nยอดคงเหลือ ${(credited?.after ?? 0).toLocaleString()} pt`, 'in');
                ctx?.waitUntil(pushToLine(effectiveLine, text, env).catch(e => console.error(e)));
              }
              result = {
                success: true,
                txId,
                ...(credited ? { balance: credited.after } : {}),
                ...(!isWithdrawal && !(requested > 0)
                  ? { warning: 'ยอดฝากในรายการนี้เป็น 0 — ไม่ได้เพิ่มเครดิต กรุณาปรับยอดผู้เล่นด้วยตนเอง' }
                  : {}),
              };
            }
          }
        } else if (functionName === 'adminRejectTransaction') {
          const txId = args[0];
          const reason = args[1] || 'ไม่พบยอดเงินเข้าบัญชี';
          const txs = await getTransactionsList(env);
          const targetTx = txs.find(t => t.id === txId);
          if (!targetTx) {
            result = { success: false, error: 'Transaction not found', txId };
          } else {
            const isWithdrawal = String(txId).startsWith('WD') || targetTx.type === 'withdraw';
            const requested = Number(targetTx.requestedAmount) || 0;
            // A rejected withdrawal returns the points that were locked when it
            // was requested — exactly once, in the same step as the status flip.
            const res = await ledger(env, {
              transactions: [{
                id: txId,
                mustExist: true,
                expectStatusNotIn: ['success', 'rejected'],
                patch: { status: 'rejected', reviewReason: reason },
                creditRequested: isWithdrawal && requested > 0,
              }],
            }, ctx);

            if (!res.ok) {
              result = res.reason === 'tx_status'
                ? { success: false, error: 'รายการนี้ได้รับการดำเนินการไปแล้ว', txId }
                : { success: false, error: `ปฏิเสธไม่สำเร็จ (${res.reason}) — ไม่มีการเปลี่ยนแปลงยอดเงิน`, txId, ledgerFailure: true };
            } else {
              const tx = res.transactions[txId] || targetTx;
              const credited = res.balances[0];
              const effectiveLine = credited?.lineUserId ||
                (tx.lineUserId && tx.lineUserId.startsWith('U') ? tx.lineUserId : '') ||
                (await state(env).get(`RAW_LINE_${tx.playerId}`)) || '';
              mirrorTransactionToSheets(tx, env, ctx);

              if (effectiveLine && effectiveLine.startsWith('U')) {
                const text = isWithdrawal
                  ? generateNoticeFlex('คำขอถอนถูกปฏิเสธ', `เหตุผล: ${reason}\nคืน ${requested.toLocaleString()} pt เข้ากระเป๋าแล้ว ยอดคงเหลือ ${(credited?.after ?? 0).toLocaleString()} pt`, 'error')
                  : generateNoticeFlex('รายการฝากถูกปฏิเสธ', `ยอด ${requested.toLocaleString()} บาท\nเหตุผล: ${reason}`, 'error');
                ctx?.waitUntil(pushToLine(effectiveLine, text, env).catch(e => console.error(e)));
              }
              result = { success: true, txId };
            }
          }
        } else if (functionName === 'adminRequestCancelBet') {
          const rawId = args[0] ? String(args[0]).trim() : '';
          const orderNo = rawId.replace(/^bet_/, '');
          const order = await getOrderRecord(orderNo, env);
          if (!order) {
            result = { success: false, error: `ไม่พบข้อมูลแผล Order #${orderNo}` };
          } else if (order.status === 'matched_paired') {
            // The mirror half of an auto-matched pair: its stake is settled
            // (or refunded) through the partner order, which names both players.
            result = {
              success: false,
              error: `แผล Order #${orderNo} เป็นคู่ที่จับอัตโนมัติ — กรุณายกเลิกที่แผลของ ${order.matcherName || order.matcherId || 'คู่ดวล'} ที่จับคู่กับแผลนี้แทน`,
            };
          } else {
            // Only an order that still holds stake can be cancelled. This used to
            // exclude just `cancelled` and `resolved`, so a SETTLED order could be
            // cancelled after payout and both players refunded on top of it.
            // refundOrderOnce re-checks the stored status atomically.
            // A matched order is locked: not even an admin may cancel it one
            // by one. Voiding the whole round remains the only refund for a
            // matched duel. The status is re-checked atomically here, so a
            // match landing at the same moment is refused too.
            const refund = await refundOrderOnce(order, env, ctx, 'admin_cancel', {
              allowedStatuses: ['pending_match', 'pending_hold', 'refunding'],
            });

            if (!refund.refunded) {
              const now = refund.order?.status || order.status;
              result = refund.reason === 'claim_unavailable'
                ? { success: false, error: 'ระบบไม่สามารถยืนยันรายการได้ในขณะนี้ — ไม่มีการคืนแต้ม กรุณาลองใหม่', ledgerFailure: true }
                : refund.reason === 'already_refunded' || now === 'cancelled'
                  ? {
                      success: true,
                      orderNumber: orderNo,
                      alreadyRefunded: true,
                      message: `แผล Order #${orderNo} ถูกยกเลิก/คืนแต้มไปแล้ว — ไม่ได้คืนแต้มซ้ำ`,
                    }
                  : now === 'matched'
                    ? { success: false, locked: true, error: `แผล Order #${orderNo} ต่อติดแล้ว — ระบบล็อก ไม่สามารถยกเลิกรายแผลได้ (คืนเงินได้ทางเดียวคือ "โมฆะรอบ")` }
                    : { success: false, error: `แผล Order #${orderNo} อยู่ในสถานะ ${now} แล้ว — ไม่สามารถยกเลิก/คืนแต้มได้` };
            } else {
              // Tell the player. A silent refund is indistinguishable from a
              // failed one, and the player has no way to know the order is gone.
              const notifyTargets = [order.creatorLineUserId, refund.matcherCredited ? order.matcherLineUserId : null]
                .filter((x): x is string => typeof x === 'string' && x.startsWith('U'));
              if (refund.amount > 0 && notifyTargets.length > 0) {
                const notify = Promise.all(notifyTargets.map((to) => pushToLine(
                  to,
                  generateNoticeFlex(`แอดมินยกเลิกออเดอร์ #${orderNo}`, `คืนเครดิต +${refund.amount.toLocaleString()} pt เข้ากระเป๋าแล้ว`, 'in'),
                  env
                ))).catch((e) => console.error('[Worker] admin cancel notice failed:', e));
                if (ctx) ctx.waitUntil(notify);
                else await notify;
              }
              result = {
                success: true,
                orderNumber: orderNo,
                refundedAmount: refund.amount,
                creatorCredited: refund.creatorCredited,
                matcherCredited: refund.matcherCredited,
              };
            }
          }
        } else if (functionName === 'adminGetBankDetails') {
          // Readable by any admin — the deposit screen needs it and it is not
          // a secret beyond what players already see in LINE.
          result = { success: true, bank: await getPaymentBank(env) };
        } else if (functionName === 'adminSetBankDetails') {
          // Super Admin only: this is where player money is instructed to go,
          // so a compromised limited-admin session must not be able to redirect
          // deposits. With a stale account number, players transfer into the void.
          if (!isSuperAdminKeyAuth && adminRole !== 'superadmin') {
            result = { success: false, error: 'Forbidden: เฉพาะ Super Admin เท่านั้นที่แก้ไขบัญชีรับเงินได้' };
          } else {
            const saved = await setPaymentBank(env, {
              bankName: args[0],
              accountNumber: args[1],
              accountName: args[2],
              note: args[3],
            });
            if (!saved) {
              result = { success: false, error: 'กรุณากรอก ธนาคาร / เลขบัญชี / ชื่อบัญชี ให้ครบถ้วน' };
            } else {
              result = { success: true, bank: saved };
            }
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

          // Fetch authoritative profile via getOrCreatePlayerProfile so oldBal is never stale
          const lookupKey = targetLineUserId || shortId || userId;
          let existingProfile: PlayerProfile | null = null;
          if (lookupKey) {
            try {
              existingProfile = await getOrCreatePlayerProfile(lookupKey, env, ctx);
            } catch (_) {}
          }
          if (existingProfile && existingProfile.balance !== undefined) {
            oldBal = Number(existingProfile.balance) || 0;
          }

          const updatedProfile: PlayerProfile = {
            ...(existingProfile || {}),
            shortId: existingProfile?.shortId || shortId,
            lineUserId: targetLineUserId || existingProfile?.lineUserId || shortId,
            displayName: passedName || existingProfile?.displayName || displayName,
            balance: newBal,
            bankName: existingProfile?.bankName || player?.bankName || '',
            accountNumber: existingProfile?.accountNumber || player?.bankAccount || player?.accountNumber || '',
            accountName: existingProfile?.accountName || player?.accountName || displayName,
            registeredAt: existingProfile?.registeredAt || player?.registeredAt || Date.now(),
            updatedAt: Date.now(),
          };

          // Set the balance atomically. The old value comes from the commit
          // itself, so the ledger records the real delta, and a bet or payout
          // landing at the same moment is not silently overwritten by a value
          // computed from an earlier read.
          await savePlayerProfile(updatedProfile, env, ctx); // name / bank fields; never the balance
          const setRes = await ledger(env, {
            balances: [{ shortId: updatedProfile.shortId, lineUserId: updatedProfile.lineUserId, set: newBal, displayName: updatedProfile.displayName }],
          }, ctx);
          if (!setRes.ok) {
            result = { success: false, error: `ปรับยอดไม่สำเร็จ (${setRes.reason}) — ยอดเงินไม่เปลี่ยนแปลง`, ledgerFailure: true };
          } else {
            oldBal = setRes.balances[0]?.before ?? oldBal;
            await addTransaction({
              id: `ADJ${Date.now().toString().slice(-6)}${Math.floor(10 + Math.random() * 90)}`,
              playerId: updatedProfile.shortId,
              lineUserId: updatedProfile.lineUserId,
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
          }

          // Push DM to LINE user so they are immediately aware of their updated credit amount
          if (result === null && targetLineUserId && targetLineUserId.startsWith('U')) {
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

          if (result === null) result = { success: true, balance: newBal };
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
          // savePlayerProfile never overwrites an existing balance; an explicit
          // starting balance is applied through the ledger.
          if (newP.balance !== bal) {
            const setRes = await ledger(env, { balances: [{ shortId, lineUserId: lineId, set: bal }] }, ctx);
            if (setRes.ok) newP.balance = bal;
          }

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
          const targetMin = Number(args[1]) || 330;
          const targetMax = Number(args[2]) || 380;
          const parked = await parkCurrentRoundToInFlight(env, ctx, false);
          await state(env).put('ACTIVE_ROUND', JSON.stringify({
            roundId: newRoundId(),
            name: roundName,
            targetMin,
            targetMax,
            status: 'ACTIVE',
            isChotoy: false,
            quoteReleased: false,
            updatedAt: Date.now(),
          }));
          result = {
            success: true,
            round: roundName,
            parkedRound: parked.parkedRound,
            refundedPending: parked.refundedPending,
            refundedUnquoted: parked.refundedUnquoted,
          };

        } else if (functionName === 'adminOpenNextRocket') {
          // Concurrent Rocket Rounds:
          // Parks Rocket A (and its locked matched orders) into IN_FLIGHT_ROUNDS
          // and immediately opens ACTIVE_ROUND for Rocket B so players can place
          // and match orders on Rocket B while Rocket A is still flying.
          const target = args[0] || 'ALL';
          const nextName = (args[1] && String(args[1]).trim()) ? String(args[1]).trim() : 'บั้งไฟลำถัดไป';
          const mode = args[2] === 'quote' ? 'quote' : 'pre_quote';
          const min = Number(args[3]) || 330;
          const max = Number(args[4]) || 380;
          const isChotoy = Boolean(args[5]);
          const broadcastLine = args[6] !== false;

          const parked = await parkCurrentRoundToInFlight(env, ctx, true);

          const roundData = {
            roundId: newRoundId(),
            name: nextName,
            targetMin: min,
            targetMax: max,
            status: 'ACTIVE',
            isChotoy: mode === 'quote' ? isChotoy : false,
            quoteReleased: mode === 'quote',
            updatedAt: Date.now(),
          };
          await state(env).put('ACTIVE_ROUND', JSON.stringify(roundData));

          let sendResults: any[] = [];
          let targets: string[] = [];
          if (broadcastLine) {
            targets = await resolveTargetGroupIds(target, env);
            if (targets.length > 0) {
              const payload = mode === 'quote'
                ? generateQuoteFlex(nextName, min, max, isChotoy, true)
                : generateNoticeFlex(`บั้งไฟ ${nextName} พร้อมแล้ว`, 'เปิดแผลได้เลย ราคาช่างจะประกาศตามมา', 'info');
              sendResults = await Promise.all(targets.map((to) => pushToLine(to, payload, env)));
              await appendChatLog(env, {
                timestamp: formatTime(),
                userId: targets[0],
                displayName: nextName,
                sender: 'admin',
                text: mode === 'quote'
                  ? `[เปิดราคาบั้งไฟถัดไป: ${nextName} (${min}-${max}s)]`
                  : `[บั้งไฟ ${nextName} พร้อมแล้ว]`,
                type: 'flex',
              });
            }
          }

          const inFlightRounds = await getInFlightRounds(env);
          result = {
            success: true,
            round: roundData,
            parkedRound: parked.parkedRound,
            refundedPending: parked.refundedPending,
            refundedUnquoted: parked.refundedUnquoted,
            inFlightRounds,
            targets,
            results: sendResults,
          };

        } else if (functionName === 'adminVoidInFlightRound') {
          const roundId = String(args[0] || '').trim();
          const target = args[1] || 'ALL';
          const voidRes = await voidInFlightRound(roundId, env, ctx);
          if (!voidRes.found) {
            result = { success: false, error: 'ไม่พบรอบบั้งไฟที่กำลังลอยอยู่' };
          } else {
            const targets = await resolveTargetGroupIds(target, env);
            if (targets.length > 0) {
              const voidFlex = generateVoidRoundFlex(voidRes.roundName);
              await Promise.all(targets.map((to) => pushToLine(to, voidFlex, env)));
            }
            result = {
              success: true,
              roundId,
              roundName: voidRes.roundName,
              voided: voidRes.voided,
              inFlightRounds: await getInFlightRounds(env),
            };
          }

        } else if (functionName === 'adminCloseRound') {
          // ──────────────────────────────────────────────────────────────────
          // "ปิดรอบพอร์ทัล" — soft round reset.
          //
          // Clears everything that belongs to the current round so the admin
          // can start a fresh one cleanly:
          //   • Cancels & refunds any remaining unmatched pending orders
          //     AND any active matched orders that were not yet settled
          //   • Also refunds & clears any parked In-Flight rounds
          //   • Clears PENDING_ORDERS_LIST and MATCHED_ORDERS_LIST
          //   • Clears SETTLED_ORDERS_LIST (round-history display resets)
          //   • Resets ACTIVE_ROUND to a blank ACTIVE state
          // ──────────────────────────────────────────────────────────────────
          // Lock first so nothing is opened or matched while orders are being
          // refunded; then each order is refunded and de-listed atomically.
          // The matched list and in-flight rounds are no longer blanked
          // wholesale afterwards — that dropped any order matched mid-close,
          // with both stakes held and nothing left to refund them from.
          const closeLockStr = await state(env).get('ACTIVE_ROUND');
          const closeLock = closeLockStr ? JSON.parse(closeLockStr) : null;
          if (closeLock && closeLock.status === 'ACTIVE') {
            await state(env).put('ACTIVE_ROUND', JSON.stringify({ ...closeLock, status: 'CLOSED', updatedAt: Date.now() }));
          }
          const { voided } = await voidAllRoundOrders(env, ctx);
          let voidedInFlight = 0;
          const inFlightList = await getInFlightRounds(env);
          for (const flt of inFlightList) {
            const vr = await voidInFlightRound(flt.roundId, env, ctx);
            voidedInFlight += vr.voided;
          }

          await Promise.all([
            state(env).put('SETTLED_ORDERS_LIST', JSON.stringify([])),
            state(env).put('ACTIVE_ROUND', JSON.stringify({
              roundId: newRoundId(),
              name: 'บั้งไฟสด',
              targetMin: 330,
              targetMax: 380,
              status: 'ACTIVE',
              isChotoy: false,
              quoteReleased: false,
              updatedAt: Date.now(),
            })),
          ]);

          const totalVoided = voided + voidedInFlight;
          console.log(`[Worker] adminCloseRound: round reset complete (${totalVoided} open orders refunded).`);
          result = {
            success: true,
            message: `ปิดรอบเรียบร้อย — คืนแต้ม ${totalVoided} แผลค้างอยู่ และรีเซ็ตรอบใหม่พร้อมรับออเดอร์แล้ว`,
            clearedOrders: totalVoided,
            clearedPending: totalVoided,
          };

        } else if (
          functionName === 'clearPendingBets' ||
          functionName === 'adminClearOrders' ||
          functionName === 'resetOrders' ||
          functionName === 'clearCache'
        ) {
          const res = await clearAllPendingOrders(env);
          result = { success: true, message: 'Cleared pending orders and board cache', cleared: res.cleared };
        } else if (functionName === 'adminSetDangerPin') {
          // Super Admin only, matching the action it guards. Without this any
          // admin could set (and then satisfy) their own PIN.
          if (adminRole !== 'superadmin') {
            return new Response(JSON.stringify({ error: 'Forbidden: เฉพาะ Super Admin เท่านั้นที่ตั้ง PIN ได้' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          const format = validatePinFormat(args[0]);
          if (!format.ok) {
            return new Response(JSON.stringify({ error: format.error }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          await setDangerPin(state(env), String(args[0]));
          result = { success: true, message: 'ตั้งค่า PIN สำหรับการล้างข้อมูลเรียบร้อย' };

        } else if (functionName === 'adminGetDangerPinStatus') {
          if (adminRole !== 'superadmin') {
            return new Response(JSON.stringify({ error: 'Forbidden' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          result = { success: true, configured: await isPinConfigured(state(env)) };

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
          // Second factor: a PIN held outside the session, verified here rather
          // than in the dialog. This call deletes every player, balance and log
          // irreversibly and there is no backup — the Apps Script mirror is not
          // reachable — so the role check alone leaves one stray click standing
          // between a session and a wiped database. Fails closed when unset.
          const pinVerdict = await verifyDangerPin(state(env), args[0]);
          if (!pinVerdict.ok) {
            const status = pinVerdict.code === 'not_configured' ? 409 : 403;
            console.warn('[Worker] Factory Reset refused:', pinVerdict.code);
            return new Response(
              JSON.stringify({ error: pinVerdict.error, code: pinVerdict.code }),
              { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }
          // 1. Clear atomic order state in KV
          await clearAllPendingOrders(env);
          await state(env).delete('IN_FLIGHT_ROUNDS');
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

          // 3b. Orders and round history. Without this a reset left every order
          //     record, the matched / settled lists and the daily summaries
          //     behind, still naming players that no longer exist. Orders are
          //     deleted from KV_ORDERS too: a DO miss adopts the KV copy, so a
          //     KV leftover would bring the order back. Claims (CLAIM_*) stay:
          //     the slip ones are what stops a used slip being credited twice.
          let ordersCleared = 0;
          try {
            const orderKeys = await state(env).list({ prefix: 'ORDER_' });
            await Promise.all((orderKeys.keys || []).map((k) => state(env).delete(k.name)));
            ordersCleared = (orderKeys.keys || []).length;
            let cursor: string | undefined;
            do {
              const page: any = await env.KV_ORDERS.list({ prefix: 'ORDER_', cursor });
              await Promise.all((page.keys || []).map((k: any) => env.KV_ORDERS.delete(k.name)));
              ordersCleared = Math.max(ordersCleared, (page.keys || []).length);
              cursor = page.list_complete ? undefined : page.cursor;
            } while (cursor);
            const dayKeys = await state(env).list({ prefix: 'SETTLED_DAY_' });
            await Promise.all((dayKeys.keys || []).map((k) => state(env).delete(k.name)));
          } catch (err) {
            console.warn('[Worker] Factory Reset: order sweep incomplete:', err);
          }
          await Promise.all(
            ['PENDING_ORDERS_LIST', 'MATCHED_ORDERS_LIST', 'SETTLED_ORDERS_LIST', 'ACTIVE_ROUND'].map((k) => state(env).delete(k))
          );

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
            ordersCleared,
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
                const roundStr = await state(env).get('ACTIVE_ROUND');
                const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
                round.status = 'CLOSED';
                round.updatedAt = Date.now();
                await state(env).put('ACTIVE_ROUND', JSON.stringify(round));
                if (round.quoteReleased !== true) {
                  await cancelHeldPreQuoteOrders(env, ctx);
                }
                await clearAllPendingOrders(env, ctx);
                payload = generateRocketLaunchedFlex(round.name);
              } else if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit' || clean === 'ฝาก') {
                payload = generateDepositFlex(await getPaymentBank(env));
              } else if (clean === 'กระดานดวล' || clean === 'กระดาน' || clean === 'board') {
                const pending = await getPendingOrdersList(env);
                payload = generatePendingBoardFlex(pending);
              } else if (clean.includes('ปิดรับดวล') || clean.startsWith('ปิดรอบ') || clean.startsWith('ล็อครอบ')) {
                const roundStr = await state(env).get('ACTIVE_ROUND');
                const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
                round.status = 'CLOSED';
                round.updatedAt = Date.now();
                await state(env).put('ACTIVE_ROUND', JSON.stringify(round));
                if (round.quoteReleased !== true) {
                  await cancelHeldPreQuoteOrders(env, ctx);
                }
                await clearAllPendingOrders(env, ctx);
              } else if (clean.startsWith('เปิดรอบ') || clean.startsWith('เปิดรับดวล')) {
                const roundStr = await state(env).get('ACTIVE_ROUND');
                let round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
                // Reopening a CLOSED round un-does a Final Call on the same rocket.
                // A RESOLVED or VOID round is finished: anything still on its
                // board is parked and a new rocket round starts, so it cannot
                // settle on the next rocket's flight time.
                if (round.status === 'RESOLVED' || round.status === 'VOID') {
                  await parkCurrentRoundToInFlight(env, ctx, false);
                  round = { ...round, roundId: newRoundId(), quoteReleased: false };
                } else if (!round.roundId) {
                  round.roundId = newRoundId();
                }
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
        } else if (functionName === 'adminBroadcastRocketLaunched' || functionName === 'adminBroadcastFinalCall') {
          const target = args[0];
          const roundStr = await state(env).get('ACTIVE_ROUND');
          const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
          round.status = 'CLOSED';
          round.updatedAt = Date.now();
          await state(env).put('ACTIVE_ROUND', JSON.stringify(round));

          if (round.quoteReleased !== true) {
            await cancelHeldPreQuoteOrders(env, ctx);
          }
          await clearAllPendingOrders(env, ctx);

          const rocketLaunchFlex = generateRocketLaunchedFlex(round.name);

          const targets = await resolveTargetGroupIds(target, env);
          if (targets.length === 0) {
            result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ', round };
          } else {
            const sendResults = await Promise.all(targets.map((to) => pushToLine(to, rocketLaunchFlex, env)));
            const allSuccess = sendResults.every((r) => r.success);
            const quotaError = sendResults.find((r) => r.code === 429);

            await appendChatLog(env, {
              timestamp: formatTime(),
              userId: targets[0],
              displayName: 'ระบบ',
              sender: 'admin',
              text: `[🚀 บั้งไฟออกแล้ว · ปิดรับดวล (${round.name || 'บั้งไฟสด'})]`,
              type: 'flex',
            });

            result = {
              success: allSuccess,
              targets,
              round,
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

          // Only preserve the CLOSED lock — that is the Final Call, which
          // exists to stop players placing bets while the rocket is in the air.
          // A VOID or RESOLVED round has already finished; broadcasting a new
          // quote is the natural way to start the next race, so those states
          // must transition back to ACTIVE. The original guard treated every
          // non-ACTIVE status the same, so a voided round that the admin
          // re-quoted stayed VOID and every player bet was rejected as if the
          // round were still locked mid-flight.
          const existingRaw = await state(env).get('ACTIVE_ROUND');
          const existing = existingRaw ? JSON.parse(existingRaw) : null;
          const isLocked = Boolean(
            existing && existing.status && existing.status === 'CLOSED'
          );
          if (isLocked) {
            console.warn(
              `[Worker] quote published while the round is CLOSED (Final Call in effect) — keeping it locked; open a new round to reopen`
            );
          }

          // Pricing the rocket that is open (or locked by Final Call) keeps its
          // round. Quoting after a RESOLVED / VOID round starts a new rocket:
          // park whatever is left on the old board first — e.g. orders whose
          // settlement failed — so they never settle on this rocket's time.
          const continuesRound = Boolean(existing && existing.roundId && (existing.status === 'ACTIVE' || existing.status === 'CLOSED'));
          if (existing && !continuesRound && (existing.status === 'RESOLVED' || existing.status === 'VOID')) {
            await parkCurrentRoundToInFlight(env, ctx, false);
          }
          const roundData = {
            roundId: continuesRound ? existing.roundId : newRoundId(),
            name,
            targetMin: min,
            targetMax: max,
            status: isLocked ? existing.status : 'ACTIVE',
            isChotoy,
            quoteReleased: true,
            updatedAt: Date.now(),
          };
          await state(env).put('ACTIVE_ROUND', JSON.stringify(roundData));

          await releaseHeldPreQuoteOrders(min, max, env, ctx, name);

          const quoteFlex = generateQuoteFlex(name, min, max, isChotoy);

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
        } else if (functionName === 'adminBroadcastVoidRound') {
          const target = args[0];
          const roundStr = await state(env).get('ACTIVE_ROUND');
          const round = roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380 };
          round.status = 'VOID';
          round.updatedAt = Date.now();
          await state(env).put('ACTIVE_ROUND', JSON.stringify(round));

          const voidFlex = generateVoidRoundFlex();

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
            const msg = `ทดสอบการส่งข้อความจาก Admin Console\nเวลา ${timeStr} · การเชื่อมต่อปกติ`;
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
          const finalSecondsParsed = parseFlightSeconds(args[0]);
          const tMin = Number(args[1]) || 330;
          const tMax = Number(args[2]) || 380;
          if (finalSecondsParsed === null) {
            return new Response(JSON.stringify({ success: false, error: 'กรุณาระบุเวลาบินจริง (วินาที) ให้ถูกต้องก่อนตัดสินผล' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          const finalSeconds = finalSecondsParsed;

          // A retry after a partial failure settles the rest of the SAME rocket,
          // so it must use the flight time and range the first attempt paid on.
          // A different time would settle one rocket on two results.
          const lockStr = await state(env).get('ACTIVE_ROUND');
          const lockRound = lockStr ? JSON.parse(lockStr) : null;
          const prior = lockRound?.partialSettlement;
          if (prior && prior.roundId === (lockRound.roundId ?? null) && prior.finalSeconds !== undefined
            && (prior.finalSeconds !== finalSeconds || prior.tMin !== tMin || prior.tMax !== tMax)) {
            return settleRetryRefusal(
              `รอบนี้จ่ายไปแล้ว ${(prior.orderNumbers || []).length} แผลที่เวลาบิน ${prior.finalSeconds} วิ (ช่าง ${prior.tMin}–${prior.tMax}) — ตัดสินผลซ้ำต้องใช้ค่าเดิม`,
              prior.finalSeconds,
              corsHeaders
            );
          }

          // Lock the round first, so no order can be opened or matched while
          // this flight time is being applied.
          if (lockRound && lockRound.status === 'ACTIVE') {
            await state(env).put('ACTIVE_ROUND', JSON.stringify({ ...lockRound, status: 'CLOSED', updatedAt: Date.now() }));
          }

          // Pre-quote orders the admin never priced are cancelled and refunded FIRST.
          //
          // Order matters. cancelHeldPreQuoteOrders also sweeps the MATCHED
          // index, so running it after the matched list was read left the
          // snapshot holding orders that had just been refunded: the loser got
          // their stake back as if the round were void, and then settlement paid
          // the winner on top. Cancel first, then read what is left to settle.
          // (Settlement also re-checks each stored order atomically.)
          const { cancelledOrderNumbers } = await cancelHeldPreQuoteOrders(env, ctx);
          await clearAllPendingOrders(env, ctx);
          const voidedThisSettlement = new Set(cancelledOrderNumbers);

          const matchedOrders = await getMatchedOrdersList(env);
          const activeRoundStr = await state(env).get('ACTIVE_ROUND');
          const activeRound = activeRoundStr ? JSON.parse(activeRoundStr) : { name: 'บั้งไฟสด' };

          const { settled: resolvedOrders, failed: settleFailures } = await settleOrdersAtomically(
            matchedOrders, finalSeconds, tMin, tMax, env, ctx, voidedThisSettlement
          );

          // A partly-failed settlement stays CLOSED, not RESOLVED: a RESOLVED
          // round is what a new quote reopens, and the unsettled orders would
          // then settle on the next rocket's time. Retrying is safe.
          // Settled orders leave the matched list, so a retry cannot see the
          // ones an earlier attempt paid. Remember them on the round (keyed by
          // its roundId, since the round object is copied into the next rocket)
          // so the one group card sent at the end still lists every pair.
          const roundKey = activeRound.roundId ?? null;
          const earlier: string[] = activeRound.partialSettlement?.roundId === roundKey
            ? activeRound.partialSettlement.orderNumbers || []
            : [];
          const settledSoFar = [...earlier, ...resolvedOrders.map((o) => o.orderNumber)];

          activeRound.status = settleFailures.length > 0 ? 'CLOSED' : 'RESOLVED';
          activeRound.finalTime = finalSeconds;
          activeRound.updatedAt = Date.now();
          if (settleFailures.length > 0) {
            activeRound.partialSettlement = { roundId: roundKey, orderNumbers: [...new Set(settledSoFar)], finalSeconds, tMin, tMax };
          } else {
            delete activeRound.partialSettlement;
          }
          await state(env).put('ACTIVE_ROUND', JSON.stringify(activeRound));

          // The group hears the result once, when every pair is paid. A card
          // after a partial failure told the group the round was over while
          // some players were still unpaid, and the retry then sent a second.
          // The admin sees the failure in the console response below.
          const targets = settleFailures.length === 0 ? await resolveTargetGroupIds('ALL', env) : [];
          if (targets.length > 0) {
            const roundName = activeRound.name || 'บั้งไฟสด';
            const cardOrders = earlier.length > 0
              ? await roundSettledOrders(settledSoFar, resolvedOrders, env)
              : resolvedOrders;
            // Flight time and every pair's winner and loser, in one card.
            const settleFlex = generateSettlementFlex(roundName, finalSeconds, tMin, tMax, cardOrders);
            await Promise.all(targets.map((to) => pushToLine(to, settleFlex, env)));
          }

          result = {
            success: settleFailures.length === 0,
            resolvedCount: resolvedOrders.length,
            finalTime: finalSeconds,
            ...(settleFailures.length > 0 ? { error: `ตัดสินผลไม่สำเร็จ ${settleFailures.length} แผล — ยังไม่ประกาศผลในกลุ่ม กดตัดสินผลซ้ำได้อย่างปลอดภัย (แผลที่จ่ายแล้วจะไม่ถูกจ่ายซ้ำ)`, failed: settleFailures, ledgerFailure: true } : {}),
          };
        } else if (functionName === 'adminGetDailySummary' || functionName === 'adminBroadcastDailySummary') {
          // Daily duel summary, one card per rocket round. args: [day?, target?]
          const day = /^\d{4}-\d{2}-\d{2}$/.test(String(args[0] || '')) ? String(args[0]) : bangkokDay();
          const orders = await getDailySettledOrders(day, env);
          const flex = generateDailySummaryFlex(day, orders);
          if (functionName === 'adminGetDailySummary') {
            result = { success: true, day, count: orders.length, orders: orders.map(formatOrderForDashboard), flex };
          } else {
            const targets = await resolveTargetGroupIds(args[1] || 'ALL', env);
            if (targets.length === 0) {
              result = { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ' };
            } else {
              const sendResults = await Promise.all(targets.map((to) => pushToLine(to, flex, env)));
              const allSuccess = sendResults.every((r) => r.success);
              const quotaError = sendResults.find((r) => r.code === 429);
              await appendChatLog(env, {
                timestamp: formatTime(),
                userId: targets[0],
                displayName: 'ระบบ',
                sender: 'admin',
                text: `[📅 สรุปผลดวลประจำวัน ${day} (${orders.length} คู่)]`,
                type: 'flex',
              });
              result = {
                success: allSuccess,
                day,
                count: orders.length,
                targets,
                error: allSuccess ? undefined : (quotaError?.error || 'ส่งเข้าบางกลุ่มไม่สำเร็จ'),
                code: quotaError ? 429 : (allSuccess ? 200 : 400),
                isQuotaExhausted: !!quotaError,
                results: sendResults,
              };
            }
          }
        } else if (functionName === 'adminResolveInFlightRound') {
          const requestedRoundId = args[0] ? String(args[0]).trim() : '';
          const finalSecondsParsed = parseFlightSeconds(args[1]);
          const inFlightList = await getInFlightRounds(env);
          const targetRound = requestedRoundId
            ? inFlightList.find((r) => r.roundId === requestedRoundId)
            : inFlightList[0];

          if (finalSecondsParsed === null) {
            result = { success: false, error: 'กรุณาระบุเวลาบินจริง (วินาที) ให้ถูกต้องก่อนตัดสินผล' };
          } else if (!targetRound) {
            result = { success: false, error: 'ไม่พบรอบบั้งไฟที่กำลังลอยอยู่ในคิวตัดสินผล' };
          } else {
            const finalSeconds = finalSecondsParsed;
            const tMin = Number(targetRound.targetMin) || 330;
            const tMax = Number(targetRound.targetMax) || 380;

            // An unquoted pre-quote that somehow reached in-flight is refunded
            // to both sides instead of being settled (atomic, at most once).
            const storedOrders: Array<{ item: Order; stored: Order | null }> = [];
            for (const item of targetRound.matchedOrders || []) {
              if (!item || !item.orderNumber) continue;
              storedOrders.push({ item, stored: await getOrderRecord(item.orderNumber, env) });
            }

            // A retry after a partial failure must use the flight time the
            // earlier attempt paid on (the range is the parked round's, fixed).
            const paidAt = storedOrders.find(({ stored }) => stored?.status === 'settled' && Number(stored.finalTime) > 0);
            if (paidAt && Number(paidAt.stored!.finalTime) !== finalSeconds) {
              const lockedFinalTime = Number(paidAt.stored!.finalTime);
              const paidCount = storedOrders.filter(({ stored }) => stored?.status === 'settled').length;
              return settleRetryRefusal(
                `บั้งไฟ "${targetRound.name || 'บั้งไฟสด'}" จ่ายไปแล้ว ${paidCount} แผลที่เวลาบิน ${lockedFinalTime} วิ — ตัดสินผลซ้ำต้องใช้เวลาเดิม`,
                lockedFinalTime,
                corsHeaders
              );
            }

            const unquoted = new Set<string>();
            for (const { item, stored } of storedOrders) {
              if (stored && stored.betType === 'pre_quote' && !stored.offsetConfirmedAt && stored.status === 'matched') {
                unquoted.add(item.orderNumber);
                await refundOrderOnce(item, env, ctx, 'cancel_held_pre_quote', {
                  allowedStatuses: ['matched'],
                  expectFields: { betType: 'pre_quote' },
                  expectMissingFields: ['offsetConfirmedAt'],
                });
              }
            }

            const { settled: resolvedOrders, failed: settleFailures } = await settleOrdersAtomically(
              targetRound.matchedOrders || [], finalSeconds, tMin, tMax, env, ctx, unquoted
            );

            // Remove the parked round only once every order is settled. Doing
            // it first meant a failure part-way stranded the rest with their
            // stakes held and no round left to settle them from. A retry is
            // safe: settled orders are never paid twice.
            if (settleFailures.length === 0) await state(env).removeInFlight(targetRound.roundId);
            const remaining = await getInFlightRounds(env);

            // The group hears the result once, when every pair is paid (see
            // adminResolveBets). The parked round keeps its full order list,
            // so pairs paid by an earlier attempt are read back from it.
            const targets = settleFailures.length === 0 ? await resolveTargetGroupIds('ALL', env) : [];
            if (targets.length > 0) {
              const roundName = targetRound.name || 'บั้งไฟสด';
              const roundOrders = (targetRound.matchedOrders || [])
                .map((o) => o?.orderNumber)
                .filter((n): n is string => !!n && !unquoted.has(n));
              const cardOrders = await roundSettledOrders(roundOrders, resolvedOrders, env);
              // Flight time and every pair's winner and loser, in one card.
              const settleFlex = generateSettlementFlex(roundName, finalSeconds, tMin, tMax, cardOrders);
              await Promise.all(targets.map((to) => pushToLine(to, settleFlex, env)));
            }

            result = {
              success: settleFailures.length === 0,
              roundId: targetRound.roundId,
              roundName: targetRound.name,
              resolvedCount: resolvedOrders.length,
              finalTime: finalSeconds,
              inFlightRounds: remaining,
              ...(settleFailures.length > 0 ? { error: `ตัดสินผลไม่สำเร็จ ${settleFailures.length} แผล — ยังไม่ประกาศผลในกลุ่ม กดตัดสินผลซ้ำได้อย่างปลอดภัย`, failed: settleFailures, ledgerFailure: true } : {}),
            };
          }
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
        } else if (functionName === 'adminInspectClaim') {
          // Read-only view of a refund claim, for reconciling a disputed refund.
          // The claim is the authoritative record of WHICH path paid an order and
          // how much, which is the only way to tell a double refund from a
          // legitimate one paid on two different orders.
          const isSuperAdmin = adminRole === 'superadmin';
          if (!isSuperAdmin) {
            result = { error: 'Forbidden: เฉพาะ Super Admin เท่านั้น' };
          } else {
            const orderNo = String(args[0] || '').trim().replace(/^#/, '');
            const rec = orderNo ? await getOrderRecord(orderNo, env) : null;
            const raw = rec ? JSON.stringify(rec) : null;
            if (!raw) {
              result = { found: false, orderNumber: orderNo };
            } else {
              const o = JSON.parse(raw) as Order;
              const key = `${o.orderNumber}@${Number(o.createdAt) || 0}`;
              const payload = await state(env).getClaim(`REFUND:${key}`);
              result = {
                found: Boolean(payload),
                claimKey: `REFUND:${key}`,
                // StateStore.getClaim already parses the stored JSON.
                claim: payload ?? null,
              };
            }
          }
        } else if (functionName === 'adminListOrders') {
          // Read-only sweep of KV_ORDERS, for investigating a disputed balance.
          // KV list is eventually consistent and slow, which is why it is not on
          // any hot path — but for a one-off audit it is the only way to see
          // orders that are no longer in the pending or matched indexes.
          const isSuperAdmin = adminRole === 'superadmin';
          if (!isSuperAdmin) {
            result = { error: 'Forbidden: เฉพาะ Super Admin เท่านั้น' };
          } else {
            const scan = await env.KV_ORDERS.list({ prefix: 'ORDER_' });
            const rows: any[] = [];
            for (const k of scan.keys || []) {
              const raw = await env.KV_ORDERS.get(k.name);
              if (!raw) continue;
              try {
                const o = JSON.parse(raw) as Order;
                rows.push({
                  orderNumber: o.orderNumber,
                  status: o.status,
                  amount: o.amount,
                  side: o.side,
                  creatorId: o.creatorId,
                  creatorName: o.creatorName,
                  matcherId: o.matcherId ?? null,
                  matcherName: o.matcherName ?? null,
                  commission: o.commission ?? null,
                  payout: o.payout ?? null,
                  parentOrderNumber: o.parentOrderNumber ?? null,
                  selfMatch: o.creatorId && o.matcherId ? o.creatorId === o.matcherId : false,
                  createdAt: o.createdAt,
                });
              } catch (_) {}
            }
            rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            // Cross-check the pending index against KV_ORDERS. An order the
            // board advertises as open but whose record reads back as
            // cancelled is exactly the state that makes a player tapping the
            // board get told the order was cancelled.
            let pendingRaw: string | null = null;
            try { pendingRaw = await state(env).get('PENDING_ORDERS_LIST'); } catch (_) {}
            const pendingIndex: any[] = pendingRaw ? JSON.parse(pendingRaw) : [];
            const byNo = new Map(rows.map((r) => [r.orderNumber, r]));
            const inconsistencies = pendingIndex.map((p: any) => {
              const kv = byNo.get(p.orderNumber);
              return {
                orderNumber: p.orderNumber,
                indexStatus: p.status,
                indexAmount: p.amount,
                kvStatus: kv ? kv.status : 'MISSING_FROM_KV',
                kvAmount: kv ? kv.amount : null,
                kvCreatedAt: kv ? kv.createdAt : null,
                indexCreatedAt: p.createdAt,
                agrees: kv && kv.status === p.status,
              };
            });

            result = {
              count: rows.length,
              truncated: scan.list_complete === false,
              orders: rows,
              pendingIndexSize: pendingIndex.length,
              pendingInconsistencies: inconsistencies.filter((x) => !x.agrees),
              pendingCrossCheck: inconsistencies,
            };
          }
        } else if (functionName === 'adminInspectOrder') {
          // Read-only single-order lookup, for investigating a disputed balance.
          //
          // Balance bugs are very hard to reason about from the outside: the
          // symptom is a number, and every plausible cause — a double refund,
          // a self-match, a second order for the same stake — produces the
          // same number. Guessing between them burns more time than one
          // endpoint does. Super Admin only because it exposes player IDs.
          const isSuperAdmin = adminRole === 'superadmin';
          if (!isSuperAdmin) {
            result = { error: 'Forbidden: เฉพาะ Super Admin เท่านั้น' };
          } else {
            const orderNo = String(args[0] || '').trim().replace(/^#/, '');
            const rec = orderNo ? await getOrderRecord(orderNo, env) : null;
            const raw = rec ? JSON.stringify(rec) : null;
            if (!raw) {
              result = { found: false, orderNumber: orderNo };
            } else {
              const o = JSON.parse(raw) as Order;
              result = {
                found: true,
                order: {
                  orderNumber: o.orderNumber,
                  status: o.status,
                  amount: o.amount,
                  side: o.side,
                  betType: o.betType,
                  rangeMin: o.rangeMin,
                  rangeMax: o.rangeMax,
                  creatorId: o.creatorId,
                  creatorName: o.creatorName,
                  matcherId: o.matcherId ?? null,
                  matcherName: o.matcherName ?? null,
                  playerLowId: o.playerLowId ?? null,
                  playerHighId: o.playerHighId ?? null,
                  winnerSide: o.winnerSide ?? null,
                  winnerName: o.winnerName ?? null,
                  grossWinAmount: o.grossWinAmount ?? null,
                  commission: o.commission ?? null,
                  payout: o.payout ?? null,
                  parentOrderNumber: o.parentOrderNumber ?? null,
                  createdAt: o.createdAt,
                  matchedAt: o.matchedAt ?? null,
                  settledAt: o.settledAt ?? null,
                  groupId: o.groupId ?? null,
                },
                // The one thing that decides whether a void overpaid: was the
                // creator also the matcher? Both being refunded is correct for
                // two distinct players, and a double refund for one.
                selfMatch: o.creatorId && o.matcherId ? o.creatorId === o.matcherId : false,
              };
            }
          }
        } else if (functionName === 'adminResetTestData' && (adminRole !== 'superadmin' || env.ENVIRONMENT === 'production')) {
          // A test fixture: it overwrites one real player's balance to 1900 and
          // blanks the pending board (stranding every pending stake). It must
          // never be reachable on the live platform.
          result = { success: false, error: 'Forbidden: adminResetTestData ใช้ได้เฉพาะสภาพแวดล้อมทดสอบ (Super Admin) เท่านั้น' };
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

        // A money operation the ledger refused or only partly applied must
        // surface as an error: the console treats any 200 as success and would
        // otherwise show a green toast for a settlement that did not finish.
        if (result && typeof result === 'object' && (result as any).ledgerFailure) {
          return new Response(JSON.stringify({ success: false, error: (result as any).error, data: result }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
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
