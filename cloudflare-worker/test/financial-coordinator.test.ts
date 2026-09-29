import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';
import { calculateWinPayout } from '../src/financial/payout';
import { validateStakeHundredths, wholePointsToHundredths } from '../src/financial/types';

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

it('validates positive whole-point stakes and converts them safely to hundredths', () => {
  expect(validateStakeHundredths(5_100)).toBe(5_100);
  expect(wholePointsToHundredths(51)).toBe(5_100);
  expect(() => validateStakeHundredths(5_150)).toThrowError('stakeHundredths must be a positive whole-point amount');
  expect(() => wholePointsToHundredths(Number.MAX_SAFE_INTEGER)).toThrowError(
    'amount exceeds the supported range',
  );
});

it('creates a player with an immutable opening ledger entry', async () => {
  const client = createCoordinatorClient(env);
  const command = {
    idempotencyKey: 'test-player-1',
    playerId: 'player-opening',
    lineUserId: 'line-player-opening',
    displayName: 'Opening Player',
    openingBalanceHundredths: 12_345,
  };

  const created = await client.createPlayer(command);
  const replayed = await client.createPlayer(command);

  expect(created).toMatchObject({ balanceHundredths: 12_345, active: true });
  expect(replayed).toEqual(created);
  expect(await client.getLedgerEntries('player-opening')).toHaveLength(1);
});

it('replays an adjustment without a second ledger entry', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-adjust-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Adjustment Player',
    openingBalanceHundredths: 0,
  });
  const command = {
    idempotencyKey: `${playerId}-adjust`,
    playerId,
    targetBalanceHundredths: 10_000,
    actorId: 'admin-test',
    reason: 'test',
  };

  await client.adjustBalance(command);
  await client.adjustBalance(command);

  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 10_000 });
  expect(await client.getLedgerEntries(playerId)).toHaveLength(1);
});

