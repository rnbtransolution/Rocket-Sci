import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as db from './db.js';
import * as lineBot from './lineBot.js';
import { getCacheStats, isWriteQueueBusy } from './sheetsHelper.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const READ_ONLY_RPC = new Set(['getDashboardData', 'verifyMockSlipFromClient']);

if (!ADMIN_API_KEY) {
  console.warn('[Auth] ADMIN_API_KEY is not set — mutating /api/run calls will be rejected.');
}
if (!LINE_CHANNEL_SECRET) {
  console.warn('[Auth] LINE_CHANNEL_SECRET is not set — webhook signature checks are disabled (set it ASAP).');
}

// ─── SSE: Real-time push to connected dashboard clients ───────────────────────
const sseClients = new Set();
let broadcastTimer = null;

/**
 * Broadcast the latest dashboard snapshot to all connected SSE clients.
 * Called immediately after any DB mutation (webhook event, admin action).
 */
function broadcastUpdate() {
  const data = db.getDashboardData();
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

/**
 * Debounced SSE broadcast: ensures multiple rapid mutations (e.g. webhook batch events)
 * coalesce into a single payload serialization and push, avoiding event-loop blocking.
 */
function scheduleBroadcastUpdate(delay = 80) {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastUpdate();
  }, delay);
}
// ──────────────────────────────────────────────────────────────────────────────

// CORS: allow dashboard hosts (local Vite + GitHub Pages + same-origin)
const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3001',
  'https://rnbtransolution.github.io',
  'https://rocket-sci.onrender.com',
]);
if (process.env.APP_URL) {
  try { allowedOrigins.add(new URL(process.env.APP_URL).origin); } catch (_) {}
}

app.use(cors({
  origin: (origin, cb) => cb(null, origin || true),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'X-Requested-With', 'x-admin-api-key'],
  credentials: true,
  optionsSuccessStatus: 200,
}));

// Capture raw body for LINE signature verification
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

function requireAdminApiKey(req, res, next) {
  const functionName = req.body?.functionName;
  if (READ_ONLY_RPC.has(functionName)) return next();
  if (!ADMIN_API_KEY) {
    return res.status(503).json({ success: false, reason: 'SERVER_MISCONFIGURED', error: 'Server ADMIN_API_KEY is not configured' });
  }
  const provided =
    req.get('x-admin-key') ||
    req.get('x-admin-api-key') ||
    req.body?.adminKey ||
    req.body?.apiKey ||
    req.query?.adminKey ||
    req.query?.apiKey ||
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
    '';
  if (provided !== ADMIN_API_KEY) {
    console.warn(`[Admin Auth] Rejected unauthorized call to ${req.originalUrl || req.path}`);
    return res.status(401).json({ success: false, reason: 'INVALID_ADMIN_KEY', error: 'Unauthorized: Missing or invalid adminKey' });
  }
  return next();
}

function verifyLineSignature(req) {
  if (!LINE_CHANNEL_SECRET) return true; // soft-open until secret is configured
  const signature = req.get('x-line-signature');
  if (!signature || !req.rawBody) return false;
  const digest = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch (_) {
    return false;
  }
}

// Logger middleware
app.use((req, res, next) => {
  if (req.path !== '/api/run' || req.body?.functionName !== 'getDashboardData') {
    console.log(`[HTTP] ${req.method} ${req.path}`, req.body?.functionName || '');
  }
  next();
});

// Admin API - Get Active Groups
app.get('/api/admin/groups', requireAdminApiKey, (req, res) => {
  const dash = db.getDashboardData();
  const groups = (dash?.lineGroups || []).map(g => ({
    groupId: g.id,
    groupName: g.name,
    lastActiveAt: new Date().toISOString(),
    isActive: true,
  }));
  res.json({ success: true, count: groups.length, groups });
});

