export function parseArguments(argv, environment = {}) {
  const values = [...argv];
  const snapshotPath = values.shift();
  if (!snapshotPath || snapshotPath.startsWith('--')) {
    throw new Error('An input snapshot path is required');
  }

  let apply = false;
  let dryRun = false;
  let url = null;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--url') {
      url = values[++index];
      if (!url || url.startsWith('--')) throw new Error('--url requires a value');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (apply && dryRun) throw new Error('--apply and --dry-run cannot be combined');
  if (apply && !url) throw new Error('--apply requires --url');
  if (apply && !environment.ROCKET_ADMIN_SESSION) {
    throw new Error('--apply requires ROCKET_ADMIN_SESSION');
  }
  return { snapshotPath, dryRun: !apply, apply, url };
}

function exactHundredths(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > 2) return null;
  const cents = Number(`${whole}${fraction.padEnd(2, '0')}`);
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

function sourceBalanceHundredths(account) {
  if (account.balanceHundredths !== undefined && account.balance !== undefined) return null;
  if (account.balanceHundredths !== undefined) {
    return Number.isSafeInteger(account.balanceHundredths) ? account.balanceHundredths : null;
  }
  return exactHundredths(account.balance);
}

export function localConflicts(snapshot) {
  const conflicts = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return ['snapshot must be an object'];
  }
  if (typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId.trim() ||
      snapshot.snapshotId.trim() !== snapshot.snapshotId) {
    conflicts.push('snapshot ID is invalid');
  }
  if (snapshot.schemaVersion !== 'financial-ledger-v1') {
    conflicts.push('schema version must be financial-ledger-v1');
  }
  for (const name of ['accounts', 'transactions', 'rounds', 'orders']) {
    if (!Array.isArray(snapshot[name])) conflicts.push(`${name} must be an array`);
  }
  const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  const accountIds = new Set();
  const lineUserIds = new Set();
  const roundIds = new Set();
  const transactionIds = new Set();
  const orderIds = new Set();
  let totalBalanceHundredths = 0;
  let houseAccountCount = 0;

  for (const account of accounts) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      conflicts.push('account record is invalid');
      continue;
    }
    const playerId = typeof account.playerId === 'string' ? account.playerId : '';
    if (!playerId || accountIds.has(playerId)) {
      conflicts.push(`duplicate account ID ${playerId || '<missing>'}`);
    }
    accountIds.add(playerId);
    if (account.lineUserId !== null && account.lineUserId !== undefined &&
        typeof account.lineUserId !== 'string') {
      conflicts.push(`account ${playerId || '<missing>'} has an invalid LINE user ID`);
    }
    if (account.lineUserId && lineUserIds.has(account.lineUserId)) {
      conflicts.push(`duplicate line user ID ${account.lineUserId}`);
    }
    if (account.lineUserId) lineUserIds.add(account.lineUserId);
    const balanceHundredths = sourceBalanceHundredths(account);
    if (balanceHundredths === null) {
      conflicts.push(`account ${playerId || '<missing>'} balance is not exactly representable in hundredths`);
    } else {
      if (balanceHundredths < 0 || !Number.isSafeInteger(balanceHundredths)) {
        conflicts.push(`account ${playerId || '<missing>'} has a negative or unsafe balance`);
      }
      totalBalanceHundredths += balanceHundredths;
      if (!Number.isSafeInteger(totalBalanceHundredths)) {
        conflicts.push('total balance exceeds the supported range');
      }
    }
    if (account.kind === 'house') {
      houseAccountCount += 1;
      if (playerId !== '__house__') conflicts.push('house account must use ID __house__');
    } else if (playerId === '__house__') {
      conflicts.push('account __house__ must have kind house');
    }
    if (typeof account.active !== 'boolean' ||
        !['player', 'house'].includes(account.kind)) {
      conflicts.push(`account ${playerId || '<missing>'} has invalid account metadata`);
    }
    if (typeof account.displayName !== 'string' || !account.displayName.trim()) {
      conflicts.push(`account ${playerId || '<missing>'} has an invalid display name`);
    }
  }
  if (houseAccountCount > 1) conflicts.push('snapshot contains multiple house accounts');

  const transactions = Array.isArray(snapshot.transactions) ? snapshot.transactions : [];
  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
      conflicts.push('transaction record is invalid');
      continue;
    }
    const id = typeof transaction.transactionId === 'string' ? transaction.transactionId : '';
    if (!id || transactionIds.has(id)) conflicts.push(`duplicate transaction ID ${id || '<missing>'}`);
    transactionIds.add(id);
    if (!accountIds.has(transaction.playerId)) {
      conflicts.push(`transaction ${id || '<missing>'} has a missing account reference`);
    }
    if (!['deposit', 'withdrawal'].includes(transaction.type)) {
      conflicts.push(`transaction ${id || '<missing>'} has an unrecognized type`);
    }
    if (!['pending', 'approved', 'rejected'].includes(transaction.status)) {
      conflicts.push(`transaction ${id || '<missing>'} has an unrecognized status`);
    }
    if (!Number.isSafeInteger(transaction.requestedAmountHundredths) ||
        transaction.requestedAmountHundredths <= 0 ||
        (transaction.actualAmountHundredths !== null &&
          (!Number.isSafeInteger(transaction.actualAmountHundredths) ||
            transaction.actualAmountHundredths < 0))) {
      conflicts.push(`transaction ${id || '<missing>'} has an unsafe amount`);
    }
  }

  const rounds = Array.isArray(snapshot.rounds) ? snapshot.rounds : [];
  for (const round of rounds) {
    if (!round || typeof round !== 'object' || Array.isArray(round)) {
      conflicts.push('round record is invalid');
      continue;
    }
    const id = typeof round.roundId === 'string' ? round.roundId : '';
    if (!id || roundIds.has(id)) conflicts.push(`duplicate round ID ${id || '<missing>'}`);
    roundIds.add(id);
    if (!['active', 'closed', 'void'].includes(round.status)) {
      conflicts.push(`round ${id || '<missing>'} has an unrecognized status`);
    }
    if (typeof round.quoteReleased !== 'boolean') {
      conflicts.push(`round ${id || '<missing>'} has invalid quote state`);
    }
  }

  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  const validOrderStatuses = [
    'pending_hold',
    'pending_match',
    'matched',
    'cancelled',
    'resolved',
    'settled',
    'void',
  ];
  for (const order of orders) {
    if (!order || typeof order !== 'object' || Array.isArray(order)) {
      conflicts.push('order record is invalid');
      continue;
    }
    const id = typeof order.orderNumber === 'string' ? order.orderNumber : '';
    if (!id || orderIds.has(id)) conflicts.push(`duplicate order ID ${id || '<missing>'}`);
    orderIds.add(id);
    if (!validOrderStatuses.includes(order.status)) {
      conflicts.push(`order ${id || '<missing>'} has an unrecognized order status`);
    }
    if (!roundIds.has(order.roundId) || !accountIds.has(order.creatorId) ||
        (order.matcherId !== null && !accountIds.has(order.matcherId))) {
      conflicts.push(`order ${id || '<missing>'} has a missing account or round reference`);
    }
    if (!Number.isSafeInteger(order.stakeHundredths) || order.stakeHundredths <= 0) {
      conflicts.push(`order ${id || '<missing>'} has an unsafe stake`);
    }
  }

  if (!snapshot.reconciliation || typeof snapshot.reconciliation !== 'object' ||
      Array.isArray(snapshot.reconciliation)) {
    conflicts.push('reconciliation is required');
  } else {
    const reconciliation = snapshot.reconciliation;
    const counts = {
      accountCount: accounts.length,
      transactionCount: transactions.length,
      roundCount: rounds.length,
      orderCount: orders.length,
    };
    for (const [name, actual] of Object.entries(counts)) {
      if (reconciliation[name] !== actual) {
        conflicts.push(`${name.replace(/Count$/, '')} count mismatch`);
      }
    }
    if (!Number.isSafeInteger(reconciliation.totalBalanceHundredths) ||
        reconciliation.totalBalanceHundredths < 0) {
      conflicts.push('total balance is negative or unsafe');
    } else if (reconciliation.totalBalanceHundredths !== totalBalanceHundredths) {
      conflicts.push('total balance mismatch');
    }
  }
  return conflicts;
}

