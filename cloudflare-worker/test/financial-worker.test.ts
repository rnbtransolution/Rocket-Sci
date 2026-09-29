import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';
import worker from '../src/index';
import { createAdminSession } from '../src/adminSession';

const lineSecret = 'local-test-secret';
const adminPassword = 'local-test-admin-password';

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const client = createCoordinatorClient(env);
  const snapshot = {
    snapshotId: 'baseline-financial-authority',
    schemaVersion: 'financial-ledger-v1' as const,
    accounts: [],
    transactions: [],
    rounds: [],
    orders: [],
    reconciliation: {
      accountCount: 0,
      transactionCount: 0,
      roundCount: 0,
      orderCount: 0,
      totalBalanceHundredths: 0,
    },
  };
  await client.importSnapshot({
    idempotencyKey: 'baseline-financial-authority-import',
    snapshot,
    provenance: 'local-test-fixture',
  });
  await client.activateAuthority({
    idempotencyKey: 'baseline-financial-authority-activation',
    operatorId: 'local-test',
    snapshotId: snapshot.snapshotId,
    accountCount: 0,
    transactionCount: 0,
    roundCount: 0,
    orderCount: 0,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  });
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
  let accountReads = 0;
  const coordinatorStub = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { operation } = JSON.parse(String(init?.body));
      if (operation === 'getOrdersByStatus') return Response.json({ result: [] });
      if (operation === 'listAccounts') {
        accountReads++;
        if (accountReads === 1) {
          return Response.json(
            { error: { code: 'INTERNAL', message: 'Snapshot temporarily unavailable' } },
            { status: 500 },
          );
        }
        return Response.json({ result: { items: [], nextCursor: null } });
      }
      if (operation === 'listTransactions') {
        return Response.json({ result: { items: [], nextCursor: null } });
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
  expect(accountReads).toBe(1);
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
    if (attempt === 0) {
      expect(await response.json()).toMatchObject({
        data: {
          resolvedCount: 1,
          dashboard: {
            players: expect.any(Array),
            transactions: expect.any(Array),
            bets: expect.any(Array),
          },
          resolvedOrders: [{
            orderNumber,
            winnerSide: 'high',
            winnerCredit: 190,
            houseFee: 10,
          }],
        },
      });
    }
  }
  expect((await client.getAccount(matcherId))?.balanceHundredths).toBe(59_000);
  expect((await client.getSnapshot()).accounts.find((account) => account.kind === 'house')?.balanceHundredths).toBe(1_000);
  expect(await client.getOrder(orderNumber)).toMatchObject({ status: 'settled', winnerSide: 'high' });
  expect(lineCalls.some((call) =>
    call.path.endsWith('/message/push') &&
    call.body.includes('คืนเงินเดิมพันตัวเอง 100.00 + 90% จากคู่แข่ง 90.00 = รับรวม 190.00 แต้ม') &&
    call.body.includes('บ้านรับ 10.00 แต้มจากผู้แพ้')
  )).toBe(true);

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

it('never aliases a LINE user to another player account when short-ID suffixes collide', async () => {
  const client = createCoordinatorClient(env);
  fetchMock
    .get('https://api.line.me')
    .intercept({ path: /.*/, method: 'GET' })
    .reply(200, { displayName: 'Collision User' })
    .persist();
  fetchMock
    .get('https://api.line.me')
    .intercept({ path: /.*/, method: 'POST' })
    .reply(200, {})
    .persist();

  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  const lineA = `U${'a'.repeat(26)}${suffix}`;
  const lineB = `U${'b'.repeat(26)}${suffix}`;
  const playerAId = `PL${suffix}`;

  const createA = await adminRun('adminCreatePlayer', [lineA, 'Player A', 100], `collision-create-a-${suffix}`);
  expect(createA.status, JSON.stringify(await createA.clone().json())).toBe(200);
  expect(await client.getAccount(playerAId)).toMatchObject({ lineUserId: lineA });

  const balanceEventB = {
    type: 'message',
    timestamp: Date.now(),
    webhookEventId: `collision-b-${suffix}`,
    replyToken: `collision-token-${suffix}`,
    source: { type: 'user', userId: lineB },
    message: { id: `collision-msg-${suffix}`, type: 'text', text: 'ยอด' },
  };
  expect((await signedWebhook(balanceEventB)).status).toBe(200);

  const accountB = await client.getAccountByLineUserId(lineB);
  expect(accountB).not.toBeNull();
  expect(accountB!.playerId).not.toBe(playerAId);
  expect(await client.getAccount(playerAId)).toMatchObject({
    lineUserId: lineA,
    balanceHundredths: 10_000,
  });
  expect(await env.KV_CACHE.get(`RAW_LINE_${playerAId}`)).toBe(lineA);

  // A repeated event from B must resolve to the same dedicated account.
  expect((await signedWebhook({ ...balanceEventB, webhookEventId: `collision-b2-${suffix}` })).status).toBe(200);
  expect((await client.getAccountByLineUserId(lineB))!.playerId).toBe(accountB!.playerId);
});