it('scopes ledger idempotency keys by operation', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-scoped-${crypto.randomUUID()}`;
  const idempotencyKey = `${playerId}-key`;
  await client.createPlayer({
    idempotencyKey,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Scoped Player',
    openingBalanceHundredths: 1_000,
  });

  await client.adjustBalance({
    idempotencyKey,
    playerId,
    targetBalanceHundredths: 2_000,
    actorId: 'admin-test',
    reason: 'operation-scoped key',
  });

  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 2_000 });
  expect(await client.getLedgerEntries(playerId)).toHaveLength(2);
});

it('rejects an adjustment that would create a negative balance', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-negative-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Negative Player',
    openingBalanceHundredths: 0,
  });

  await expect(client.adjustBalance({
    idempotencyKey: `${playerId}-negative-adjust`,
    playerId,
    targetBalanceHundredths: -1,
    actorId: 'admin-test',
    reason: 'test',
  })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 0 });
  expect(await client.getLedgerEntries(playerId)).toHaveLength(0);
});

it('rejects reuse of an adjustment idempotency key with a different command', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-duplicate-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Duplicate Player',
    openingBalanceHundredths: 0,
  });
  const command = {
    idempotencyKey: `${playerId}-adjust`,
    playerId,
    targetBalanceHundredths: 1_000,
    actorId: 'admin-test',
    reason: 'first adjustment',
  };

  await client.adjustBalance(command);
  await expect(client.adjustBalance({
    ...command,
    targetBalanceHundredths: 2_000,
    reason: 'different adjustment',
  })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 1_000 });
  expect(await client.getLedgerEntries(playerId)).toHaveLength(1);
});

it('blocks deactivation while a player has a nonzero balance', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-deactivate-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Active Player',
    openingBalanceHundredths: 100,
  });

  await expect(client.deactivatePlayer({
    idempotencyKey: `${playerId}-deactivate`,
    playerId,
    actorId: 'admin-test',
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });

  expect(await client.getAccount(playerId)).toMatchObject({ active: true, balanceHundredths: 100 });
});

it('blocks deactivation during a withdrawal and keeps the account active after rejection refunds it', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-withdraw-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Withdrawal Player',
    openingBalanceHundredths: 5_000,
  });
  await client.requestWithdrawal({
    idempotencyKey: `${playerId}-withdrawal`,
    transactionId: `${playerId}-transaction`,
    playerId,
    amountHundredths: 5_000,
    bankName: 'Test Bank',
    accountNumber: '123456',
    accountName: 'Test Player',
  });
  await expect(client.deactivatePlayer({
    idempotencyKey: `${playerId}-deactivate`,
    playerId,
    actorId: 'admin-test',
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });

  expect(await client.getAccount(playerId)).toMatchObject({
    active: true,
    balanceHundredths: 0,
  });
  const review = {
    idempotencyKey: `${playerId}-review`,
    transactionId: `${playerId}-transaction`,
    decision: 'reject' as const,
    actualAmountHundredths: 0,
    actorId: 'admin-test',
    reason: 'test rejection',
  };

  await client.reviewTransaction(review);
  await client.reviewTransaction(review);

  expect(await client.getAccount(playerId)).toMatchObject({
    active: true,
    balanceHundredths: 5_000,
  });
  expect(await client.getLedgerEntries(playerId)).toHaveLength(3);
});

it('does not debit a reserved withdrawal a second time when approved', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-approve-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Approval Player',
    openingBalanceHundredths: 5_000,
  });
  await client.requestWithdrawal({
    idempotencyKey: `${playerId}-withdrawal`,
    transactionId: `${playerId}-transaction`,
    playerId,
    amountHundredths: 2_000,
    bankName: 'Test Bank',
    accountNumber: '123456',
    accountName: 'Test Player',
  });

  const transaction = await client.reviewTransaction({
    idempotencyKey: `${playerId}-review`,
    transactionId: `${playerId}-transaction`,
    decision: 'approve',
    actualAmountHundredths: 2_000,
    actorId: 'admin-test',
    reason: 'test approval',
  });

  expect(transaction.status).toBe('approved');
  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 3_000 });
  expect(await client.getLedgerEntries(playerId)).toHaveLength(2);
});

it('records a pending deposit and credits it only once after approval', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-deposit-${crypto.randomUUID()}`;
  const transactionId = `${playerId}-transaction`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Deposit Player',
    openingBalanceHundredths: 0,
  });

  const request = {
    idempotencyKey: `${playerId}-deposit`,
    transactionId,
    playerId,
    amountHundredths: 10_000,
  };
  const pending = await client.requestDeposit(request);
  expect(pending).toMatchObject({
    transactionId,
    type: 'deposit',
    requestedAmountHundredths: 10_000,
    status: 'pending',
  });
  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 0 });

  const review = {
    idempotencyKey: `${playerId}-approve`,
    transactionId,
    decision: 'approve' as const,
    actualAmountHundredths: 10_000,
    actorId: 'admin-test',
    reason: 'verified deposit',
  };
  await client.reviewTransaction(review);
  await client.reviewTransaction(review);

  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 10_000 });
  expect((await client.getLedgerEntries(playerId)).filter((entry) => entry.eventType === 'deposit_approved')).toHaveLength(1);
});

it('deactivates a zero-balance account without deleting its ledger', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-tombstone-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Tombstone Player',
    openingBalanceHundredths: 1_000,
  });
  await client.adjustBalance({
    idempotencyKey: `${playerId}-zero`,
    playerId,
    targetBalanceHundredths: 0,
    actorId: 'admin-test',
    reason: 'close account',
  });

  const account = await client.deactivatePlayer({
    idempotencyKey: `${playerId}-deactivate`,
    playerId,
    actorId: 'admin-test',
  });

  expect(account).toMatchObject({ active: false, balanceHundredths: 0 });
  expect(await client.getLedgerEntries(playerId)).toHaveLength(2);
});

