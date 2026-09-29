import { beforeAll, expect, it } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { createCoordinatorClient } from '../src/financial/client';
import { findSchemaConflicts } from '../src/financial/FinancialCoordinator';
import type { DashboardSnapshot, FinancialSnapshot } from '../src/financial/types';
import { localConflicts, parseArguments } from '../scripts/financial-migration.mjs';

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

function houseAccount(balanceHundredths = 0) {
  return {
    playerId: '__house__',
    lineUserId: null,
    displayName: 'House Commission',
    balanceHundredths,
    active: true,
    kind: 'house' as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

function migrationSnapshotFromDashboard(
  dashboard: DashboardSnapshot,
  snapshotId: string,
): FinancialSnapshot {
  return {
    snapshotId,
    schemaVersion: 'financial-ledger-v1',
    accounts: dashboard.accounts,
    transactions: dashboard.transactions,
    rounds: dashboard.rounds,
    orders: dashboard.orders,
    reconciliation: {
      accountCount: dashboard.accounts.length,
      transactionCount: dashboard.transactions.length,
      roundCount: dashboard.rounds.length,
      orderCount: dashboard.orders.length,
      totalBalanceHundredths: dashboard.totalBalanceHundredths,
    },
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

it('imports and activates a current-coordinator snapshot including the house account', async () => {
  const source = createCoordinatorClient(env, 'financial-migration-house-source');
  const creatorId = 'house-source-creator';
  const matcherId = 'house-source-matcher';
  const roundId = 'house-source-round';
  await source.importSnapshot({
    idempotencyKey: 'house-source-bootstrap',
    snapshot: snapshot({ snapshotId: 'house-source-bootstrap-snapshot' }),
    provenance: 'house-source-test',
  });
  await source.activateAuthority({
    idempotencyKey: 'house-source-bootstrap-activation',
    operatorId: 'test',
    snapshotId: 'house-source-bootstrap-snapshot',
    accountCount: 0,
    transactionCount: 0,
    roundCount: 0,
    orderCount: 0,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  });
  await source.createPlayer({
    idempotencyKey: `${creatorId}-opening`,
    playerId: creatorId,
    lineUserId: `${creatorId}-line`,
    displayName: 'House Source Creator',
    openingBalanceHundredths: 10_000,
  });
  await source.createPlayer({
    idempotencyKey: `${matcherId}-opening`,
    playerId: matcherId,
    lineUserId: `${matcherId}-line`,
    displayName: 'House Source Matcher',
    openingBalanceHundredths: 10_000,
  });
  await source.openRound({ idempotencyKey: `${roundId}-open`, roundId, name: 'House Source Round' });
  await source.releaseQuote({
    idempotencyKey: `${roundId}-quote`,
    roundId,
    targetMin: 10,
    targetMax: 20,
  });
  const order = await source.createOrder({
    idempotencyKey: `${roundId}-order`,
    roundId,
    creatorId,
    side: 'low',
    stakeHundredths: 10_000,
    betType: 'pre_quote',
    rangeMin: 1,
    rangeMax: 2,
    creatorName: 'House Source Creator',
    groupId: `${roundId}-group`,
  });
  await source.matchOrder({
    idempotencyKey: `${roundId}-match`,
    orderNumber: order.orderNumber,
    matcherId,
    stakeHundredths: 10_000,
    matcherName: 'House Source Matcher',
  });
  await source.resolveRound({
    idempotencyKey: `${roundId}-resolve`,
    roundId,
    finalSeconds: 5,
  });

  const imported = migrationSnapshotFromDashboard(
    await source.getSnapshot(),
    'house-source-current-snapshot',
  );
  const target = createCoordinatorClient(env, 'financial-migration-house-target');
  const preview = await target.previewImport(imported);
  expect(preview).toMatchObject({
    canImport: true,
    accountCount: imported.accounts.length,
    totalBalanceHundredths: imported.reconciliation.totalBalanceHundredths,
  });

  const result = await target.importSnapshot({
    idempotencyKey: 'house-target-import',
    snapshot: imported,
    provenance: 'current-coordinator-export',
  });
  await target.activateAuthority({
    idempotencyKey: 'house-target-activation',
    operatorId: 'test',
    snapshotId: imported.snapshotId,
    accountCount: result.importedAccountCount,
    transactionCount: result.importedTransactionCount,
    roundCount: result.importedRoundCount,
    orderCount: result.importedOrderCount,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  });

  const house = await target.getAccount('__house__');
  expect(house).toMatchObject({ kind: 'house', balanceHundredths: 1_000 });
  expect(await target.getLedgerEntries('__house__')).toEqual([
    expect.objectContaining({
      eventType: 'opening_balance',
      deltaHundredths: 1_000,
      balanceAfterHundredths: 1_000,
      referenceId: imported.snapshotId,
      reason: expect.stringContaining('current-coordinator-export'),
    }),
  ]);
  const current = await target.getSnapshot();
  const ledgerTotal = (
    await Promise.all(current.accounts.map((item) => target.getLedgerEntries(item.playerId)))
  ).flat().reduce((total, entry) => total + entry.deltaHundredths, 0);
  expect(ledgerTotal).toBe(current.totalBalanceHundredths);
});

it('resumes committed import chunks without duplicates and blocks activation until complete', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-chunks');
  const imported = snapshot({
    snapshotId: 'chunked-snapshot',
    accounts: [account('chunk-player-1', 100), account('chunk-player-2', 200), houseAccount(300)],
    reconciliation: {
      accountCount: 3,
      transactionCount: 0,
      roundCount: 0,
      orderCount: 0,
      totalBalanceHundredths: 600,
    },
  });

  const first = await client.importSnapshot({
    idempotencyKey: 'chunk-1',
    snapshot: imported,
    provenance: 'chunked-source',
    chunkSize: 1,
    maxChunksPerCall: 1,
  });
  expect(first).toMatchObject({ complete: false, importedAccountCount: 1 });
  await expect(client.activateAuthority({
    idempotencyKey: 'chunked-activation-before-complete',
    operatorId: 'test',
    snapshotId: imported.snapshotId,
    accountCount: 3,
    transactionCount: 0,
    roundCount: 0,
    orderCount: 0,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  })).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' });

  const second = await client.importSnapshot({
    idempotencyKey: 'chunk-2',
    snapshot: imported,
    provenance: 'chunked-source',
    chunkSize: 1,
    maxChunksPerCall: 1,
  });
  expect(second).toMatchObject({ complete: false, importedAccountCount: 2 });
  const completed = await client.importSnapshot({
    idempotencyKey: 'chunk-3',
    snapshot: imported,
    provenance: 'chunked-source',
    chunkSize: 1,
  });
  expect(completed).toMatchObject({
    complete: true,
    importedAccountCount: 3,
    importedTransactionCount: 0,
    importedRoundCount: 0,
    importedOrderCount: 0,
  });
  const replay = await client.importSnapshot({
    idempotencyKey: 'chunk-4',
    snapshot: imported,
    provenance: 'chunked-source',
    chunkSize: 1,
  });
  expect(replay).toEqual(completed);
  expect((await client.getSnapshot()).accounts).toHaveLength(3);
  expect(await client.getLedgerEntries('chunk-player-1')).toHaveLength(1);
  expect(await client.getLedgerEntries('chunk-player-2')).toHaveLength(1);
  expect(await client.getLedgerEntries('__house__')).toHaveLength(1);
});

it('reports an existing LINE user ID collision during preview', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-line-collision');
  await client.importSnapshot({
    idempotencyKey: 'line-collision-bootstrap',
    snapshot: snapshot({ snapshotId: 'line-collision-bootstrap-snapshot' }),
    provenance: 'line-collision-test',
  });
  await client.activateAuthority({
    idempotencyKey: 'line-collision-bootstrap-activation',
    operatorId: 'test',
    snapshotId: 'line-collision-bootstrap-snapshot',
    accountCount: 0,
    transactionCount: 0,
    roundCount: 0,
    orderCount: 0,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  });
  await client.createPlayer({
    idempotencyKey: 'line-collision-existing',
    playerId: 'line-collision-existing',
    lineUserId: 'line-collision',
    displayName: 'Existing',
    openingBalanceHundredths: 0,
  });

  const preview = await client.previewImport(snapshot({
    snapshotId: 'line-collision-new-snapshot',
    accounts: [{ ...account('line-collision-new', 0), lineUserId: 'line-collision' }],
    reconciliation: {
      accountCount: 1,
      transactionCount: 0,
      roundCount: 0,
      orderCount: 0,
      totalBalanceHundredths: 0,
    },
  }));
  expect(preview.canImport).toBe(false);
  expect(preview.conflicts).toContain('duplicate line user ID line-collision');
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

it('makes the local dry-run validator reject every coordinator-invalid snapshot category', () => {
  const conflicts = localConflicts({
    snapshotId: ' ',
    schemaVersion: 'wrong-schema',
    accounts: [
      { ...account('duplicate', 0), lineUserId: 'same-line' },
      { ...account('duplicate', 0), lineUserId: 'same-line' },
      { ...account('negative-decimal', 0), balance: '-1.01', balanceHundredths: undefined },
      { ...account('unsafe-decimal', 0), balance: '1.005', balanceHundredths: undefined },
    ],
    transactions: [{
      transactionId: 'missing-account-transaction',
      playerId: 'missing-account',
      type: 'deposit',
      requestedAmountHundredths: -1,
      actualAmountHundredths: null,
      status: 'legacy',
      bankName: '',
      accountNumber: '',
      accountName: '',
      actorId: null,
      reason: null,
      createdAt: 1,
      updatedAt: 1,
    }],
    rounds: [{
      roundId: 'invalid-round',
      name: 'Invalid',
      status: 'legacy',
      quoteReleased: true,
      targetMin: null,
      targetMax: null,
      createdAt: 1,
      updatedAt: 1,
    }],
    orders: [{
      orderNumber: 'invalid-order',
      roundId: 'missing-round',
      creatorId: 'missing-account',
      creatorName: 'Missing',
      matcherId: null,
      matcherName: null,
      side: 'low',
      stakeHundredths: 0,
      betType: 'range',
      rangeMin: 1,
      rangeMax: 2,
      rangeOffset: 0,
      status: 'legacy',
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

  expect(conflicts).toEqual(expect.arrayContaining([
    'snapshot ID is invalid',
    'schema version must be financial-ledger-v1',
    'duplicate account ID duplicate',
    'duplicate line user ID same-line',
    'account negative-decimal has a negative or unsafe balance',
    'account unsafe-decimal balance is not exactly representable in hundredths',
    'transaction missing-account-transaction has a missing account reference',
    'transaction missing-account-transaction has an unrecognized status',
    'transaction missing-account-transaction has an unsafe amount',
    'round invalid-round has an unrecognized status',
    'order invalid-order has a missing account or round reference',
    'order invalid-order has an unrecognized order status',
    'order invalid-order has an unsafe stake',
    'account count mismatch',
    'total balance mismatch',
  ]));
});

it('rejects malformed pre-existing authority and import schemas explicitly', () => {
  const conflicts = findSchemaConflicts({
    authority_state: {
      sql: 'CREATE TABLE authority_state (authority_id TEXT PRIMARY KEY, active INTEGER)',
      columns: ['authority_id', 'active'],
    },
    imported_snapshots: {
      sql: 'CREATE TABLE imported_snapshots (snapshot_id TEXT PRIMARY KEY)',
      columns: ['snapshot_id'],
    },
  });
  expect(conflicts).toEqual(expect.arrayContaining([
    expect.stringContaining('authority_state'),
    expect.stringContaining('imported_snapshots'),
  ]));
});

it('rejects matched or settled orders without a valid distinct matcher before any import', async () => {
  const client = createCoordinatorClient(env, 'financial-migration-matched-order-guard');
  const round = {
    roundId: 'matched-guard-round',
    name: 'Matched Guard Round',
    status: 'closed' as const,
    quoteReleased: true,
    targetMin: 330,
    targetMax: 380,
    createdAt: 1,
    updatedAt: 1,
  };
  const baseOrder = {
    orderNumber: '000001',
    roundId: round.roundId,
    creatorId: 'matched-guard-creator',
    creatorName: 'Creator',
    side: 'low' as const,
    stakeHundredths: 1_000,
    betType: 'range' as const,
    rangeMin: 330,
    rangeMax: 380,
    rangeOffset: 0,
    groupId: 'matched-guard-group',
    createdAt: 1,
    matchedAt: 1,
    winnerSide: null,
    finalSeconds: null,
    settledAt: null,
  };
  const variants: Array<{ key: string; status: 'matched' | 'resolved' | 'settled'; matcherId: string | null }> = [
    { key: 'matched-no-matcher', status: 'matched', matcherId: null },
    { key: 'matched-self', status: 'matched', matcherId: 'matched-guard-creator' },
    { key: 'matched-unknown', status: 'matched', matcherId: 'matched-guard-ghost' },
    { key: 'settled-no-matcher', status: 'settled', matcherId: null },
    { key: 'resolved-self', status: 'resolved', matcherId: 'matched-guard-creator' },
  ];

  for (const variant of variants) {
    const invalid = snapshot({
      snapshotId: `matched-guard-${variant.key}`,
      accounts: [account('matched-guard-creator', 1_000), houseAccount(0)],
      rounds: [round],
      orders: [{ ...baseOrder, status: variant.status, matcherId: variant.matcherId, matcherName: null }],
      reconciliation: {
        accountCount: 2,
        transactionCount: 0,
        roundCount: 1,
        orderCount: 1,
        totalBalanceHundredths: 1_000,
      },
    });

    const preview = await client.previewImport(invalid);
    expect(preview.canImport).toBe(false);
    expect(preview.conflicts.join('; ')).toContain('valid distinct matcher');

    await expect(client.importSnapshot({
      idempotencyKey: `matched-guard-import-${variant.key}`,
      snapshot: invalid,
      provenance: 'local-test-fixture',
    })).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' });

    // Fail before any partial import: no rows from the rejected snapshot exist.
    const current = await client.getSnapshot();
    expect(current.accounts.filter((row) => row.playerId === 'matched-guard-creator')).toHaveLength(0);
    expect(current.orders).toHaveLength(0);
    expect(current.rounds).toHaveLength(0);
  }
});
