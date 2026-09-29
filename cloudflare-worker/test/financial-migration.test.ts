import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';
import type { FinancialSnapshot } from '../src/financial/types';
import { parseArguments } from '../scripts/financial-migration.mjs';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

function snapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    snapshotId: 'migration-snapshot-1',
    schemaVersion: 'financial-ledger-v1',
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
    ...overrides,
  } as FinancialSnapshot;
}

function account(playerId: string, balanceHundredths = 0) {
  return {
    playerId,
    lineUserId: `${playerId}-line`,
    displayName: playerId,
    balanceHundredths,
    active: true,
    kind: 'player' as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

it('fails every financial write closed before an explicit authority activation', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-gate');

  await expect(client.createPlayer({
    idempotencyKey: 'before-activation',
    playerId: 'before-activation-player',
    lineUserId: 'before-activation-line',
    displayName: 'Before Activation',
    openingBalanceHundredths: 100,
  })).rejects.toMatchObject({ code: 'AUTHORITY_NOT_READY' });

  const current = await client.getSnapshot();
  expect(current.accounts).toHaveLength(1);
  expect(current.transactions).toHaveLength(0);
  expect(current.rounds).toHaveLength(0);
  expect(current.orders).toHaveLength(0);
});

it('reports duplicate IDs, missing references, invalid statuses, and unsafe balances without mutating SQLite', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-validation');
  const invalid = snapshot({
    accounts: [
      account('duplicate-player', 100),
      account('duplicate-player', 200),
      { ...account('unsafe-player'), balance: 1.005 },
    ],
    transactions: [{
      transactionId: 'missing-account-transaction',
      playerId: 'missing-player',
      type: 'deposit',
      requestedAmountHundredths: 100,
      actualAmountHundredths: null,
      status: 'pending',
      bankName: '',
      accountNumber: '',
      accountName: '',
      actorId: null,
      reason: null,
      createdAt: 1,
      updatedAt: 1,
    }],
    orders: [{
      orderNumber: 'invalid-order',
      roundId: 'missing-round',
      creatorId: 'missing-player',
      creatorName: 'Missing',
      matcherId: null,
      matcherName: null,
      side: 'low',
      stakeHundredths: 100,
      betType: 'range',
      rangeMin: 1,
      rangeMax: 2,
      rangeOffset: 0,
      status: 'legacy_status',
      groupId: 'group',
      createdAt: 1,
      matchedAt: null,
      winnerSide: null,
      finalSeconds: null,
      settledAt: null,
    }],
    reconciliation: {
      accountCount: 99,
      transactionCount: 0,
      roundCount: 0,
      orderCount: 0,
      totalBalanceHundredths: 999,
    },
  });

  const preview = await client.previewImport(invalid);

  expect(preview.canImport).toBe(false);
  expect(preview.conflicts).toEqual(  expect.arrayContaining([
    expect.stringContaining('duplicate account ID'),
    expect.stringContaining('missing account reference'),
    expect.stringContaining('unrecognized order status'),
    expect.stringContaining('balance is not exactly representable in hundredths'),
    expect.stringContaining('account count mismatch'),
  ]));
  const current = await client.getSnapshot();
  expect(current.accounts).toHaveLength(1);
  expect(current.transactions).toHaveLength(0);
  expect(current.rounds).toHaveLength(0);
  expect(current.orders).toHaveLength(0);
});

it('keeps dry-run side-effect free and rejects a negative source balance', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-dry-run');
  const preview = await client.previewImport(snapshot({
    accounts: [account('negative-player', -1)],
    reconciliation: {
      accountCount: 1,
      transactionCount: 0,
      roundCount: 0,
      orderCount: 0,
      totalBalanceHundredths: -1,
    },
  }));

  expect(preview.canImport).toBe(false);
  expect(preview.conflicts).toContain('account negative-player has a negative or unsafe balance');
  const current = await client.getSnapshot();
  expect(current.accounts.some((item) => item.playerId === '__house__' && item.balanceHundredths === 0)).toBe(true);
  expect(current.transactions).toEqual([]);
  expect(current.rounds).toEqual([]);
  expect(current.orders).toEqual([]);
});