it('creates and replays pending_hold and pending_match order lifecycle with quotes', async () => {
  const client = createCoordinatorClient(env);
  const roundId = `round-order-lifecycle-${crypto.randomUUID()}`;
  const creatorId = `player-order-creator-${crypto.randomUUID()}`;
  const matcherId = `player-order-matcher-${crypto.randomUUID()}`;

  await client.createPlayer({ idempotencyKey: `${creatorId}-opening`, playerId: creatorId, lineUserId: `${creatorId}-line`, displayName: 'Creator', openingBalanceHundredths: 10_000 });
  await client.createPlayer({ idempotencyKey: `${matcherId}-opening`, playerId: matcherId, lineUserId: `${matcherId}-line`, displayName: 'Matcher', openingBalanceHundredths: 10_000 });
  await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'Lifecycle Round' });

  const standard = await client.createOrder({
    idempotencyKey: `${roundId}-standard`,
    roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'pre_quote',
    rangeMin: 10,
    rangeMax: 20,
    creatorName: 'Creator',
    groupId: 'group-order-1',
  });
  expect(standard.status).toBe('pending_hold');
  expect(standard.orderNumber).toMatch(/^\d{4}$/);
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBe(9_000);

  const custom = await client.createOrder({
    idempotencyKey: `${roundId}-custom`,
    roundId,
    creatorId: matcherId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 30,
    rangeMax: 40,
    creatorName: 'Matcher',
    groupId: 'group-order-1',
  });
  expect(custom.status).toBe('pending_match');

  const released = await client.releaseQuote({
    idempotencyKey: `${roundId}-quote`,
    roundId,
    targetMin: 5,
    targetMax: 25,
  });
  expect(released.releasedOrderNumbers).toContain(standard.orderNumber);
  expect(released.round.quoteReleased).toBe(true);

  const replay = await client.createOrder({
    ...{
      idempotencyKey: `${roundId}-standard`,
      roundId,
      creatorId,
      side: 'low',
      stakeHundredths: 1_000,
      betType: 'pre_quote',
      rangeMin: 10,
      rangeMax: 20,
      creatorName: 'Creator',
      groupId: 'group-order-1',
    },
  });
  expect(replay.orderNumber).toBe(standard.orderNumber);
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBe(9_000);
});

it('computes exact payout and draw semantics', () => {
  expect(calculateWinPayout(10_000)).toEqual({
    winnerCreditHundredths: 19_000,
    houseFeeHundredths: 1_000,
  });
  expect(calculateWinPayout(5_100)).toEqual({
    winnerCreditHundredths: 9_690,
    houseFeeHundredths: 510,
  });
});

it('prevents self-match, duplicate match, and mismatched stake attempts', async () => {
  const client = createCoordinatorClient(env);
  const roundId = `round-match-${crypto.randomUUID()}`;
  const creatorId = `player-match-creator-${crypto.randomUUID()}`;
  const matcherId = `player-match-matcher-${crypto.randomUUID()}`;
  await client.createPlayer({ idempotencyKey: `${creatorId}-opening`, playerId: creatorId, lineUserId: `${creatorId}-line`, displayName: 'Creator', openingBalanceHundredths: 10_000 });
  await client.createPlayer({ idempotencyKey: `${matcherId}-opening`, playerId: matcherId, lineUserId: `${matcherId}-line`, displayName: 'Matcher', openingBalanceHundredths: 10_000 });
  await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'Match Guard Round' });
  const order = await client.createOrder({
    idempotencyKey: `${roundId}-order`,
    roundId,
    creatorId,
    side: 'high',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 10,
    rangeMax: 20,
    creatorName: 'Creator',
    groupId: 'group-match-1',
  });

  await expect(client.matchOrder({
    idempotencyKey: `${order.orderNumber}-self`,
    orderNumber: order.orderNumber,
    matcherId: creatorId,
    stakeHundredths: 1_000,
    matcherName: 'Creator',
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });

  const matched = await client.matchOrder({
    idempotencyKey: `${order.orderNumber}-match`,
    orderNumber: order.orderNumber,
    matcherId,
    stakeHundredths: 1_000,
    matcherName: 'Matcher',
  });
  expect(matched.matcherId).toBe(matcherId);

  await expect(client.matchOrder({
    idempotencyKey: `${order.orderNumber}-double`,
    orderNumber: order.orderNumber,
    matcherId: 'player-other',
    stakeHundredths: 1_000,
    matcherName: 'Other',
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });

  const mismatchedBalance = await client.getAccount(matcherId);
  expect(mismatchedBalance?.balanceHundredths).toBe(9_000);

  const otherId = `player-match-other-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${otherId}-opening`,
    playerId: otherId,
    lineUserId: `${otherId}-line`,
    displayName: 'Other Matcher',
    openingBalanceHundredths: 10_000,
  });
  const badStakeOrder = await client.createOrder({
    idempotencyKey: `${roundId}-bad-stake-order`,
    roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 50,
    rangeMax: 60,
    creatorName: 'Creator',
    groupId: 'group-match-2',
  });

  await expect(client.matchOrder({
    idempotencyKey: `${badStakeOrder.orderNumber}-bad-stake`,
    orderNumber: badStakeOrder.orderNumber,
    matcherId: otherId,
    stakeHundredths: 2_000,
    matcherName: 'Other Matcher',
  })).rejects.toMatchObject({ code: 'STAKE_MISMATCH' });
  expect((await client.getAccount(otherId))?.balanceHundredths).toBe(10_000);
});