// Admin API - Push Order
app.post('/api/admin/push-order', requireAdminApiKey, async (req, res) => {
  try {
    const { targetGroupId, orderData } = req.body || {};
    if (!orderData || typeof orderData !== 'object') {
      return res.status(400).json({ success: false, reason: 'MISSING_ORDER_DATA', error: 'Missing required orderData object' });
    }
    const rocketName = (orderData.rocketName || 'ค่ายบั้งไฟพญานาค').trim();
    const predictionType = (orderData.predictionType || 'สูง').trim();
    const amount = parseInt(orderData.amount, 10) || 500;

    const dash = db.getDashboardData();
    const groups = dash?.lineGroups || [];
    let targetId = targetGroupId;
    if (!targetId || targetId.trim() === '') {
      if (!groups.length) {
        return res.status(400).json({
          success: false,
          reason: 'NO_ACTIVE_GROUP_FOUND',
          error: 'No target group found. Please add the bot to a LINE group first.',
        });
      }
      targetId = groups[0].id;
    }

    try {
      const pushRes = await lineBot.adminBroadcastQuote(targetId, rocketName, 120, 150, false);
      res.json({
        success: true,
        message: `Order pushed to group ${targetId}`,
        targetGroupId: targetId,
        result: pushRes,
      });
    } catch (lineErr) {
      console.error('[Admin API] LINE push error:', lineErr);
      return res.status(502).json({
        success: false,
        reason: 'LINE_PUSH_FAILED',
        error: lineErr?.message || 'Failed to push message to LINE group',
      });
    }
  } catch (err) {
    console.error('[Admin API] Unexpected error:', err);
    res.status(500).json({ success: false, reason: 'INTERNAL_SERVER_ERROR', error: err.message });
  }
});

