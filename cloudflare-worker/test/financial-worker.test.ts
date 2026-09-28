import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';
import worker from '../src/index';
import { createAdminSession } from '../src/adminSession';

const lineSecret = 'local-test-secret';
const adminPassword = 'local-test-admin-password';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

async function adminRun(functionName: string, args: unknown[], requestId?: string) {
  if (functionName === 'adminLogin') {
    return SELF.fetch('https://worker.test/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ functionName, args, requestId }),
    });
  }
  const login = await SELF.fetch('https://worker.test/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ functionName: 'adminLogin', args: ['admin', adminPassword] }),
  });
  const loginBody = await login.json() as { data: { token: string } };
  return SELF.fetch('https://worker.test/api/run', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${loginBody.data.token}`,
    },
    body: JSON.stringify({ functionName, args, requestId }),
  });
}

it('accepts the authenticated proxy bearer token for protected Worker RPCs', async () => {
  const login = await adminRun('adminLogin', ['admin', adminPassword]);
  expect(login.status).toBe(200);
  const loginBody = await login.json() as { data: { token: string } };
  const sessionToken = loginBody.data.token;
  expect(typeof sessionToken).toBe('string');
  expect(sessionToken.length).toBeGreaterThan(0);

  const response = await SELF.fetch('https://worker.test/api/run', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      functionName: 'adminOpenRound',
      args: ['Authenticated Proxy Round'],
      requestId: `proxy-round-${crypto.randomUUID()}`,
    }),
  });

  expect(response.status).toBe(200);
});

it('fails admin login explicitly when the Worker credential is missing', async () => {
  const response = await worker.fetch(
    new Request('https://worker.test/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ functionName: 'adminLogin', args: ['admin', ''] }),
    }),
    { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '', ADMIN_SESSION_SECRET: '' } as never,
    {} as never,
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Admin authentication is not configured' });
});

it('returns an explicit dashboard failure when the player snapshot fails', async () => {
  let snapshotCalls = 0;
  const coordinatorStub = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { operation } = JSON.parse(String(init?.body));
      if (operation === 'getOrdersByStatus') return Response.json({ result: [] });
      if (operation === 'getSnapshot') {
        snapshotCalls++;
        if (snapshotCalls === 1) {
          return Response.json(
            { error: { code: 'INTERNAL', message: 'Snapshot temporarily unavailable' } },
            { status: 500 },
          );
        }
        return Response.json({ result: { accounts: [], transactions: [], totalBalanceHundredths: 0 } });
      }
      throw new Error(`Unexpected coordinator operation: ${operation}`);
    },
  };
  const mockEnv = {
    ADMIN_USERNAME: 'admin',
    ADMIN_SESSION_SECRET: 'local-test-session-secret',
    FINANCIAL_COORDINATOR: {
      idFromName: () => 'financial-coordinator',
      get: () => coordinatorStub,
    },
    KV_CACHE: {
      get: async () => null,
      put: async () => undefined,
    },
  };
  const session = await createAdminSession('admin', mockEnv.ADMIN_SESSION_SECRET);

  const response = await worker.fetch(
    new Request('https://worker.test/api/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ functionName: 'getDashboardData' }),
    }),
    mockEnv as never,
    {} as never,
  );

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    error: { code: 'INTERNAL', message: 'Snapshot temporarily unavailable' },
  });
  expect(snapshotCalls).toBe(1);
});

it('keeps the active Worker round when replacement is blocked by an unsettled match', async () => {
  const client = createCoordinatorClient(env);
  const initialRequestId = `round-lock-open-${crypto.randomUUID()}`;
  expect((await adminRun('adminOpenRound', ['Round With Match'], initialRequestId)).status).toBe(200);
  const activeRound = JSON.parse((await env.KV_CACHE.get('ACTIVE_ROUND'))!);
  const creatorId = `player-round-lock-creator-${crypto.randomUUID()}`;
  const matcherId = `player-round-lock-matcher-${crypto.randomUUID()}`;

  for (const playerId of [creatorId, matcherId]) {
    await client.createPlayer({
      idempotencyKey: `${playerId}-opening`,
      playerId,
      lineUserId: `${playerId}-line`,
      displayName: 'Round Lock Participant',
      openingBalanceHundredths: 10_000,
    });

  }
  const order = await client.createOrder({
    idempotencyKey: `${creatorId}-order`,
    roundId: activeRound.roundId,
    creatorId,
    side: 'high',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 30,
    rangeMax: 40,
    creatorName: 'Round Lock Creator',
    groupId: 'round-lock-test-group',
  });
  await client.matchOrder({
    idempotencyKey: `${order.orderNumber}-match`,
    orderNumber: order.orderNumber,
    matcherId,
    stakeHundredths: 1_000,
    matcherName: 'Round Lock Matcher',
  });

  const replacement = await adminRun('adminOpenRound', ['Replacement Round'], `replacement-${crypto.randomUUID()}`);

  expect(replacement.status).toBe(409);
  expect(await replacement.json()).toMatchObject({
    error: { code: 'INVALID_STATE', message: expect.stringContaining('matched orders remain unsettled') },
  });
  expect(JSON.parse((await env.KV_CACHE.get('ACTIVE_ROUND'))!).roundId).toBe(activeRound.roundId);
  expect(await client.getOrder(order.orderNumber)).toMatchObject({ status: 'matched' });
  expect(await client.getAccount(creatorId)).toMatchObject({ balanceHundredths: 9_000 });
  expect(await client.getAccount(matcherId)).toMatchObject({ balanceHundredths: 9_000 });
  await client.closeRound({
    idempotencyKey: `${activeRound.roundId}-test-close`,
    roundId: activeRound.roundId,
  });
  await client.voidRound({
    idempotencyKey: `${activeRound.roundId}-test-void`,
    roundId: activeRound.roundId,
  });
});

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

it('cancels a dashboard order through the coordinator and refunds it idempotently', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-admin-cancel-${crypto.randomUUID()}`;
  await adminRun('adminOpenRound', [`Cancel Round ${playerId}`], `${playerId}-round`);
  const round = JSON.parse((await env.KV_CACHE.get('ACTIVE_ROUND'))!);
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Admin Cancel Player',
    openingBalanceHundredths: 10_000,
  });
  const order = await client.createOrder({
    idempotencyKey: `${playerId}-order`,
    roundId: round.roundId,
    creatorId: playerId,
    side: 'low',
    stakeHundredths: 2_000,
    betType: 'custom_range',
    rangeMin: 30,
    rangeMax: 40,
    creatorName: 'Admin Cancel Player',
    groupId: 'admin-cancel-test',
  });

  const cancelResponse = await adminRun('adminRequestCancelBet', [order.orderNumber]);
  expect(cancelResponse.status, JSON.stringify(await cancelResponse.clone().json())).toBe(200);
  expect((await adminRun('adminRequestCancelBet', [order.orderNumber])).status).toBe(200);
  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 10_000 });
  expect(await client.getLedgerEntries(playerId)).toHaveLength(3);
});

it('voids the active dashboard round through the coordinator', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-admin-void-${crypto.randomUUID()}`;
  await adminRun('adminOpenRound', [`Void Round ${playerId}`], `${playerId}-round`);
  const round = JSON.parse((await env.KV_CACHE.get('ACTIVE_ROUND'))!);
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Admin Void Player',
    openingBalanceHundredths: 10_000,
  });
  await client.createOrder({
    idempotencyKey: `${playerId}-order`,
    roundId: round.roundId,
    creatorId: playerId,
    side: 'high',
    stakeHundredths: 2_000,
    betType: 'custom_range',
    rangeMin: 30,
    rangeMax: 40,
    creatorName: 'Admin Void Player',
    groupId: 'admin-void-test',
  });

  expect((await adminRun('adminVoidRound', [])).status).toBe(200);
  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 10_000 });
});