it('refunds pending order cancellation and blocks deactivation during unsettled orders', async () => {
  const client = createCoordinatorClient(env);
  const playerId = `player-cancel-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${playerId}-opening`,
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: 'Cancel Player',
    openingBalanceHundredths: 5_000,
  });
  const roundId = `round-cancel-${crypto.randomUUID()}`;
  await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'Cancel Round' });
  const order = await client.createOrder({
    idempotencyKey: `${roundId}-order`,
    roundId,
    creatorId: playerId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'pre_quote',
    rangeMin: 5,
    rangeMax: 15,
    creatorName: 'Cancel Player',
    groupId: 'group-cancel-1',
  });
  await expect(client.deactivatePlayer({
    idempotencyKey: `${playerId}-deactivate-with-order`,
    playerId,
    actorId: 'admin-test',
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  const cancelled = await client.cancelOrder({ idempotencyKey: `${roundId}-cancel`, orderNumber: order.orderNumber, actorId: playerId });
  expect(cancelled.status).toBe('cancelled');
  expect((await client.getAccount(playerId))?.balanceHundredths).toBe(5_000);
  expect((await client.getLedgerEntries(playerId)).filter((entry) => entry.eventType === 'order_cancelled')).toHaveLength(1);

  await expect(client.deactivatePlayer({
    idempotencyKey: `${playerId}-deactivate`,
    playerId,
    actorId: 'admin-test',
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });
});

it('closes unsettled rounds, voids unpaid pending orders, and rejects late quote release', async () => {
  const client = createCoordinatorClient(env);
  const roundId = `round-closure-${crypto.randomUUID()}`;
  const creatorId = `player-close-creator-${crypto.randomUUID()}`;
  const matcherId = `player-close-matcher-${crypto.randomUUID()}`;
  await client.createPlayer({ idempotencyKey: `${creatorId}-opening`, playerId: creatorId, lineUserId: `${creatorId}-line`, displayName: 'A', openingBalanceHundredths: 10_000 });
  await client.createPlayer({ idempotencyKey: `${matcherId}-opening`, playerId: matcherId, lineUserId: `${matcherId}-line`, displayName: 'B', openingBalanceHundredths: 10_000 });
  await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'Closure Round' });
  const held = await client.createOrder({
    idempotencyKey: `${roundId}-held`,
    roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'pre_quote',
    rangeMin: 1,
    rangeMax: 9,
    creatorName: 'A',
    groupId: 'group-close-1',
  });
  const custom = await client.createOrder({
    idempotencyKey: `${roundId}-custom`,
    roundId,
    creatorId: matcherId,
    side: 'high',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 40,
    rangeMax: 49,
    creatorName: 'B',
    groupId: 'group-close-1',
  });

  const closed = await client.closeRound({ idempotencyKey: `${roundId}-close`, roundId });
  expect(closed.cancelledOrderNumbers).toEqual(expect.arrayContaining([held.orderNumber, custom.orderNumber]));

  await expect(client.releaseQuote({
    idempotencyKey: `${roundId}-late-quote`,
    roundId,
    targetMin: 10,
    targetMax: 20,
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });

  const voidRoundId = `round-void-${crypto.randomUUID()}`;
  await client.openRound({ idempotencyKey: `${voidRoundId}-open`, roundId: voidRoundId, name: 'Void Round' });
  const voidOrder = await client.createOrder({
    idempotencyKey: `${voidRoundId}-order`,
    roundId: voidRoundId,
    creatorId,
    side: 'high',
    stakeHundredths: 1_000,
    betType: 'pre_quote',
    rangeMin: 10,
    rangeMax: 20,
    creatorName: 'A',
    groupId: 'group-void-1',
  });
  const voidResult = await client.voidRound({ idempotencyKey: `${voidRoundId}-void`, roundId: voidRoundId });
  expect(voidResult.refundedOrderNumbers).toContain(voidOrder.orderNumber);
  expect((await client.getAccount(creatorId))?.balanceHundredths).toBeGreaterThanOrEqual(9_000);
});

it('persists the official quote on held and later standard orders', async () => {
  const client = createCoordinatorClient(env);
  const roundId = `round-quote-persist-${crypto.randomUUID()}`;
  const creatorId = `player-quote-persist-${crypto.randomUUID()}`;
  const matcherId = `player-quote-matcher-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${creatorId}-opening`,
    playerId: creatorId,
    lineUserId: `${creatorId}-line`,
    displayName: 'Quote Player',
    openingBalanceHundredths: 10_000,
  });
  await client.createPlayer({
    idempotencyKey: `${matcherId}-opening`,
    playerId: matcherId,
    lineUserId: `${matcherId}-line`,
    displayName: 'Quote Matcher',
    openingBalanceHundredths: 10_000,
  });
  await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'Quote Persistence' });
  const held = await client.createOrder({
    idempotencyKey: `${roundId}-held`,
    roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'pre_quote',
    rangeMin: 1,
    rangeMax: 2,
    rangeOffset: 5,
    creatorName: 'Quote Player',
    groupId: `${roundId}-group`,
  });
  const quote = { idempotencyKey: `${roundId}-quote`, roundId, targetMin: 10, targetMax: 20 };
  const released = await client.releaseQuote(quote);

  const later = await client.createOrder({
    idempotencyKey: `${roundId}-later`,
    roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'pre_quote',
    rangeMin: 0,
    rangeMax: 1,
    creatorName: 'Quote Player',
    groupId: `${roundId}-group`,
  });

  expect(later).toMatchObject({ status: 'pending_match', rangeMin: 10, rangeMax: 20 });
  expect(released.releasedOrderNumbers).toContain(held.orderNumber);
  expect(await client.getOrder(held.orderNumber)).toMatchObject({
    status: 'pending_match',
    rangeMin: 15,
    rangeMax: 25,
    rangeOffset: 5,
  });
  for (const orderNumber of [held.orderNumber, later.orderNumber]) {
    await client.matchOrder({
      idempotencyKey: `${orderNumber}-match`,
      orderNumber,
      matcherId,
      stakeHundredths: 1_000,
      matcherName: 'Quote Matcher',
    });
  }
  const settled = await client.resolveRound({
    idempotencyKey: `${roundId}-resolve`,
    roundId,
    finalSeconds: 5,
  });
  expect(settled.orders).toHaveLength(2);
  expect(settled.orders.every((entry) => entry.winnerSide === 'low')).toBe(true);
  expect(await client.getAccount(creatorId)).toMatchObject({ balanceHundredths: 11_800 });
  expect(await client.getAccount(matcherId)).toMatchObject({ balanceHundredths: 8_000 });
});

