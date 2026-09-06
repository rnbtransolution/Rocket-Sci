# Admin Flex Delivery and Transaction Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every admin-originated message as a Thai-first Flex card and refund every locked pre-quote stake exactly once when a round closes or is voided.

**Architecture:** Each runtime receives the same three pure messaging helpers: standard announcement-card construction, title-derived alt text, and admin-message resolution. Node and GAS each add an explicit pre-quote cancellation transition that captures prior status, persists `cancelled`, then refunds the eligible players once.

**Tech Stack:** Node.js ESM, `node:test`, LINE Flex Message JSON, Google Apps Script, React/Vite, clasp.

**Spec:** `docs/superpowers/specs/2026-08-18-admin-flex-and-transaction-integrity-design.md`

## Global Constraints

- Player copy is Thai-first; `Order #` and `pt` are permitted technical labels.
- Every Flex payload has a non-empty Thai-first `altText` under 400 characters.
- Private balance, bank, and transaction data must never be sent to a group.
- `pending_match` pre-quotes refund one stake; `pre_quote_matched` refund two; a cancelled bet never refunds again.
- Do not modify bet rules, payout calculations, credentials, or unrelated worktree changes.
- Run `clasp push` only after test, lint, build, and Flex audit verification.

---

### Task 1: Add executable regression tests

**Files:**
- Modify: `package.json`
- Create: `test/lineBot.flex.test.js`
- Create: `test/db.preQuote.test.js`

**Interfaces:**
- Produces: `npm test` using Node's built-in test runner.
- Consumes: the pure helpers added in Tasks 2 and 3.

- [ ] **Step 1: Add the test command**

```json
"test": "node --test"
```

- [ ] **Step 2: Write Flex tests before implementation**

```js
test('wraps a raw announcement in a Thai-first Flex bubble', () => {
  const card = constructAdminAnnouncementFlex('แจ้งเตือนระบบ', 'กรุณาตรวจสอบรายการของคุณ', 'warning');
  assert.equal(card.type, 'bubble');
  assert.equal(card.header.contents[0].text, 'แจ้งเตือนระบบ');
});

test('derives the same title from a bubble and carousel', () => {
  const card = constructAdminAnnouncementFlex('ประกาศจากแอดมิน', 'ทดสอบ');
  assert.equal(getFlexAltText(card), 'ประกาศจากแอดมิน');
  assert.equal(getFlexAltText({ type: 'carousel', contents: [card] }), 'ประกาศจากแอดมิน');
});

test('keeps private balance data out of group messages', () => {
  const result = resolveAdminMessage('เช็คยอด', { isGroup: true });
  assert.equal(result.kind, 'announcement');
});
```

- [ ] **Step 3: Run red**

Run: `npm test -- test/lineBot.flex.test.js`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 4: Write pre-quote refund tests before implementation**

```js
test('returns one participant for pending_match', () => {
  assert.deepEqual(getPreQuoteRefundParticipants({ status: 'pending_match', playerLowId: 'low', playerHighId: '', amount: 200 }), [{ userId: 'low', amount: 200 }]);
});

test('returns both participants for pre_quote_matched', () => {
  assert.deepEqual(getPreQuoteRefundParticipants({ status: 'pre_quote_matched', playerLowId: 'low', playerHighId: 'high', amount: 200 }), [{ userId: 'low', amount: 200 }, { userId: 'high', amount: 200 }]);
});

test('returns no participant for a cancelled bet', () => {
  assert.deepEqual(getPreQuoteRefundParticipants({ status: 'cancelled', playerLowId: 'low', playerHighId: 'high', amount: 200 }), []);
});
```

- [ ] **Step 5: Run red**

Run: `npm test -- test/db.preQuote.test.js`

Expected: FAIL because `getPreQuoteRefundParticipants` does not exist.

### Task 2: Standardise Node admin delivery

**Files:**
- Modify: `lineBot.js:96-240,281-360`
- Modify: `server.js:121-129`
- Modify: `test/lineBot.flex.test.js`

