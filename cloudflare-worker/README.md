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

## Financial ledger local verification and operator-managed setup

The financial coordinator is authoritative for balances, transactions, orders, and
round state. Google Sheets is a projection only. GAS no longer accepts LINE
webhooks or direct financial writes; its dashboard RPC proxy requires a Worker
login and forwards the resulting bearer token. Do not restore GAS as a second
financial executor.

Run the policy and coordinator checks locally from the repository root:

```bash
npm run test:gas-policy
cd cloudflare-worker
npm test -- test/financial-worker.test.ts test/financial-coordinator.test.ts
npm run build
```

These checks use local test credentials and mocked services. They do not deploy
Workers, call live GAS/Sheets endpoints, change Script Properties, or rotate
secrets.

The final local coordinator load check runs 100 create-player finance operations
in five batches of 20 (the required 20 operations/second target):

```bash
npm test -- test/coordinator-load.test.ts
```

The verified local test-pool result was 24.57 measured operations/second with a
30 ms p95 operation latency. All 100 player accounts and 100 unique opening
ledger entries were present; total account balance and total ledger delta both
equalled 10,000 hundredths. This is a local performance check only and is not a
production capacity guarantee.

### Required configuration names

Set values only through operator-managed secret/configuration stores; this
repository intentionally documents names, not values.

| Runtime | Property / binding | Purpose |
| --- | --- | --- |
| GAS Script Properties | `WORKER_API_URL` | HTTPS Worker `/api/run` endpoint used by the dashboard proxy |
| GAS Script Properties | `PROJECTION_API_KEY` | Dedicated credential for authenticated Worker-to-GAS projection delivery |
| Worker secret | `PROJECTION_API_KEY` | Must match the GAS projection property; never reuse an admin, browser, or LINE credential |
| Worker variable | `GAS_PROJECTION_URL` | GAS projection endpoint used by the durable outbox |
| Worker secrets | `ADMIN_API_KEY`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | Worker authentication and LINE webhook/messaging operations |
| Worker secret | `SLIP_API_KEY` | Slip-provider integration, if that feature is enabled |
| GAS Script Properties | `LINE_CHANNEL_ACCESS_TOKEN`, `SLIP_API_KEY` | Legacy GAS helpers only; not used to authorize Worker RPCs or projection delivery |

Missing required GAS Script Properties fail explicitly. The Worker rejects
administrative login when its required admin credential is not configured.
Never add credential values, local exports, or generated deployment settings to
source control.

### Operator-controlled rotation, import, and activation

This task does not configure live resources or perform credential rotation,
ledger import, or authority activation. An authorized operator must schedule
those actions separately:

1. Manage credentials outside the repository. For projection-key rotation,
   update the Worker secret and GAS Script Property to the same newly generated
   value. The outbox retries transient mismatches with bounded backoff; confirm
   pending projections drain before closing the change.
2. Rotate admin, LINE, and slip-provider credentials through their owning
   consoles and update only the corresponding runtime secret stores. Do not
   reuse the projection key.
3. Before any ledger import or authority activation, pause financial writes and
   reconcile the source export against the coordinator schema. The coordinator
   remains fail-closed (`AUTHORITY_NOT_READY`) until an operator explicitly
   activates a verified import.

#### Local migration procedure

The migration tool is local-first and defaults to a side-effect-free dry run.
It never chooses a Worker URL implicitly:

```bash
cd cloudflare-worker
node scripts/financial-migration.mjs ./path/to/snapshot.json --dry-run
# `--dry-run` may be omitted; it is the default.
```

The snapshot must declare `schemaVersion: "financial-ledger-v1"`, a unique
`snapshotId`, complete `accounts`, `transactions`, `rounds`, and `orders`
arrays, and matching `reconciliation` counts and hundredths total. Decimal
source balances are accepted only when exactly representable in hundredths;
values with unsafe precision are reported as conflicts and are never
truncated. A coordinator export includes the `__house__` account; its balance
is imported with the same provenance-tagged immutable opening entry as player
balances, and activation reconciles account totals against ledger totals. The
preview checks duplicate IDs (including existing LINE user IDs), references,
statuses, balances, schema shape, and totals without changing SQLite rows.

After the source reconciliation and dry-run report have been reviewed, an
authorized operator may apply the snapshot only with all three explicit
inputs:

```bash
export ROCKET_ADMIN_SESSION='<short-lived signed admin session>'
node scripts/financial-migration.mjs ./path/to/snapshot.json \
  --apply --url 'https://<explicit-worker-host>'
```

`--apply` first calls the authenticated Worker `/api/run` preview, then
performs a durable, bounded, restartable chunked import, and requires explicit
activation confirmation. Repeating an import resumes committed cursors without
duplicate rows or ledger entries; activation remains blocked while the import
status is incomplete. Opening ledger entries retain the source provenance.
Verify the reported account/order/transaction/round totals, schema checks, and
ledger reconciliation, and confirm that no conflicts remain before activation.
Only after that verification should the operator activate authority and route
traffic to the Worker. Never put session tokens or snapshot data in source
control, and do not substitute a production URL, KV namespace, Durable Object,
Sheets endpoint, or GAS endpoint for the local dry run.

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
