import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';
import type { Env } from '../src/types';

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

it('delivers an idempotent ledger projection once with its stable event ID', async () => {
  const requests: Array<{ eventId: string; accountBalance: number }> = [];
  fetchMock
    .get('https://gas-projection.test')
    .intercept({ method: 'POST', path: '/exec' })
    .reply(({ body }) => {
      const request = JSON.parse(String(body)) as {
        event: {
          eventId: string;
          snapshot: { accounts: Array<{ playerId: string; balanceHundredths: number }> };
        };
      };
      requests.push({
        eventId: request.event.eventId,
        accountBalance: request.event.snapshot.accounts.find((account) => account.playerId === 'projection-player')!
          .balanceHundredths,
      });
      return {
        statusCode: 200,
        data: JSON.stringify({ success: true, eventId: request.event.eventId }),
      };
    });

  const client = createCoordinatorClient({
    ...env,
    GAS_PROJECTION_URL: 'https://gas-projection.test/exec',
    PROJECTION_API_KEY: 'local-projection-key',
  } as Env);
  const command = {
    idempotencyKey: 'projection-player-create',
    playerId: 'projection-player',
    lineUserId: 'projection-line-user',
    displayName: 'Projection Player',
    openingBalanceHundredths: 12_500,
  };

  await client.createPlayer(command);
  await client.createPlayer(command);
  const ledgerEntry = (await client.getLedgerEntries('projection-player'))[0];
  const firstDrain = await client.drainProjections();
  const secondDrain = await client.drainProjections();

  expect(firstDrain).toMatchObject({ delivered: 1 });
  expect(secondDrain).toMatchObject({ delivered: 0 });
  expect(requests).toEqual([{
    eventId: ledgerEntry.entryId,
    accountBalance: 12_500,
  }]);
});