it('converts exactly representable decimal balances to hundredths without truncation', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-precision');
  const imported = snapshot({
    snapshotId: 'precision-snapshot',
    accounts: [{
      ...account('decimal-player'),
      balanceHundredths: undefined,
      balance: '51.10',
    }],
    reconciliation: {
      accountCount: 1,
      transactionCount: 0,
      roundCount: 0,
      orderCount: 0,
      totalBalanceHundredths: 5_110,
    },
  });

  await client.importSnapshot({
    idempotencyKey: 'precision-import',
    snapshot: imported,
    provenance: 'decimal-source',
  });

  expect(await client.getAccount('decimal-player')).toMatchObject({ balanceHundredths: 5_110 });
  expect(await client.getLedgerEntries('decimal-player')).toEqual([
    expect.objectContaining({ deltaHundredths: 5_110, balanceAfterHundredths: 5_110 }),
  ]);
});

it('imports a verified snapshot exactly once and preserves financial state and provenance', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-import');
  const imported = snapshot({
    snapshotId: 'preserve-state-snapshot',
    accounts: [account('import-creator', 12_345), account('import-matcher', 6_700)],
    transactions: [{
      transactionId: 'pending-import-transaction',
      playerId: 'import-creator',
      type: 'deposit',
      requestedAmountHundredths: 500,
      actualAmountHundredths: null,
      status: 'pending',
      bankName: '',
      accountNumber: '',
      accountName: '',
      actorId: null,
      reason: null,
      createdAt: 10,
      updatedAt: 10,
    }],
    rounds: [{
      roundId: 'import-active-round',
      name: 'Imported Active Round',
      status: 'active',
      quoteReleased: true,
      targetMin: 330,
      targetMax: 380,
      createdAt: 10,
      updatedAt: 10,
    }],
    orders: [{
      orderNumber: 'import-matched-order',
      roundId: 'import-active-round',
      creatorId: 'import-creator',
      creatorName: 'Creator',
      matcherId: 'import-matcher',
      matcherName: 'Matcher',
      side: 'low',
      stakeHundredths: 1_000,
      betType: 'custom_range',
      rangeMin: 330,
      rangeMax: 380,
      rangeOffset: 0,
      status: 'matched',
      groupId: 'import-group',
      createdAt: 10,
      matchedAt: 11,
      winnerSide: null,
      finalSeconds: null,
      settledAt: null,
    }],
    reconciliation: {
      accountCount: 2,
      transactionCount: 1,
      roundCount: 1,
      orderCount: 1,
      totalBalanceHundredths: 19_045,
    },
  });

  const first = await client.importSnapshot({
    idempotencyKey: 'import-chunk-1',
    snapshot: imported,
    provenance: 'legacy-export-2026-09-29',
  });
  const replay = await client.importSnapshot({
    idempotencyKey: 'import-chunk-1',
    snapshot: imported,
    provenance: 'legacy-export-2026-09-29',
  });
  const restarted = await client.importSnapshot({
    idempotencyKey: 'import-chunk-2',
    snapshot: imported,
    provenance: 'legacy-export-2026-09-29',
  });

  expect(replay).toEqual(first);
  expect(restarted).toEqual(first);
  expect(first).toMatchObject({
    importedAccountCount: 2,
    importedTransactionCount: 1,
    importedRoundCount: 1,
    importedOrderCount: 1,
  });
  expect(await client.getAccount('import-creator')).toMatchObject({ balanceHundredths: 12_345 });
  const preserved = await client.getSnapshot();
  expect(preserved.transactions).toEqual([
    expect.objectContaining({
      transactionId: 'pending-import-transaction',
      status: 'pending',
      playerId: 'import-creator',
    }),
  ]);
  expect(preserved.rounds).toEqual([
    expect.objectContaining({
      roundId: 'import-active-round',
      status: 'active',
      quoteReleased: true,
      targetMin: 330,
      targetMax: 380,
    }),
  ]);
  expect(await client.getOrder('import-matched-order')).toMatchObject({
    status: 'matched',
    roundId: 'import-active-round',
  });
  expect(await client.getOrdersByStatus(['matched'])).toHaveLength(1);
  expect((await client.getLedgerEntries('import-creator'))).toEqual([
    expect.objectContaining({
      eventType: 'opening_balance',
      deltaHundredths: 12_345,
      referenceId: 'preserve-state-snapshot',
      reason: expect.stringContaining('legacy-export-2026-09-29'),
    }),
  ]);
});