**Interfaces:**
- Produces: `constructAdminAnnouncementFlex(title, body, tone)`, `getFlexAltText(contents)`, and `resolveAdminMessage(message, context)`.

- [ ] **Step 1: Implement the standard card factory**

```js
export function constructAdminAnnouncementFlex(title, body, tone = 'info') {
  const palette = { info: '#0369A1', success: '#047857', warning: '#B45309', danger: '#BE123C' };
  return {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: palette[tone] || palette.info, paddingAll: 'md', contents: [
      { type: 'text', text: title, weight: 'bold', color: '#FFFFFF', size: 'sm', wrap: true },
    ] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: [
      { type: 'text', text: body, color: '#1E293B', size: 'sm', wrap: true },
    ] },
  };
}
```

- [ ] **Step 2: Implement title extraction and resolution**

`getFlexAltText` inspects either a bubble or first carousel bubble, removes leading status emoji, and falls back to `ประกาศจาก Rocket Science`. `resolveAdminMessage` accepts `{ isGroup, playerName, balance, bank }`; it preserves Flex objects, uses current specialised private cards for direct keywords, returns a privacy notice for group keywords, and wraps every other text in `constructAdminAnnouncementFlex('ประกาศจากแอดมิน', text, tone)`.

- [ ] **Step 3: Route direct and `ALL` sends through the resolver**

Update `replyToLine`, `pushToLine`, `sendAdminMessageToLine`, and `broadcastToAllGroups`. Resolve once per destination, derive all alt text from `getFlexAltText`, and log resolved `kind` and title. Do not let the `ALL` path bypass resolution.

- [ ] **Step 4: Run green and edge tests**

Run: `npm test -- test/lineBot.flex.test.js`

Add tests for a raw warning, existing bubble, and carousel; assert all alt text is non-empty and under 400 characters. Run the command again; expected PASS.

### Task 3: Repair Node pre-quote cancellation and void settlement

**Files:**
- Modify: `db.js:89-118,1258-1287,1605-1615`
- Modify: `server.js:136-138`
- Modify: `test/db.preQuote.test.js`

**Interfaces:**
- Produces: `getPreQuoteRefundParticipants(bet)` and awaited close-round settlement.

- [ ] **Step 1: Implement the pure participant selector**

```js
export function getPreQuoteRefundParticipants(bet) {
  const amount = Number(bet?.amount) || 0;
  if (!amount || !['pending_match', 'pre_quote_matched'].includes(bet?.status)) return [];
  const ids = bet.status === 'pre_quote_matched' ? [bet.playerLowId, bet.playerHighId] : [bet.playerLowId || bet.playerHighId];
  return [...new Set(ids.filter(Boolean))].map(userId => ({ userId, amount }));
}
```

- [ ] **Step 2: Run the refund tests green**

Run: `npm test -- test/db.preQuote.test.js`

Expected: PASS for one-party, two-party, and cancelled cases.

- [ ] **Step 3: Make cancellation atomic at the application level**

Make `cancelUnquotedPreQuoteBets` async. For every eligible pre-quote, capture `previousStatus`, persist `cancelled`, then await one `adjustPlayerBalance` call per participant selected using `previousStatus`. Send the standard cancellation card only after refunds complete.

- [ ] **Step 4: Cover void and RPC paths**

Include `pre_quote_matched` in `adminVoidRound`. Make `setRocketRoundStatus` async, await cancellation on `CLOSED`, and await it in `server.js` and all async Node callers.

- [ ] **Step 5: Add idempotency coverage and run full tests**

Use injected persistence and balance spies in the test to cancel the same two-party pre-quote twice; assert each player receives one credit. Run: `npm test`. Expected: PASS without network traffic.

### Task 4: Mirror message and settlement contract in GAS

**Files:**
- Modify: `google-apps-script/Code.gs:1478-1515,2148-2245,3472-3545,3797-3800,1941-1985`