it('ignores a cached short ID that is already claimed by another LINE user', async () => {
  const client = createCoordinatorClient(env);
  fetchMock
    .get('https://api.line.me')
    .intercept({ path: /.*/, method: 'GET' })
    .reply(200, { displayName: 'Stale Cache User' })
    .persist();
  fetchMock
    .get('https://api.line.me')
    .intercept({ path: /.*/, method: 'POST' })
    .reply(200, {})
    .persist();

  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  const ownerLine = `U${'c'.repeat(26)}${suffix}`;
  const staleLine = `U${'d'.repeat(26)}${suffix}`;
  const ownerPlayerId = `PL${suffix}`;

  const createOwner = await adminRun('adminCreatePlayer', [ownerLine, 'Cache Owner', 0], `stale-cache-owner-${suffix}`);
  expect(createOwner.status, JSON.stringify(await createOwner.clone().json())).toBe(200);
  expect(await client.getAccount(ownerPlayerId)).toMatchObject({ lineUserId: ownerLine });

  // Stale cache: this user's KV profile points at another player's short ID.
  await env.KV_CACHE.put(`USER_${staleLine}`, JSON.stringify({
    shortId: ownerPlayerId,
    lineUserId: staleLine,
    displayName: 'Stale Cache User',
    balance: 0,
    registeredAt: Date.now(),
    updatedAt: Date.now(),
  }));

  const event = {
    type: 'message',
    timestamp: Date.now(),
    webhookEventId: `stale-cache-${suffix}`,
    replyToken: `stale-cache-token-${suffix}`,
    source: { type: 'user', userId: staleLine },
    message: { id: `stale-cache-msg-${suffix}`, type: 'text', text: 'ยอด' },
  };
  expect((await signedWebhook(event)).status).toBe(200);

  const account = await client.getAccountByLineUserId(staleLine);
  expect(account).not.toBeNull();
  expect(account!.playerId).not.toBe(ownerPlayerId);
  expect(await client.getAccount(ownerPlayerId)).toMatchObject({ lineUserId: ownerLine });
});

it('reconciles a repeated adminCreatePlayer for an already-registered LINE user', async () => {
  const client = createCoordinatorClient(env);
  const lineId = `U${crypto.randomUUID().replaceAll('-', '')}`;
  const first = await adminRun('adminCreatePlayer', [lineId, 'Reconciled Player', 25], `reconcile-create-${crypto.randomUUID()}`);
  expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
  const firstBody = await first.json() as { data: { player: { shortId: string } } };
  const playerId = firstBody.data.player.shortId;
  const account = await client.getAccount(playerId);
  expect(account).toMatchObject({ lineUserId: lineId, balanceHundredths: 2_500 });

  const duplicate = await adminRun('adminCreatePlayer', [lineId, 'Reconciled Player', 25], `reconcile-create-${crypto.randomUUID()}`);
  expect(duplicate.status, JSON.stringify(await duplicate.clone().json())).toBe(200);
  const duplicateBody = await duplicate.json() as { data: { player: { shortId: string } } };
  expect(duplicateBody.data.player.shortId).toBe(playerId);
  expect((await client.getLedgerEntries(playerId))).toHaveLength(1);
});

