import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';

const TARGET_OPS_PER_SECOND = 20;
const OPERATION_COUNT = 100;
const OPERATION_INTERVAL_MS = 1_000 / TARGET_OPS_PER_SECOND;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get('https://gas-projection.test')
    .intercept({ method: 'POST', path: '/exec' })
    .reply(({ body }) => {
      const request = JSON.parse(String(body)) as { event: { eventId: string } };
      return {
        statusCode: 200,
        data: JSON.stringify({ success: true, eventId: request.event.eventId }),
      };
    })
    .persist();
});

function createEmptySnapshot() {
  return {
    snapshotId: `load-baseline-${crypto.randomUUID()}`,
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
}

it('sustains 20 finance operations per second without lost or duplicate ledger effects', async () => {
  const client = createCoordinatorClient(env, `coordinator-load-${crypto.randomUUID()}`);
  const snapshot = createEmptySnapshot();
  await client.importSnapshot({
    idempotencyKey: `${snapshot.snapshotId}-import`,
    snapshot,
    provenance: 'local-load-test',
  });
  await client.activateAuthority({
    idempotencyKey: `${snapshot.snapshotId}-activation`,
    operatorId: 'local-load-test',
    snapshotId: snapshot.snapshotId,
    accountCount: 0,
    transactionCount: 0,
    roundCount: 0,
    orderCount: 0,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  });

  const durations: number[] = [];
  const operationStartTimes: number[] = [];
  const workloadStartedAt = performance.now();
  await Promise.all(Array.from({ length: OPERATION_COUNT }, (_, index) => (async () => {
    const targetStart = workloadStartedAt + index * OPERATION_INTERVAL_MS;
    const delay = targetStart - performance.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const operationStartedAt = performance.now();
    operationStartTimes[index] = operationStartedAt;
    const playerId = `load-player-${index}`;
    await client.createPlayer({
      idempotencyKey: `${playerId}-opening`,
      playerId,
      lineUserId: `${playerId}-line`,
      displayName: `Load Player ${index}`,
      openingBalanceHundredths: 100,
    });
    durations.push(performance.now() - operationStartedAt);
  })()));
  const elapsedMs = operationStartTimes[OPERATION_COUNT - 1] - operationStartTimes[0];
  const measuredOpsPerSecond = (OPERATION_COUNT - 1) / (elapsedMs / 1_000);
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const p95Ms = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1];
  const snapshotAfter = await client.getSnapshot();
  const playerAccounts = snapshotAfter.accounts.filter((account) => account.kind === 'player');
  const ledgerEntries = (
    await Promise.all(playerAccounts.map((account) => client.getLedgerEntries(account.playerId)))
  ).flat();
  const totalAccountBalance = snapshotAfter.accounts.reduce(
    (total, account) => total + account.balanceHundredths,
    0,
  );
  const totalLedgerDelta = ledgerEntries.reduce(
    (total, entry) => total + entry.deltaHundredths,
    0,
  );
  const uniqueEntryIds = new Set(ledgerEntries.map((entry) => entry.entryId));

  console.log(JSON.stringify({
    targetOpsPerSecond: TARGET_OPS_PER_SECOND,
    measuredOpsPerSecond,
    p95Ms,
    accountCount: playerAccounts.length,
    ledgerEntryCount: ledgerEntries.length,
    uniqueLedgerEntryCount: uniqueEntryIds.size,
    totalAccountBalance,
    totalLedgerDelta,
  }));

  expect(measuredOpsPerSecond).toBeGreaterThanOrEqual(TARGET_OPS_PER_SECOND * 0.9);
  expect(measuredOpsPerSecond).toBeLessThanOrEqual(TARGET_OPS_PER_SECOND * 1.1);
  expect(p95Ms).toBeLessThan(1_000);
  expect(playerAccounts).toHaveLength(OPERATION_COUNT);
  expect(ledgerEntries).toHaveLength(OPERATION_COUNT);
  expect(uniqueEntryIds).toHaveLength(OPERATION_COUNT);
  expect(totalAccountBalance).toBe(OPERATION_COUNT * 100);
  expect(totalLedgerDelta).toBe(totalAccountBalance);

  for (let index = 0; index < OPERATION_COUNT; index += 1) {
    const playerId = `load-player-${index}`;
    const matchingAccounts = playerAccounts.filter((account) => account.playerId === playerId);
    expect(matchingAccounts).toHaveLength(1);
    expect(matchingAccounts[0]).toMatchObject({
      playerId,
      balanceHundredths: 100,
    });
    const accountEntries = ledgerEntries.filter((entry) => entry.accountId === playerId);
    expect(accountEntries).toHaveLength(1);
    expect(accountEntries[0]).toMatchObject({
      accountId: playerId,
      deltaHundredths: 100,
      balanceAfterHundredths: 100,
      eventType: 'opening_balance',
      referenceId: playerId,
    });
  }
}, 15_000);
