import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';

const TARGET_OPS_PER_SECOND = 20;
const OPERATION_COUNT = 100;
const BATCH_SIZE = TARGET_OPS_PER_SECOND;

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
  const startedAt = performance.now();
  for (let batchStart = 0; batchStart < OPERATION_COUNT; batchStart += BATCH_SIZE) {
    const batch = Array.from({ length: BATCH_SIZE }, (_, offset) => {
      const index = batchStart + offset;
      const playerId = `load-player-${index}`;
      return (async () => {
        const operationStartedAt = performance.now();
        await client.createPlayer({
          idempotencyKey: `${playerId}-opening`,
          playerId,
          lineUserId: `${playerId}-line`,
          displayName: `Load Player ${index}`,
          openingBalanceHundredths: 100,
        });
        durations.push(performance.now() - operationStartedAt);
      })();
    });
    await Promise.all(batch);
    if (batchStart + BATCH_SIZE < OPERATION_COUNT) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  const elapsedMs = performance.now() - startedAt;
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
    measuredOpsPerSecond: OPERATION_COUNT / (elapsedMs / 1_000),
    p95Ms,
    accountCount: playerAccounts.length,
    ledgerEntryCount: ledgerEntries.length,
    uniqueLedgerEntryCount: uniqueEntryIds.size,
    totalAccountBalance,
    totalLedgerDelta,
  }));

  expect(p95Ms).toBeLessThan(1_000);
  expect(playerAccounts).toHaveLength(OPERATION_COUNT);
  expect(ledgerEntries).toHaveLength(OPERATION_COUNT);
  expect(uniqueEntryIds).toHaveLength(OPERATION_COUNT);
  expect(totalAccountBalance).toBe(OPERATION_COUNT * 100);
  expect(totalLedgerDelta).toBe(totalAccountBalance);
});
