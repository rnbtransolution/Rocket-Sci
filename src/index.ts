import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { middleware, messagingApi } from '@line/bot-sdk';
import { createWebhookRouter } from './routes/webhook.js';
import { createAdminRouter, handleAdminRpc } from './routes/admin.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// 1. CORS Configuration (placed before any route handlers)
// Allows requests from Admin Web Portal (https://rnbtransolution.github.io) and local dev environments
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Reflect incoming origin or allow '*' so browser credentials and preflight work seamlessly
    callback(null, origin || true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'X-Requested-With', 'x-admin-api-key'],
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options('{*path}', cors(corsOptions));

// 2. Request Logger Middleware
app.use((req: Request, res: Response, next: () => void) => {
  const start = Date.now();
  const origin = req.headers.origin || 'direct/unknown';
  console.log(`[HTTP ${req.method}] ${req.originalUrl || req.url} | Origin: ${origin}`);
  res.on('finish', () => {
    console.log(`[HTTP ${req.method}] ${req.originalUrl || req.url} -> Status: ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const channelSecret = process.env.LINE_CHANNEL_SECRET || '';

if (!channelAccessToken) {
  console.warn('[Server] Warning: LINE_CHANNEL_ACCESS_TOKEN is not set');
}

// 3. Initialize LINE Messaging API Client
const messagingClient = new messagingApi.MessagingApiClient({
  channelAccessToken,
});

// 4. LINE Middleware Configuration (Signature Validation)
const lineConfig = {
  channelAccessToken,
  channelSecret,
};

// 5. Mount LINE Webhook with strict signature verification
// Note: Must be mounted BEFORE express.json() to preserve raw body buffer for HMAC-SHA256 signature check
if (channelSecret) {
  app.use('/webhook', middleware(lineConfig), createWebhookRouter(messagingClient));
} else {
  console.warn('[Server] LINE_CHANNEL_SECRET not provided: bypassing signature validation for development');
  app.use('/webhook', express.json(), createWebhookRouter(messagingClient));
}

// 6. Standard body parser for non-webhook REST endpoints
app.use(express.json());

// 7. Mount Admin API Router (Push order, active group discovery)
app.use('/api/admin', createAdminRouter(messagingClient));

// 8. Mount Universal RPC Endpoint (for React Dashboard compatibility with /api/run)
app.post('/api/run', handleAdminRpc(messagingClient));

// 8. Health Check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'bangfai-node-service',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// 9. Root info endpoint
app.get('/', (_req: Request, res: Response) => {
  res.send('🚀 Bang Fai High-Concurrency Node.js Backend is running!');
});

// Start listening
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Bang Fai Node.js Service listening on port ${PORT}`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`📡 Admin API:        http://localhost:${PORT}/api/admin`);
  console.log(`🏥 Health check:     http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