it('rejects a malformed final time without closing the round, then settles a retried request once', async () => {
  const client = createCoordinatorClient(env);
  const tag = crypto.randomUUID();
  const requestId = `worker-settle-fractional-${tag}`;
  expect((await adminRun('adminOpenRound', [`Fractional Round ${tag}`], `fractional-open-${tag}`)).status).toBe(200);
  const activeRound = JSON.parse((await env.KV_CACHE.get('ACTIVE_ROUND'))!);

  const creatorId = `player-frac-creator-${tag}`;
  const matcherId = `player-frac-matcher-${tag}`;
  for (const playerId of [creatorId, matcherId]) {
    await client.createPlayer({
      idempotencyKey: `${playerId}-opening`,
      playerId,
      lineUserId: `${playerId}-line`,
      displayName: 'Fractional Participant',
      openingBalanceHundredths: 10_000,
    });
  }
  const order = await client.createOrder({
    idempotencyKey: `${tag}-order`,
    roundId: activeRound.roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 330,
    rangeMax: 380,
    creatorName: 'Fractional Creator',
    groupId: 'fractional-test-group',
  });
  await client.matchOrder({
    idempotencyKey: `${tag}-match`,
    orderNumber: order.orderNumber,
    matcherId,
    stakeHundredths: 1_000,
    matcherName: 'Fractional Matcher',
  });

  // Malformed sub-tenths time: rejected and must not close the round or
  // strand the matched order.
  const malformed = await adminRun('adminResolveBets', [355.55, 330, 380], requestId);
  expect(malformed.status).toBe(400);
  const roundAfterReject = await client.getSnapshot();
  expect(roundAfterReject.rounds.find((round) => round.roundId === activeRound.roundId))
    .toMatchObject({ status: 'active' });
  expect(await client.getOrder(order.orderNumber)).toMatchObject({ status: 'matched', finalSeconds: null });
  expect(JSON.parse((await env.KV_CACHE.get('ACTIVE_ROUND'))!).status).toBe('ACTIVE');

  // Corrected retry with the same request ID settles exactly once.
  const settled = await adminRun('adminResolveBets', [355.5, 330, 380], requestId);
  expect(settled.status, JSON.stringify(await settled.clone().json())).toBe(200);
  const settledBody = await settled.json() as { data: { finalTime: number; resolvedCount: number } };
  expect(settledBody.data.finalTime).toBe(355.5);
  expect(settledBody.data.resolvedCount).toBe(1);

  const creatorEntriesAfterSettle = (await client.getLedgerEntries(creatorId)).length;
  const matcherEntriesAfterSettle = (await client.getLedgerEntries(matcherId)).length;

  // A replayed retry repeats no ledger effects.
  const replay = await adminRun('adminResolveBets', [355.5, 330, 380], requestId);
  expect(replay.status).toBe(200);
  expect((await client.getLedgerEntries(creatorId)).length).toBe(creatorEntriesAfterSettle);
  expect((await client.getLedgerEntries(matcherId)).length).toBe(matcherEntriesAfterSettle);
  expect(await client.getAccount(creatorId)).toMatchObject({ balanceHundredths: 10_000 });
  expect(await client.getAccount(matcherId)).toMatchObject({ balanceHundredths: 10_000 });
  expect(await client.getOrder(order.orderNumber)).toMatchObject({
    status: 'settled',
    finalSeconds: 355.5,
    winnerSide: 'draw',
  });
});

it('serves bounded dashboard reads with page info under repeated polling', async () => {
  for (let poll = 0; poll < 2; poll++) {
    const response = await adminRun('getDashboardData', [{ playersLimit: 1, transactionsLimit: 1 }]);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const body = await response.json() as { data: any };
    expect(body.data.players.length).toBeLessThanOrEqual(1);
    expect(body.data.transactions.length).toBeLessThanOrEqual(1);
    expect(body.data.pageInfo).toMatchObject({
      playersLimit: 1,
      transactionsLimit: 1,
      playersReturned: body.data.players.length,
      transactionsReturned: body.data.transactions.length,
    });
    expect(body.data.pageInfo.transactionsNextCursor === null ||
      typeof body.data.pageInfo.transactionsNextCursor === 'string').toBe(true);
  }

  // Default polling stays bounded even with an unbounded backing store.
  const unbounded = await adminRun('getDashboardData', []);
  expect(unbounded.status).toBe(200);
  const unboundedBody = await unbounded.json() as { data: any };
  expect(unboundedBody.data.players.length).toBeLessThanOrEqual(500);
  expect(unboundedBody.data.transactions.length).toBeLessThanOrEqual(100);
  expect(unboundedBody.data.pageInfo).toMatchObject({ playersLimit: 500, transactionsLimit: 100 });
});
