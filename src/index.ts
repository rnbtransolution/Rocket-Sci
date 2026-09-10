import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { middleware, messagingApi } from '@line/bot-sdk';
import { createWebhookRouter } from './routes/webhook.js';
import { createAdminRouter } from './routes/admin.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// CORS configuration to enable Admin Dashboard access (https://rnbtransolution.github.io)
const allowedOrigins = [
  'https://rnbtransolution.github.io',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith('.github.io') ||
      origin.includes('localhost') ||
      origin.includes('127.0.0.1')
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-api-key'],
}));

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const channelSecret = process.env.LINE_CHANNEL_SECRET || '';

if (!channelAccessToken) {
  console.warn('[Server] Warning: LINE_CHANNEL_ACCESS_TOKEN is not set');
}

// 1. Initialize LINE Messaging API Client
const messagingClient = new messagingApi.MessagingApiClient({
  channelAccessToken,
});

// 2. LINE Middleware Configuration (Signature Validation)
const lineConfig = {
  channelAccessToken,
  channelSecret,
};

// 3. Mount LINE Webhook with strict signature verification
// Note: Must be mounted BEFORE express.json() to preserve raw body buffer for HMAC-SHA256 signature check
if (channelSecret) {
  app.use('/webhook', middleware(lineConfig), createWebhookRouter(messagingClient));
} else {
  console.warn('[Server] LINE_CHANNEL_SECRET not provided: bypassing signature validation for development');
  app.use('/webhook', express.json(), createWebhookRouter(messagingClient));
}

// 4. Standard body parser for non-webhook REST endpoints
app.use(express.json());

// 5. Mount Admin API Router (Push order, active group discovery)
app.use('/api/admin', createAdminRouter(messagingClient));

// 6. Health Check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'bangfai-node-service',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// 6. Root info endpoint
app.get('/', (_req: Request, res: Response) => {
  res.send('🚀 Bang Fai High-Concurrency Node.js Backend is running!');
});

// Start listening
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Bang Fai Node.js Service listening on port ${PORT}`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`🏥 Health check:     http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
