import { Env, LineWebhookPayload, QueueMessage } from './types.js';
import { verifyLineSignature } from './signature.js';
import { processLineEvent } from './queueHandler.js';

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
      // Process interactive LINE commands directly in fetch() so user gets sub-second response
      if (events.length > 0) {
        // 1. Direct interactive processing: executes order logic and dispatches reply/push immediately
        const interactiveProcessing = Promise.all(
          events.map(async (event) => {
            try {
              await processLineEvent(event, env, ctx);
            } catch (err) {
              console.error('[Worker] Event processing error:', err);
            }
          })
        );

        // 2. Queue offload: archive events to Queue in background for auditing/telemetry without slowing user
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

        // Await the interactive reply dispatch so the user sees the order card immediately
        await interactiveProcessing;
      }

      // Return HTTP 200 OK
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Universal Dashboard RPC Endpoint (/api/run) ──
    if (url.pathname === '/api/run' && request.method === 'POST') {
      const authHeader = request.headers.get('x-admin-key') || request.headers.get('x-admin-api-key');
      if (env.ADMIN_API_KEY && authHeader !== env.ADMIN_API_KEY) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      try {
        const body = (await request.json()) as any;
        const { functionName, args = [] } = body;

        let result: any = null;
        if (functionName === 'getDashboardData') {
          const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
          const activeGroupId = await env.KV_CACHE.get('ACTIVE_GROUP_ID');
          result = {
            activeGroupId: activeGroupId || '',
            activeRocketRound: roundStr ? JSON.parse(roundStr) : { name: 'บั้งไฟสด', targetMin: 330, targetMax: 380, status: 'ACTIVE' },
            serverTime: new Date().toISOString(),
          };
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