it('requires verified snapshot identity, totals, and zero conflicts before activation', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-activation');
  const imported = snapshot({
    snapshotId: 'activation-snapshot',
    accounts: [account('activation-player', 1_000)],
    reconciliation: {
      accountCount: 1,
      transactionCount: 0,
      roundCount: 0,
      orderCount: 0,
      totalBalanceHundredths: 1_000,
    },
  });

  await expect(client.activateAuthority({
    idempotencyKey: 'activation-before-import',
    operatorId: 'operator',
    snapshotId: imported.snapshotId,
    accountCount: 1,
    transactionCount: 0,
    roundCount: 0,
    orderCount: 0,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  })).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' });

  await client.importSnapshot({
    idempotencyKey: 'activation-import',
    snapshot: imported,
    provenance: 'activation-test',
  });
  await expect(client.activateAuthority({
    idempotencyKey: 'activation-wrong-totals',
    operatorId: 'operator',
    snapshotId: imported.snapshotId,
    accountCount: 2,
    transactionCount: 0,
    roundCount: 0,
    orderCount: 0,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  })).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' });

  await client.activateAuthority({
    idempotencyKey: 'activation-success',
    operatorId: 'operator',
    snapshotId: imported.snapshotId,
    accountCount: 1,
    transactionCount: 0,
    roundCount: 0,
    orderCount: 0,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  });
  await expect(client.createPlayer({
    idempotencyKey: 'after-activation',
    playerId: 'after-activation-player',
    lineUserId: 'after-activation-line',
    displayName: 'After Activation',
    openingBalanceHundredths: 100,
  })).resolves.toMatchObject({ balanceHundredths: 100 });
});

it('routes migration RPCs through the authenticated Worker endpoint', async () => {
  const snapshotInput = snapshot({ snapshotId: 'route-preview-snapshot' });
  const login = await SELF.fetch('https://worker.test/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ functionName: 'adminLogin', args: ['admin', 'local-test-admin-password'] }),
  });
  const loginBody = await login.json() as { data: { token: string } };
  const response = await SELF.fetch('https://worker.test/api/run', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${loginBody.data.token}`,
    },
    body: JSON.stringify({ functionName: 'previewImport', args: [snapshotInput] }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { canImport: true, snapshotId: 'route-preview-snapshot' } });
});

it('defaults the migration CLI to local dry-run and requires explicit apply inputs', () => {
  expect(parseArguments(['snapshot.json'])).toEqual({
    snapshotPath: 'snapshot.json',
    dryRun: true,
    apply: false,
    url: null,
  });
  expect(parseArguments(['snapshot.json', '--dry-run'])).toMatchObject({
    dryRun: true,
    apply: false,
  });
  expect(() => parseArguments(['snapshot.json', '--apply'])).toThrowError('--url');
  expect(() => parseArguments(['snapshot.json', '--apply', '--url', 'https://worker.test/']))
    .toThrowError('ROCKET_ADMIN_SESSION');
  expect(() => parseArguments(['--dry-run'])).toThrowError('snapshot');
});