it('pairs two already-held orders atomically without charging either player twice', async () => {
  const client = createCoordinatorClient(env);
  const roundId = `round-auto-match-${crypto.randomUUID()}`;
  const lowId = `player-auto-low-${crypto.randomUUID()}`;
  const highId = `player-auto-high-${crypto.randomUUID()}`;
  await client.createPlayer({
    idempotencyKey: `${lowId}-opening`,
    playerId: lowId,
    lineUserId: `${lowId}-line`,
    displayName: 'Auto Low',
    openingBalanceHundredths: 10_000,
  });
  await client.createPlayer({
    idempotencyKey: `${highId}-opening`,
    playerId: highId,
    lineUserId: `${highId}-line`,
    displayName: 'Auto High',
    openingBalanceHundredths: 10_000,
  });
  await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'Auto Match' });
  await client.releaseQuote({
    idempotencyKey: `${roundId}-quote`,
    roundId,
    targetMin: 10,
    targetMax: 20,
  });
  const lowOrder = await client.createOrder({
    idempotencyKey: `${roundId}-low`,
    roundId,
    creatorId: lowId,
    creatorName: 'Auto Low',
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'range',
    rangeMin: 10,
    rangeMax: 20,
    groupId: `${roundId}-group`,
  });
  const highOrder = await client.createOrder({
    idempotencyKey: `${roundId}-high`,
    roundId,
    creatorId: highId,
    creatorName: 'Auto High',
    side: 'high',
    stakeHundredths: 1_000,
    betType: 'range',
    rangeMin: 10,
    rangeMax: 20,
    groupId: `${roundId}-group`,
  });
  const command = {
    idempotencyKey: `${roundId}-pair`,
    orderNumber: lowOrder.orderNumber,
    counterpartOrderNumber: highOrder.orderNumber,
  };
  const matched = await client.autoMatchOrders(command);
  expect(await client.autoMatchOrders(command)).toEqual(matched);
  expect(matched).toMatchObject({ status: 'matched', matcherId: highId });
  expect(await client.getOrder(highOrder.orderNumber)).toMatchObject({ status: 'cancelled' });
  expect(await client.getAccount(lowId)).toMatchObject({ balanceHundredths: 9_000 });
  expect(await client.getAccount(highId)).toMatchObject({ balanceHundredths: 9_000 });
  expect((await client.getLedgerEntries(highId)).filter((entry) => entry.eventType === 'order_matched')).toHaveLength(1);
  await client.voidRound({ idempotencyKey: `${roundId}-void`, roundId });
  expect(await client.getAccount(lowId)).toMatchObject({ balanceHundredths: 10_000 });
  expect(await client.getAccount(highId)).toMatchObject({ balanceHundredths: 10_000 });
});

