You are an expert Backend Developer specializing in High-Concurrency Node.js applications, LINE Messaging API, and Google Cloud Firestore.

We are refactoring an existing Bang Fai (Rocket) betting/order-matching platform from a legacy Google Apps Script (GAS) + Google Sheets system into a high-performance Node.js + Express + TypeScript app designed to handle 3-5 requests/sec.

Please perform the following steps sequentially:

---

### PHASE 1: Legacy Code Audit & Analysis
1. Read and analyze the legacy Google Apps Script code located in `./legacy/code.gs`.
2. Map out all core business logic, including:
   - Command triggers and user flows
   - Flex Message generation and order creation parameters
   - Read/Write logic previously handled by Google Sheets
3. Identify all order statuses, parameters, and matching conditions.

---

### PHASE 2: Project Setup & Architecture Structure
Set up the TypeScript project structure in `./src/`:
1. Create or update `package.json` with required production dependencies:
   - `@line/bot-sdk`
   - `express`
   - `@google-cloud/firestore`
   - `dotenv`
   - `node-cache`
2. Create `.env.example` containing:
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `GOOGLE_APPLICATION_CREDENTIALS`
   - `PORT=8080`
3. Set up the Express entry point in `src/index.ts` with LINE signature verification middleware.

---

### PHASE 3: Firestore Database & Order Matching Service
Implement database operations in `src/services/firestoreService.ts` using `@google-cloud/firestore`:
1. Initialize Firestore using `GOOGLE_APPLICATION_CREDENTIALS`.
2. Implement `createOrder(orderData)` to save new betting orders with status `'OPEN'`.
3. Implement `matchOrderTransaction(orderId, userId)` using **Firestore Transactions (Atomic Locks)**:
   - Retrieve order inside the transaction.
   - If status is `'OPEN'`, update status to `'MATCHED'`, set `matchedUserId`, and return success.
   - If status is already `'MATCHED'`, throw an error to prevent race conditions when multiple users click the Postback button simultaneously.

---

### PHASE 4: Flex Message & Webhook Event Handlers
1. Create `src/services/flexOrderService.ts`:
   - Implement `generateOrderFlex(orderData)` to create dynamic LINE Flex Messages for open orders.
   - Add a Postback button with `data: action=match_order&order_id={id}&amount={amount}`.
2. Implement LINE Webhook routes in `src/routes/webhook.ts` and event handlers in `src/handlers/postbackHandler.ts`:
   - Process Postback actions for `action=match_order` via `matchOrderTransaction()`.
   - Send immediate success/failure Flex Messages based on the transaction result.
   - Ensure the webhook responds with HTTP 200 OK within 200ms to avoid LINE timeouts.

---

### PHASE 5: Production Readiness & Containerization
1. Create a multi-stage `Dockerfile` using `node:18-alpine` exposing port 8080.
2. Create `.dockerignore` ignoring `node_modules`, `.env`, and `./legacy/`.
3. Provide a summary of implemented files and instructions on how to test the app locally using ngrok.

---

### PHASE 6: Version Control & Git Automation
1. Do NOT delete or modify any files inside the `./legacy/` directory.
2. Review `git status` to ensure all newly created Node.js/TypeScript code is placed under `./src/`.
3. Ensure sensitive files (such as `service-account.json`, `.env`, and `node_modules/`) are added to `.gitignore`.
4. Run `git add .` to stage the changes.
5. Create a git commit with a clear message: `feat: refactor GAS to Node.js for high concurrency bangfai app`.
6. Push the current branch to GitHub (`git push origin <current-branch-name>`).