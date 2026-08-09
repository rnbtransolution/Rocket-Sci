import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.js';
import * as lineBot from './lineBot.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// ─── SSE: Real-time push to connected dashboard clients ───────────────────────
const sseClients = new Set();

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
// ──────────────────────────────────────────────────────────────────────────────

// CORS setup (useful for local Vite development running on port 5173)
app.use(cors());

// Body parser
app.use(express.json());

// Logger middleware
app.use((req, res, next) => {
  if (req.path !== '/api/run' || req.body?.functionName !== 'getDashboardData') {
    console.log(`[HTTP] ${req.method} ${req.path}`, req.body || '');
  }
  next();
});

// RPC API Endpoint - maps React Dashboard remote calls (google.script.run emulation)
app.post('/api/run', async (req, res) => {
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
        await lineBot.handleTextMessage(args[0], args[1], args[2], 'MOCK_REPLY_TOKEN', targetGroup);
        result = db.getDashboardData();
        break;
        
      case 'resetGoogleSheetsDatabase':
        result = await db.resetGoogleSheetsDatabase();
        break;
        
      case 'sendAdminMessageToLine':
        if (args[1]) {
          const rangeMatch = args[1].match(/(\d{3})\s*[-/]\s*(\d{3})/);
          if (rangeMatch) {
            db.setTargetMinMax(Number(rangeMatch[1]), Number(rangeMatch[2]));
          }
        }
        await lineBot.sendAdminMessageToLine(args[0], args[1]);
        result = db.getDashboardData();
        break;
        
      case 'adminOpenRound':
        result = db.setActiveRocketRound(args[0]);
        break;
        
      case 'setRocketRoundStatus':
        result = db.setRocketRoundStatus(args[0]);
        break;
        
      default:
        return res.status(404).json({ error: `Function "${functionName}" is not implemented on Node.js server.` });
    }
    
    // For mutating operations, immediately push updated state to all SSE clients
    const readOnlyFunctions = new Set(['getDashboardData', 'verifyMockSlipFromClient']);
    if (!readOnlyFunctions.has(functionName)) {
      broadcastUpdate();
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error(`Error executing "${functionName}":`, error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// SSE Endpoint - dashboard clients subscribe here for real-time push updates
app.get('/api/events', (req, res) => {
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
  // Respond immediately to LINE to prevent timeout and duplicate retries
  res.json({ status: 'ok' });

  // Process events in the background asynchronously
  const events = req.body.events || [];
  (async () => {
    for (const event of events) {
      try {
        const replyToken = event.replyToken;
        const source = event.source || {};
        const groupId = source.groupId || source.roomId || null;
        if (groupId) {
          db.saveActiveGroupId(groupId);
        }

        const userId = source.userId;
        if (!userId) {
          broadcastUpdate();
          continue;
        }
        
        // Get Player profile display name from DB first (cached), fallback to API only if new player
        let displayName = db.getPlayerNameFromDb(userId);
        if (!displayName) {
          const profile = await lineBot.getLineUserProfile(userId);
          displayName = profile ? profile.displayName : "ผู้เล่นนิรนาม";
        }
        
        if (event.type === 'message') {
          const message = event.message;
          if (message.type === 'text') {
            if (groupId) {
              db.recordGroupActivity(groupId, message.id, userId, displayName, message.text);
            }
            await lineBot.handleTextMessage(message.text, userId, displayName, replyToken, groupId, message.id);
          } else if (message.type === 'image') {
            await lineBot.handleImageSlipMessage(message.id, userId, displayName, replyToken);
          }
        } else if (event.type === 'unsend') {
          const unsendMessageId = event.unsend?.messageId;
          await lineBot.handleUnsendMessage(unsendMessageId, userId, displayName, groupId);
        }
        // Push update to all SSE dashboard clients immediately after each event
        broadcastUpdate();
      } catch (err) {
        console.error("Error processing event in webhook background:", err);
      }
    }
  })();
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
    await db.init();
    
    // Background polling: sync local database cache with Google Sheets every 2 seconds
    setInterval(async () => {
      try {
        await db.init(true); // Sync quietly in the background
        broadcastUpdate();   // Push any Sheets-side changes to connected SSE clients
      } catch (syncErr) {
        console.error('[Sync] Error synchronizing local database from Google Sheets:', syncErr);
      }
    }, 5000);

    app.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(`⚡ Rocket Science Node.js Server is running!`);
      console.log(`🌐 Local URL: http://localhost:${PORT}`);
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
  console.error('[Server] Uncaught Exception:', err);
});

startServer();