it('settles creator wins, matcher wins, and draws with balanced account credits', async () => {
  const client = createCoordinatorClient(env);
  const cases = [
    { key: 'creator-win', side: 'low' as const, finalSeconds: 5, creatorBalance: 19_000, matcherBalance: 0, winnerSide: 'low' as const },
    { key: 'matcher-win', side: 'low' as const, finalSeconds: 25, creatorBalance: 0, matcherBalance: 19_000, winnerSide: 'high' as const },
    { key: 'draw', side: 'high' as const, finalSeconds: 15, creatorBalance: 10_000, matcherBalance: 10_000, winnerSide: 'draw' as const },
  ];

  for (const scenario of cases) {
    const roundId = `round-settle-${scenario.key}-${crypto.randomUUID()}`;
    const creatorId = `player-settle-creator-${scenario.key}-${crypto.randomUUID()}`;
    const matcherId = `player-settle-matcher-${scenario.key}-${crypto.randomUUID()}`;
    await client.createPlayer({
      idempotencyKey: `${creatorId}-opening`,
      playerId: creatorId,
      lineUserId: `${creatorId}-line`,
      displayName: 'Settlement Creator',
      openingBalanceHundredths: 10_000,
    });
    await client.createPlayer({
      idempotencyKey: `${matcherId}-opening`,
      playerId: matcherId,
      lineUserId: `${matcherId}-line`,
      displayName: 'Settlement Matcher',
      openingBalanceHundredths: 10_000,
    });
    await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: scenario.key });
    await client.releaseQuote({
      idempotencyKey: `${roundId}-quote`,
      roundId,
      targetMin: 10,
      targetMax: 20,
    });
    const order = await client.createOrder({
      idempotencyKey: `${roundId}-order`,
      roundId,
      creatorId,
      side: scenario.side,
      stakeHundredths: 10_000,
      betType: 'pre_quote',
      rangeMin: 1,
      rangeMax: 2,
      creatorName: 'Settlement Creator',
      groupId: `${roundId}-group`,
    });
    await client.matchOrder({
      idempotencyKey: `${roundId}-match`,
      orderNumber: order.orderNumber,
      matcherId,
      stakeHundredths: 10_000,
      matcherName: 'Settlement Matcher',
    });

    const settled = await client.resolveRound({
      idempotencyKey: `${roundId}-resolve`,
      roundId,
      finalSeconds: scenario.finalSeconds,
    });

    expect(settled.orders).toEqual([expect.objectContaining({
      orderNumber: order.orderNumber,
      status: 'settled',
      winnerSide: scenario.winnerSide,
      winnerCreditHundredths: scenario.winnerSide === 'draw' ? 0 : 19_000,
      houseFeeHundredths: scenario.winnerSide === 'draw' ? 0 : 1_000,
    })]);
    expect(await client.getAccount(creatorId)).toMatchObject({ balanceHundredths: scenario.creatorBalance });
    expect(await client.getAccount(matcherId)).toMatchObject({ balanceHundredths: scenario.matcherBalance });
    if (scenario.winnerSide === 'draw') {
      await expect(client.voidRound({
        idempotencyKey: `${roundId}-void-after-settlement`,
        roundId,
      })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    }
  }
});