**Interfaces:**
- Produces: GAS equivalents of the Task 2 helpers plus `cancelUnquotedPreQuoteBets()`.

- [ ] **Step 1: Add ES5-compatible message helpers**

Add equivalent `constructAdminAnnouncementFlex`, `getFlexAltText`, and `resolveAdminMessage` helpers. Use exactly the Task 2 keyword, privacy, fallback-title, and tone rules.

- [ ] **Step 2: Route all GAS delivery paths through resolution**

Update `replyToLine`, `pushLineGroupMessage`, `pushToLine`, and `sendAdminMessageToLine`. Detect object payloads before normalising text so Flex objects never turn into `[object Object]` when evaluating round status.

- [ ] **Step 3: Add GAS pre-quote cancellation**

Read the Bets sheet, select `type === 'pre_quote'` plus statuses `pending_match` or `pre_quote_matched`, capture status, write `cancelled`, and credit the participant IDs selected by `getPreQuoteRefundParticipants`. Call the function from `setRocketRoundStatus('CLOSED')`.

- [ ] **Step 4: Repair void behavior and verify source**

Include `pre_quote_matched` in `adminVoidRound`, refund both sides, and replace its raw message with a standard danger announcement. Run:

```bash
node --check google-apps-script/Code.gs
rg -n "getFlexAltText|resolveAdminMessage|cancelUnquotedPreQuoteBets|pre_quote_matched" google-apps-script/Code.gs
```

Expected: parser exits 0 and every helper plus both settlement paths are found.

### Task 5: Make dashboard broadcasts express standard intent

**Files:**
- Modify: `App.jsx:2097-2152`

**Interfaces:**
- Consumes: backend support for `{ type: 'admin_announcement', title, body, tone }`.

- [ ] **Step 1: Confirm active source before editing**

`main.jsx` imports `./App.jsx`; leave duplicate `src/App.jsx` untouched unless the deployment configuration imports `src/main.jsx`.

- [ ] **Step 2: Replace the three raw broadcast strings**

Send structured intents for `คู่มือการเล่น` (`info`), `ปิดรับดวล` (`warning`), and `แจ้งเตือนความปลอดภัย` (`danger`). Both resolvers turn this intent into the standard announcement card; raw arbitrary text remains supported.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: exit 0.

### Task 6: Audit, verify, deploy, and package

**Files:**
- Modify: all matching `construct*Flex` functions in `lineBot.js` and `google-apps-script/Code.gs`
- Create: `scripts/audit-flex-payloads.mjs`
- Copy: changed deployable files to `/Users/ittmacair/Desktop/Rocket_Sci_Upload`

**Interfaces:**
- Produces: an executable Flex audit and a verified GitHub-upload bundle.

- [ ] **Step 1: Create the audit**

Import every Node `construct*Flex` function with safe fixtures. Recursively inspect bubble/carousel JSON and fail for no title, no body, empty text, alt text over 400 characters, or legacy non-Thai-first titles. Print `PASS <constructor> — <title>` for each card.

- [ ] **Step 2: Align all 16 constructor copies**

Use consistent vocabulary in Node and GAS: `เครดิตคงเหลือ`, `ยอดทำรายการ`, `ยืนยันรายการ`, `ยกเลิกรายการ`, `ผลรอบ`, `Order #`, and `pt`. Keep data fields and action payloads unchanged.

- [ ] **Step 3: Run verification**

```bash
npm test
npm run lint
npm run build
node scripts/audit-flex-payloads.mjs
node --check google-apps-script/Code.gs
git diff --check
```

Expected: test, build, audit, parse, and diff checks exit 0. Report existing lint failures separately without suppressing them.

- [ ] **Step 4: Create the upload bundle and deploy GAS**

Copy changed deployable files into `/Users/ittmacair/Desktop/Rocket_Sci_Upload`, create its `google-apps-script` subdirectory for `Code.gs`, `appsscript.json`, and `.clasp.json`, compare each copy with `cmp -s`, then run `clasp push` from `google-apps-script`. Record the exact clasp result.
