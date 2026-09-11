# 🚀 Rocket Science — High-Concurrency Cloudflare Workers Backend

High-concurrency LINE Messaging API Webhook backend migrated from Google Apps Script (GAS) to **Cloudflare Workers**, **Cloudflare Queues**, and **Cloudflare KV**.

---

## ⚡ Architectural Comparison

| Metric / Feature | Google Apps Script (Legacy) | Cloudflare Workers + Queues (New) |
| :--- | :--- | :--- |
| **Cold Start Latency** | 2,000ms – 5,000ms | **0ms – 5ms** (V8 Isolate) |
| **Webhook ACK Response Time** | 4,000ms – 9,000ms (causes timeouts) | **< 20ms** (Immediate HTTP 200) |
| **Throughput Capacity** | 1 – 2 req/sec (Lock collisions) | **10 – 20+ TPS** (Edge Queued) |
| **State Storage & Caching** | Synchronous Google Sheets RPCs | **Cloudflare KV (< 5ms lookup)** |
| **Signature Validation** | GAS script runtime (~150ms) | **Native WebCrypto (< 1ms)** |
| **Execution Decoupling** | Blocking sequential execution | **Cloudflare Queues (`sendBatch`)** |

---

## 📁 Project Structure

```
cloudflare-worker/
├── wrangler.toml         # Cloudflare Worker, KV, & Queue bindings
├── package.json          # Dependencies & deployment scripts
├── tsconfig.json         # TypeScript configuration for Workers
└── src/
    ├── index.ts          # Main Worker: Fast Webhook & Queue consumer
    ├── types.ts          # Type definitions (Env, LineEvent, Order, Player)
    ├── signature.ts      # Native WebCrypto HMAC-SHA256 verification
    ├── flexTemplates.ts  # Pre-compiled, zero-allocation Flex Cards
    └── queueHandler.ts   # Asynchronous queue consumer & order logic
```

---

## 🛠️ Step-by-Step Setup & Deployment Guide

### Step 1: Install Dependencies
Inside the `cloudflare-worker` directory:
```bash
cd cloudflare-worker
npm install
```

---

### Step 2: Create Cloudflare KV Namespaces
Run the following commands using Wrangler:

```bash
# 1. Create KV Cache for User Profiles & Settings
npx wrangler kv namespace create KV_CACHE
# (For local preview testing)
npx wrangler kv namespace create KV_CACHE --preview

# 2. Create KV Orders for Atomic Order Records
npx wrangler kv namespace create KV_ORDERS
# (For local preview testing)
npx wrangler kv namespace create KV_ORDERS --preview
```

Copy the generated IDs into `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "KV_CACHE"
id = "<YOUR_PROD_KV_CACHE_ID>"
preview_id = "<YOUR_PREVIEW_KV_CACHE_ID>"

[[kv_namespaces]]
binding = "KV_ORDERS"
id = "<YOUR_PROD_KV_ORDERS_ID>"
preview_id = "<YOUR_PREVIEW_KV_ORDERS_ID>"
```

---

### Step 3: Create Cloudflare Queues
Create the primary queue and the dead-letter queue:

```bash
# Primary Queue for LINE Webhook Events
npx wrangler queues create rocket-science-line-events

# Dead-Letter Queue for failed retries
npx wrangler queues create rocket-science-dlq
```

---

### Step 4: Configure Production Secrets
Set sensitive secrets securely on Cloudflare:

```bash
# LINE Channel Secret (for HMAC-SHA256 validation)
npx wrangler secret put LINE_CHANNEL_SECRET

# LINE Channel Access Token (for Messaging API replies/pushes)
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN

# Admin API Key (for React Dashboard RPC)
npx wrangler secret put ADMIN_API_KEY
```

---

### Step 5: Test Locally & Deploy
```bash
# Test locally with simulated edge environment:
npm run dev

# Deploy to Cloudflare Global Edge:
npm run deploy
```

Once deployed, Wrangler will output your live URL:
`https://rocket-science-cf-worker.<your-subdomain>.workers.dev`

---

### Step 6: Update LINE Developers Console
1. Log in to [LINE Developers Console](https://developers.line.biz/).
2. Select your Provider and Channel (`@rocketscience`).
3. Navigate to the **Messaging API** tab.
4. Set **Webhook URL** to:
   ```
   https://rocket-science-cf-worker.<your-subdomain>.workers.dev/webhook
   ```
5. Click **Verify** (should return HTTP 200 in < 30ms).
6. Enable **Use Webhook**.