it('settles a 51-point winner at 96.9 points and credits a 5.1-point house fee', async () => {
  const client = createCoordinatorClient(env);
  const roundId = `round-fractional-${crypto.randomUUID()}`;
  const creatorId = `player-fractional-creator-${crypto.randomUUID()}`;
  const matcherId = `player-fractional-matcher-${crypto.randomUUID()}`;
  for (const [playerId, displayName] of [[creatorId, 'Fractional Creator'], [matcherId, 'Fractional Matcher']] as const) {
    await client.createPlayer({
      idempotencyKey: `${playerId}-opening`,
      playerId,
      lineUserId: `${playerId}-line`,
      displayName,
      openingBalanceHundredths: 10_000,
    });
  }
  await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'Fractional Settlement' });
  await client.releaseQuote({
    idempotencyKey: `${roundId}-quote`,
    roundId,
    targetMin: 10,
    targetMax: 20,
  });
  const order = await client.createOrder({
    idempotencyKey: `${roundId}-order`,
    roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 5_100,
    betType: 'pre_quote',
    rangeMin: 1,
    rangeMax: 2,
    creatorName: 'Fractional Creator',
    groupId: `${roundId}-group`,
  });
  await client.matchOrder({
    idempotencyKey: `${roundId}-match`,
    orderNumber: order.orderNumber,
    matcherId,
    stakeHundredths: 5_100,
    matcherName: 'Fractional Matcher',
  });

  const settled = await client.resolveRound({
    idempotencyKey: `${roundId}-resolve`,
    roundId,
    finalSeconds: 5,
  });

  expect(settled.orders[0]).toMatchObject({
    winnerSide: 'low',
    winnerCreditHundredths: 9_690,
    houseFeeHundredths: 510,
  });
  expect(await client.getAccount(creatorId)).toMatchObject({ balanceHundredths: 14_590 });
  expect(await client.getAccount(matcherId)).toMatchObject({ balanceHundredths: 4_900 });
  expect((await client.getSnapshot()).accounts.find((account) => account.kind === 'house'))
    .toMatchObject({ balanceHundredths: 510 });
});

it('voids a closed but unsettled round by refunding each matched stake once', async () => {
  const client = createCoordinatorClient(env);
  const roundId = `round-void-matched-${crypto.randomUUID()}`;
  const creatorId = `player-void-creator-${crypto.randomUUID()}`;
  const matcherId = `player-void-matcher-${crypto.randomUUID()}`;
  for (const playerId of [creatorId, matcherId]) {
    await client.createPlayer({
      idempotencyKey: `${playerId}-opening`,
      playerId,
      lineUserId: `${playerId}-line`,
      displayName: 'Void Participant',
      openingBalanceHundredths: 10_000,
    });
  }
  await client.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'Closed Unsettled Void' });
  const order = await client.createOrder({
    idempotencyKey: `${roundId}-order`,
    roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 10,
    rangeMax: 20,
    creatorName: 'Void Creator',
    groupId: `${roundId}-group`,
  });
  await client.matchOrder({
    idempotencyKey: `${roundId}-match`,
    orderNumber: order.orderNumber,
    matcherId,
    stakeHundredths: 1_000,
    matcherName: 'Void Matcher',
  });
  await client.closeRound({ idempotencyKey: `${roundId}-close`, roundId });

  const result = await client.voidRound({ idempotencyKey: `${roundId}-void`, roundId });
  const replay = await client.voidRound({ idempotencyKey: `${roundId}-void`, roundId });

  expect(result.refundedOrderNumbers).toEqual([order.orderNumber]);
  expect(replay).toEqual(result);
  expect(await client.getAccount(creatorId)).toMatchObject({ balanceHundredths: 10_000 });
  expect(await client.getAccount(matcherId)).toMatchObject({ balanceHundredths: 10_000 });
  expect((await client.getLedgerEntries(creatorId)).filter((entry) => entry.eventType === 'order_cancelled')).toHaveLength(1);
  expect((await client.getLedgerEntries(matcherId)).filter((entry) => entry.eventType === 'order_cancelled')).toHaveLength(1);
});