// RPC API Endpoint - maps React Dashboard remote calls (google.script.run emulation)
app.post('/api/run', requireAdminApiKey, async (req, res) => {
  const { functionName, args = [] } = req.body;
  
  try {
    let result;
    
    switch (functionName) {
      case 'getDashboardData':
        result = db.getDashboardData();
        break;
        
      case 'adminApproveTransaction':
        result = await db.adminApproveTransaction(args[0]);
        break;
        
      case 'adminRejectTransaction':
        result = await db.adminRejectTransaction(args[0], args[1]);
        break;
        
      case 'adminResolveBets':
        // Pass sendMatchResultPush callback to resolve bets and send push notifications
        // args: [finalTime, targetMin, targetMax]
        result = await db.adminResolveBets(args[0], args[1], args[2], lineBot.sendMatchResultPush);
        break;

      case 'adminVoidRound':
        result = await db.adminVoidRound();
        break;
        
      case 'adminRequestCancelBet':
        result = await db.adminRequestCancelBet(args[0]);
        break;
        
      case 'adminSetPlayerBank':
        result = await db.adminSetPlayerBank(args[0], args[1], args[2], args[3]);
        break;
        
      case 'adminCreatePlayer':
        result = await db.adminCreatePlayer(args[0], args[1], args[2]);
        break;
        
      case 'adminUpdatePlayerName':
        result = await db.adminUpdatePlayerName(args[0], args[1]);
        break;
        
      case 'adminSetPlayerBalance':
        result = await db.adminSetPlayerBalance(args[0], args[1]);
        break;
        
      case 'adminDeletePlayer':
        result = await db.adminDeletePlayer(args[0]);
        break;
        
      case 'saveOpenBet':
        result = await db.saveOpenBet(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9]);
        result = db.getDashboardData();
        break;

      case 'verifyMockSlipFromClient':
        result = db.verifyMockSlipFromClient(args[0], args[1], args[2], args[3], args[4]);
        break;
        
      case 'simulateTextMessageFromDashboard':
        // Run simulator text bot message with target group ID
        const targetGroup = args[3] || db.getActiveGroupId();
        const simMsgId = 'sim_' + Date.now();
        await lineBot.handleTextMessage(args[0], args[1], args[2], 'MOCK_REPLY_TOKEN', targetGroup, simMsgId);
        result = db.getDashboardData();
        break;
        
      case 'resetGoogleSheetsDatabase':
        result = await db.resetGoogleSheetsDatabase();
        break;
        
      case 'sendAdminMessageToLine':
        if (typeof args[1] === 'string') {
          const rangeMatch = args[1].match(/(\d{3})\s*[-/]\s*(\d{3})/);
          if (rangeMatch) {
            db.setTargetMinMax(Number(rangeMatch[1]), Number(rangeMatch[2]));
          }
        }
        result = await lineBot.sendAdminMessageToLine(args[0], args[1]);
        break;
        
      case 'adminOpenRound':
        result = db.setActiveRocketRound(args[0]);
        break;
        
      case 'adminBroadcastQuote':
        result = await lineBot.adminBroadcastQuote(args[0], args[1], args[2], args[3], args[4]);
        break;

      case 'adminBroadcastFinalCall':
        result = await lineBot.adminBroadcastFinalCall(args[0]);
        break;

      case 'adminBroadcastVoidRound':
        result = await lineBot.adminBroadcastVoidRound(args[0]);
        break;

      case 'adminBroadcastRuleGuide':
        result = await lineBot.adminBroadcastRuleGuide(args[0]);
        break;

      case 'adminBroadcastScamWarning':
        result = await lineBot.adminBroadcastScamWarning(args[0]);
        break;

      case 'adminSetActiveGroupId':
        result = db.saveActiveGroupId(args[0]);
        break;

      case 'adminDiscoverGroupIds':
        result = db.adminDiscoverGroupIds ? db.adminDiscoverGroupIds() : { activeGroupId: db.getActiveGroupId(), lineGroups: db.getDashboardData()?.lineGroups || [], discovered: [] };
        break;

      case 'adminTestPushGroupMessage':
        result = await lineBot.adminTestPushGroupMessage(args[0]);
        break;

      default:
        return res.status(404).json({ error: `Function "${functionName}" is not implemented on Node.js server.` });
    }
    
    // For mutating operations, push updated state to all SSE clients (debounced)
    if (!READ_ONLY_RPC.has(functionName)) {
      scheduleBroadcastUpdate(30);
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error(`Error executing "${functionName}":`, error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// SSE Endpoint - dashboard clients subscribe here for real-time push updates
app.get('/api/events', (req, res) => {
  const provided = req.get('x-admin-api-key') || req.query.apiKey || '';
  if (ADMIN_API_KEY && provided !== ADMIN_API_KEY) {
    // Allow unauthenticated SSE only for same-origin dashboard hosts; still require key when configured
    // EventSource cannot set headers — accept ?apiKey= for browser clients
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current snapshot immediately on connect
  const data = db.getDashboardData();
  res.write(`data: ${JSON.stringify(data)}\n\n`);

  sseClients.add(res);
  console.log(`[SSE] Client connected. Total clients: ${sseClients.size}`);

  // Heartbeat every 25s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected. Total clients: ${sseClients.size}`);
  });
});

// LINE OA Webhook Endpoint
app.post('/webhook', (req, res) => {
  if (!verifyLineSignature(req)) {
    console.warn('[Webhook] Rejected request with invalid or missing LINE signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 1. Respond with HTTP 200 immediately to LINE to prevent timeouts and retry storms
  res.status(200).json({ status: 'ok' });

  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return;
  }

  // 2. Process events sequentially to avoid same-bet / same-player race conditions
  setImmediate(async () => {
    try {
      for (const event of events) {
        try {
          await processSingleWebhookEvent(event);
        } catch (eventErr) {
          console.error('[Webhook] Error processing single event:', eventErr.message || eventErr);
        }
      }

      // 3. Consolidated SSE broadcast once after all events settle
      scheduleBroadcastUpdate();
    } catch (batchErr) {
      console.error('[Webhook] Critical error in background event batch:', batchErr);
    }
  });
});

/**
 * Process a single webhook event safely in isolation
 */
async function processSingleWebhookEvent(event) {
  const replyToken = event.replyToken;
  const source = event.source || {};
  const groupId = source.groupId || source.roomId || null;
  if (groupId) {
    db.saveActiveGroupId(groupId);
  }

  const userId = source.userId;
  const unsendMessageId = event.unsend?.messageId;
  const editMessageId = event.message?.id;
  const lookupMsgId = unsendMessageId || editMessageId;
  let cachedSender = null;
  if (lookupMsgId) {
    cachedSender = db.getCachedMessage(lookupMsgId);
  }

  const effectiveUserId = userId || (cachedSender ? cachedSender.userId : null);
  if (!effectiveUserId && event.type !== 'unsend' && event.type !== 'messageEdited') {
    return;
  }

  // Get Player profile display name from DB first (cached), fallback to API only if new player
  let displayName = effectiveUserId ? db.getPlayerNameFromDb(effectiveUserId) : null;
  if (!displayName && cachedSender && cachedSender.displayName) {
    displayName = cachedSender.displayName;
  }
  if (!displayName && effectiveUserId) {
    const profile = await lineBot.getLineUserProfile(effectiveUserId);
    displayName = profile ? profile.displayName : 'ผู้เล่นนิรนาม';
  }
  if (!displayName) {
    displayName = 'ผู้ใช้';
  }

  if (event.type === 'message') {
    const message = event.message;
    if (message.type === 'text') {
      await lineBot.handleTextMessage(message.text, effectiveUserId, displayName, replyToken, groupId, message.id);
    } else if (message.type === 'image') {
      await lineBot.handleImageSlipMessage(message.id, effectiveUserId, displayName, replyToken);
    }
  } else if (event.type === 'unsend') {
    await lineBot.handleUnsendMessage(unsendMessageId, effectiveUserId, displayName, groupId);
  } else if (event.type === 'messageEdited') {
    const newText = event.message?.text || '';
    await lineBot.handleMessageEdited(editMessageId, newText, effectiveUserId, displayName, groupId, replyToken);
  }
}

// Health check and metrics endpoint for uptime monitors and keep-alive pings
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    connectedClients: sseClients.size,
    memory: process.memoryUsage(),
    cache: getCacheStats(),
  });
});

