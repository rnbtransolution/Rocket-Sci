# Admin Flex delivery and transaction integrity

## Goal

Make player-facing communication Thai-first and consistent, ensure every admin-originated message is delivered as a Flex message, and prevent locked credits from being lost when a pre-quote bet is cancelled or a round is voided.

## Scope

The Node backend (`lineBot.js`, `db.js`, `server.js`) and the Google Apps Script backend (`google-apps-script/Code.gs`) must implement the same delivery and settlement rules. The dashboard source must stop constructing one-off raw admin announcements where a standard card is required.

## Messaging contract

1. A Flex payload is forwarded unchanged, except that the transport supplies a meaningful Thai-first `altText` extracted from the card title or a stable fallback.
2. A non-empty admin text message is converted into the standard announcement Flex card before a direct send or an `ALL` broadcast.
3. Known private-service keywords (`เมนู`, `เช็คยอด`, `ฝากเงิน`, `ถอนเงิน`) continue to produce their specialised cards for a direct player message. They must never expose a player's private data in a group broadcast.
4. Every generated card uses Thai-first title, body, and actions; essential operational labels may remain English (`Order #`, `pt`).
5. Standard card tone is factual and courteous: one clear status, relevant details, then an explicit next action where one exists. It avoids alarmist wording and unnecessary emojis.
6. Transport logging records the resolved message kind and title rather than the unstructured source text alone.

## Standard announcement card

Both runtimes receive equivalent helpers to:

- create a compact `bubble` with a consistent header, body, and optional footer;
- map a status tone (`info`, `success`, `warning`, `danger`) to the shared colors;
- derive safe `altText` from the title, including bubble and carousel payloads; and
- resolve an admin message into either a specialised private-service card, an existing Flex card, or a standard announcement card.

The delivery functions call the resolver before both direct and multi-group dispatch. This removes the current `ALL` path bypass that sends raw text.

## Transaction invariants

For an unquoted pre-quote bet:

- A `pending_match` bet has one locked stake and refunds exactly that one stake when cancelled.
- A `pre_quote_matched` bet has two locked stakes and refunds both players exactly once when cancelled.
- Status is captured before it changes to `cancelled`; cancelled, resolved, and voided bets are never refunded again.
- Closing a round and voiding a round use the same eligible-status definition in Node and GAS.
- Persistence of balances and bet status completes before the operation reports success or sends a cancellation notification.

## Implementation boundaries

- `lineBot.js` owns Node Flex construction, message resolution, delivery metadata, and logging labels.
- `google-apps-script/Code.gs` contains functionally equivalent Apps Script helpers and the matching cancellation flow.
- `db.js` owns Node credit mutations and pre-quote cancellation/void settlement.
- `App.jsx` sends intent and uses shared admin commands; it does not build bespoke operational announcement payloads where a backend factory is available.
- Tests exercise the resolver and the pre-quote refund state transitions without contacting LINE, Google Sheets, or production data.

## Verification and delivery

Run focused automated tests for direct and `ALL` admin sends, title-derived `altText`, one- and two-party refunds, idempotency, and void eligibility. Then run lint, the Vite production build, and a static Flex-payload audit. Copy all changed deployable files to `/Users/ittmacair/Desktop/Rocket_Sci_Upload` and run `clasp push` from `google-apps-script` only after verification passes.