it('refuses to replace a round while matched orders remain unsettled', async () => {
  const client = createCoordinatorClient(env);
  const oldRoundId = `round-replaced-${crypto.randomUUID()}`;
  const nextRoundId = `round-replacement-${crypto.randomUUID()}`;
  const creatorId = `player-replaced-creator-${crypto.randomUUID()}`;
  const matcherId = `player-replaced-matcher-${crypto.randomUUID()}`;
  for (const playerId of [creatorId, matcherId]) {
    await client.createPlayer({
      idempotencyKey: `${playerId}-opening`,
      playerId,
      lineUserId: `${playerId}-line`,
      displayName: 'Replacement Participant',
      openingBalanceHundredths: 10_000,
    });
  }
  await client.openRound({ idempotencyKey: `${oldRoundId}-open`, roundId: oldRoundId, name: 'Unquoted Old Round' });
  const held = await client.createOrder({
    idempotencyKey: `${oldRoundId}-held`,
    roundId: oldRoundId,
    creatorId,
    side: 'low',
    stakeHundredths: 1_000,
    betType: 'pre_quote',
    rangeMin: 1,
    rangeMax: 2,
    creatorName: 'Replacement Creator',
    groupId: `${oldRoundId}-group`,
  });
  const unmatchedCustom = await client.createOrder({
    idempotencyKey: `${oldRoundId}-custom-open`,
    roundId: oldRoundId,
    creatorId,
    side: 'high',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 30,
    rangeMax: 40,
    creatorName: 'Replacement Creator',
    groupId: `${oldRoundId}-group`,
  });
  const matchedCustom = await client.createOrder({
    idempotencyKey: `${oldRoundId}-custom-matched`,
    roundId: oldRoundId,
    creatorId,
    side: 'high',
    stakeHundredths: 1_000,
    betType: 'custom_range',
    rangeMin: 30,
    rangeMax: 40,
    creatorName: 'Replacement Creator',
    groupId: `${oldRoundId}-group`,
  });
  await client.matchOrder({
    idempotencyKey: `${oldRoundId}-match`,
    orderNumber: matchedCustom.orderNumber,
    matcherId,
    stakeHundredths: 1_000,
    matcherName: 'Replacement Matcher',
  });

  await expect(client.openRound({
    idempotencyKey: `${nextRoundId}-open`,
    roundId: nextRoundId,
    name: 'Replacement Round',
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });

  expect(await client.getOrder(held.orderNumber)).toMatchObject({ status: 'pending_hold' });
  expect(await client.getOrder(unmatchedCustom.orderNumber)).toMatchObject({ status: 'pending_match' });
  expect(await client.getOrder(matchedCustom.orderNumber)).toMatchObject({ status: 'matched' });
  expect(await client.getAccount(creatorId)).toMatchObject({ balanceHundredths: 7_000 });
  expect(await client.getAccount(matcherId)).toMatchObject({ balanceHundredths: 9_000 });

  await client.closeRound({ idempotencyKey: `${oldRoundId}-close`, roundId: oldRoundId });
  await expect(client.openRound({
    idempotencyKey: `${nextRoundId}-open`,
    roundId: nextRoundId,
    name: 'Replacement Round',
  })).rejects.toMatchObject({ code: 'INVALID_STATE' });

  const settled = await client.resolveRound({
    idempotencyKey: `${oldRoundId}-resolve`,
    roundId: oldRoundId,
    finalSeconds: 25,
  });
  expect(settled.orders).toEqual([expect.objectContaining({
    orderNumber: matchedCustom.orderNumber,
    status: 'settled',
    winnerSide: 'low',
  })]);

  await client.openRound({ idempotencyKey: `${nextRoundId}-open`, roundId: nextRoundId, name: 'Replacement Round' });
  await client.openRound({ idempotencyKey: `${nextRoundId}-open`, roundId: nextRoundId, name: 'Replacement Round' });

  expect(await client.getAccount(creatorId)).toMatchObject({ balanceHundredths: 9_000 });
  expect(await client.getAccount(matcherId)).toMatchObject({ balanceHundredths: 10_900 });
  expect((await client.getLedgerEntries(creatorId)).filter((entry) =>
    entry.eventType === 'order_cancelled' &&
    [held.orderNumber, unmatchedCustom.orderNumber].includes(entry.referenceId ?? ''),
  )).toHaveLength(2);
  expect(await client.getOrder(matchedCustom.orderNumber)).toMatchObject({ status: 'settled' });
});