// Serve frontend static build files
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback index.html route for client-side routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Server Initialization
async function startServer() {
  console.log('[Server] Initializing database from Google Sheets...');
  try {
    // Initial fetch bypasses cache to ensure fresh state on startup
    await db.init(false, true);

    // Background sync: synchronize local database cache with Google Sheets every 60 seconds
    // (mutations in the app already write to in-memory state and Google Sheets directly)
    setInterval(async () => {
      try {
        if (isWriteQueueBusy()) {
          console.log('[Sync] Skipped — write queue busy');
          return;
        }
        await db.init(true, true); // Sync quietly in the background
        scheduleBroadcastUpdate(); // Push any external Sheets-side changes to connected SSE clients
      } catch (syncErr) {
        console.error('[Sync] Error synchronizing local database from Google Sheets:', syncErr.message || syncErr);
      }
    }, 60000);

    // Lightweight keep-alive self-ping for free tier deployments (e.g. Render)
    if (process.env.KEEP_ALIVE === 'true' || process.env.RENDER) {
      const pingUrl = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/health` : `http://localhost:${PORT}/health`;
      console.log(`[Keep-Alive] Initialized self-ping service targeting ${pingUrl} (every 14m)`);
      setInterval(async () => {
        try {
          const pingRes = await fetch(pingUrl);
          if (pingRes.ok) {
            console.log(`[Keep-Alive] Ping successful at ${new Date().toISOString()}`);
          }
        } catch (pingErr) {
          console.warn(`[Keep-Alive] Ping failed:`, pingErr.message);
        }
      }, 14 * 60 * 1000); // 14 minutes
    }

    app.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(`⚡ Rocket Science Node.js Server is running!`);
      console.log(`🌐 Local URL: http://localhost:${PORT}`);
      console.log(`🩺 Health Check: http://localhost:${PORT}/health`);
      console.log(`🔗 Webhook Endpoint: http://<your-public-domain>:${PORT}/webhook`);
      console.log(`======================================================\n`);
    });
  } catch (err) {
    console.error('[Server] Critical Startup Error: Database initialization failed.', err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Fatal Uncaught Exception (restarting cleanly via PM2):', err);
  setTimeout(() => process.exit(1), 1000);
});

startServer();
