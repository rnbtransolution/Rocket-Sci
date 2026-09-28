import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';
import { validateStakeHundredths, wholePointsToHundredths } from '../src/financial/types';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
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

it('reserves a withdrawal once and refunds it only once when rejected', async () => {
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
    amountHundredths: 2_000,
    bankName: 'Test Bank',
    accountNumber: '123456',
    accountName: 'Test Player',
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

  expect(await client.getAccount(playerId)).toMatchObject({ balanceHundredths: 5_000 });
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