async function readSnapshot(snapshotPath) {
  const { readFile } = await import('node:fs/promises');
  let text;
  try {
    text = await readFile(snapshotPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read snapshot: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Snapshot is not valid JSON: ${error.message}`);
  }
}

function endpointFor(url) {
  const target = new URL(url);
  return target.pathname.endsWith('/api/run') ? target.toString() : new URL('/api/run', target).toString();
}

async function callWorker(url, session, functionName, args) {
  const response = await fetch(endpointFor(url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session}`,
    },
    body: JSON.stringify({ functionName, args }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || body.error || `Worker request failed (${response.status})`);
  }
  return body.data;
}

async function main() {
  const options = parseArguments(process.argv.slice(2), process.env);
  const snapshot = await readSnapshot(options.snapshotPath);
  const conflicts = localConflicts(snapshot);
  if (conflicts.length > 0) {
    throw new Error(`Snapshot validation failed: ${conflicts.join('; ')}`);
  }
  if (options.dryRun) {
    process.stdout.write(`DRY RUN: ${snapshot.snapshotId || '<unnamed snapshot>'}\n`);
    process.stdout.write(`No remote URL selected; no SQLite rows were changed.\n`);
    return;
  }

  const session = process.env.ROCKET_ADMIN_SESSION;
  const preview = await callWorker(options.url, session, 'previewImport', [snapshot]);
  if (!preview?.canImport) {
    throw new Error(`Worker preview rejected the snapshot: ${(preview?.conflicts || []).join('; ')}`);
  }
  const provenance = `financial-migration-cli:${snapshot.snapshotId}`;
  let imported;
  let importAttempt = 0;
  do {
    imported = await callWorker(options.url, session, 'importSnapshot', [{
      idempotencyKey: `financial-import:${snapshot.snapshotId}:${importAttempt}`,
      snapshot,
      provenance,
    }]);
    importAttempt += 1;
  } while (imported?.complete === false);
  await callWorker(options.url, session, 'activateAuthority', [{
    idempotencyKey: `financial-activate:${snapshot.snapshotId}`,
    operatorId: 'financial-migration-cli',
    snapshotId: snapshot.snapshotId,
    accountCount: imported.importedAccountCount,
    transactionCount: imported.importedTransactionCount,
    roundCount: imported.importedRoundCount,
    orderCount: imported.importedOrderCount,
    confirmation: 'ACTIVATE_FINANCIAL_AUTHORITY',
  }]);
  process.stdout.write(`APPLIED: ${snapshot.snapshotId}\n`);
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('financial-migration.mjs')) {
  main().catch((error) => {
    process.stderr.write(`financial-migration: ${error.message}\n`);
    process.exitCode = 1;
  });
}
