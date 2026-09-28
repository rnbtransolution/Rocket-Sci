import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';
import type { Env } from '../src/types';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
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
