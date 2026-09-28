import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';

const lineSecret = 'local-test-secret';
const adminKey = 'local-test-admin-key';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

async function adminRun(functionName: string, args: unknown[], requestId?: string) {
  return SELF.fetch('https://worker.test/api/run', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-key': adminKey,
    },
    body: JSON.stringify({ functionName, args, requestId }),
  });
}

async function signedWebhook(event: Record<string, unknown>) {
  const body = JSON.stringify({ events: [event] });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(lineSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return SELF.fetch('https://worker.test/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-line-signature': encoded,
    },
    body,
  });
}

it('routes LINE order, match, and retry flows through the coordinator', async () => {
  const lineCalls: Array<{ path: string; body: string }> = [];
  fetchMock
    .get('https://api.line.me')
    .intercept({ path: /.*/, method: 'POST' })
    .reply(({ path, body }) => {
      lineCalls.push({ path, body: String(body || '') });
      if (path.endsWith('/message/reply') && String(body).includes('expired-private-token')) {
        return { statusCode: 400, data: { message: 'Invalid reply token' } };
      }
      return { statusCode: 200, data: {} };
    })
    .persist();

  const creatorLineId = `U${crypto.randomUUID().replaceAll('-', '')}`;
  const matcherLineId = `U${crypto.randomUUID().replaceAll('-', '')}`;
  const creatorId = `PL${creatorLineId.slice(-6).toUpperCase()}`;
  const matcherId = `PL${matcherLineId.slice(-6).toUpperCase()}`;
  const groupId = `C${crypto.randomUUID().replaceAll('-', '')}`;

  for (const [lineId, name, requestId] of [
    [creatorLineId, 'Creator', 'worker-create-creator'],
    [matcherLineId, 'Matcher', 'worker-create-matcher'],
  ]) {
    const response = await adminRun('adminCreatePlayer', [lineId, name, 500], requestId);
    expect(response.status).toBe(200);
  }
  const openResponse = await adminRun('adminOpenRound', ['Worker Integration Round'], 'worker-open-round');
  expect(openResponse.status).toBe(200);

  const createEvent = {
    type: 'message',
    timestamp: Date.now(),
    webhookEventId: 'worker-order-event',
    replyToken: 'expired-group-token',
    source: { type: 'group', groupId, userId: creatorLineId },
    message: { id: 'worker-order-message', type: 'text', text: 'ถ100' },
  };
  expect((await signedWebhook(createEvent)).status).toBe(200);
  expect((await signedWebhook(createEvent)).status).toBe(200);

  const client = createCoordinatorClient(env);
  const creatorAfterOrder = await client.getAccount(creatorId);
  expect(creatorAfterOrder?.balanceHundredths).toBe(40_000);
  const pendingOrders = await client.getOrdersByStatus(['pending_hold']);
  expect(pendingOrders).toHaveLength(1);
  const orderNumber = pendingOrders[0].orderNumber;

  const quoteResponse = await adminRun(
    'adminBroadcastQuote',
    [groupId, 'Worker Integration Round', 330, 380, false],
    'worker-release-quote',
  );
  expect(quoteResponse.status).toBe(200);
  expect(await client.getOrder(orderNumber)).toMatchObject({ status: 'pending_match' });

  const mismatchEvent = {
    type: 'message',
    timestamp: Date.now() + 1,
    webhookEventId: 'worker-mismatch-event',
    replyToken: 'worker-mismatch-token',
    source: { type: 'group', groupId, userId: matcherLineId },
    message: { id: 'worker-mismatch-message', type: 'text', text: `ต ${orderNumber} 90` },
  };
  expect((await signedWebhook(mismatchEvent)).status).toBe(200);
  expect((await client.getAccount(matcherId))?.balanceHundredths).toBe(50_000);

  const matchEvent = {
    ...mismatchEvent,
    timestamp: Date.now() + 2,
    webhookEventId: 'worker-match-event',
    replyToken: 'worker-match-token',
    source: { type: 'group', groupId, userId: matcherLineId },
    message: { id: 'worker-match-message', type: 'text', text: `ต ${orderNumber} 100` },
  };
  const replyCountBeforeMatch = lineCalls.filter((call) => call.path.endsWith('/message/reply')).length;
  expect((await signedWebhook(matchEvent)).status).toBe(200);
  expect((await signedWebhook(matchEvent)).status).toBe(200);

  expect((await client.getAccount(matcherId))?.balanceHundredths).toBe(40_000);
  expect(await client.getLedgerEntries(matcherId)).toHaveLength(2);
  expect(await client.getOrder(orderNumber)).toMatchObject({
    status: 'matched',
    matcherId,
    stakeHundredths: 10_000,
  });
  expect(lineCalls.filter((call) => call.path.endsWith('/message/reply'))).toHaveLength(replyCountBeforeMatch);
  expect(lineCalls.some((call) =>
    call.path.endsWith('/message/push') && call.body.includes(matcherLineId)
  )).toBe(true);

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await adminRun('adminResolveBets', [400], 'worker-settle-round');
    expect(response.status).toBe(200);
    if (attempt === 0) expect(await response.json()).toMatchObject({ data: { resolvedCount: 1 } });
  }
  expect((await client.getAccount(matcherId))?.balanceHundredths).toBe(59_000);
  expect((await client.getSnapshot()).accounts.find((account) => account.kind === 'house')?.balanceHundredths).toBe(1_000);
  expect(await client.getOrder(orderNumber)).toMatchObject({ status: 'settled', winnerSide: 'high' });

  const privateBalanceEvent = {
    type: 'message',
    timestamp: Date.now() + 3,
    webhookEventId: 'worker-private-balance-event',
    replyToken: 'expired-private-token',
    source: { type: 'user', userId: matcherLineId },
    message: { id: 'worker-private-balance-message', type: 'text', text: 'ยอด' },
  };
  const matcherPushCountBeforeFallback = lineCalls.filter((call) =>
    call.path.endsWith('/message/push') && call.body.includes(matcherLineId)
  ).length;
  expect((await signedWebhook(privateBalanceEvent)).status).toBe(200);
  const matcherPushCountAfterFallback = lineCalls.filter((call) =>
    call.path.endsWith('/message/push') && call.body.includes(matcherLineId)
  ).length;
  expect(matcherPushCountAfterFallback).toBe(matcherPushCountBeforeFallback + 1);

  const bankEvent = {
    type: 'message',
    timestamp: Date.now() + 4,
    webhookEventId: 'worker-bank-registration-event',
    replyToken: 'worker-bank-registration-token',
    source: { type: 'user', userId: creatorLineId },
    message: { id: 'worker-bank-registration-message', type: 'text', text: 'บัญชี ธนาคาร 1234567890 Test User' },
  };
  expect((await signedWebhook(bankEvent)).status).toBe(200);

  const depositEvent = {
    type: 'message',
    timestamp: Date.now() + 5,
    webhookEventId: 'worker-deposit-event',
    replyToken: 'worker-deposit-token',
    source: { type: 'user', userId: creatorLineId },
    message: { id: 'worker-deposit-message', type: 'text', text: 'ฝาก100' },
  };
  expect((await signedWebhook(depositEvent)).status).toBe(200);
  const deposit = (await client.getSnapshot()).transactions.find((transaction) =>
    transaction.type === 'deposit' && transaction.playerId === creatorId
  );
  expect(deposit).toMatchObject({ status: 'pending', requestedAmountHundredths: 10_000 });
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBe(40_000);

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await adminRun('adminApproveTransaction', [deposit!.transactionId], 'worker-approve-deposit');
    expect(response.status).toBe(200);
  }
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBe(50_000);

  const withdrawalEvent = {
    type: 'message',
    timestamp: Date.now() + 6,
    webhookEventId: 'worker-withdrawal-event',
    replyToken: 'worker-withdrawal-token',
    source: { type: 'user', userId: creatorLineId },
    message: { id: 'worker-withdrawal-message', type: 'text', text: 'ถอน100' },
  };
  expect((await signedWebhook(withdrawalEvent)).status).toBe(200);
  const withdrawal = (await client.getSnapshot()).transactions.find((transaction) =>
    transaction.type === 'withdrawal' && transaction.playerId === creatorId
  );
  expect(withdrawal).toMatchObject({ status: 'pending', requestedAmountHundredths: 10_000 });
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBe(40_000);
  expect((await adminRun('adminRejectTransaction', [withdrawal!.transactionId, 'test rejection'])).status).toBe(200);
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBe(50_000);

  expect((await adminRun('adminOpenRound', ['Unquoted Round'], 'worker-open-unquoted-round')).status).toBe(200);
  const unquotedEvent = {
    type: 'message',
    timestamp: Date.now() + 7,
    webhookEventId: 'worker-unquoted-order-event',
    replyToken: 'worker-unquoted-order-token',
    source: { type: 'group', groupId, userId: creatorLineId },
    message: { id: 'worker-unquoted-order-message', type: 'text', text: 'ถ100' },
  };
  expect((await signedWebhook(unquotedEvent)).status).toBe(200);
  const heldOrder = (await client.getOrdersByStatus(['pending_hold'])).find((order) =>
    order.creatorId === creatorId
  );
  expect(heldOrder).toBeDefined();
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBe(40_000);

  expect((await adminRun(
    'adminBroadcastFinalCall',
    [groupId],
    'worker-close-unquoted-round',
  )).status).toBe(200);
  expect(await client.getOrder(heldOrder!.orderNumber)).toMatchObject({ status: 'cancelled' });
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBe(50_000);
});
