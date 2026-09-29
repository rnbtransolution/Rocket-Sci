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

function localConflicts(snapshot) {
  const conflicts = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return ['snapshot must be an object'];
  }
  if (snapshot.schemaVersion !== 'financial-ledger-v1') {
    conflicts.push('schema version must be financial-ledger-v1');
  }
  for (const name of ['accounts', 'transactions', 'rounds', 'orders']) {
    if (!Array.isArray(snapshot[name])) conflicts.push(`${name} must be an array`);
  }
  for (const account of snapshot.accounts || []) {
    const value = account.balanceHundredths ?? account.balance;
    if (typeof value === 'string' && !/^-?\d+(?:\.\d{1,2})?$/.test(value)) {
      conflicts.push(`account ${account.playerId || '<missing>'} balance is not exactly representable in hundredths`);
    }
    if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isSafeInteger(value * 100))) {
      conflicts.push(`account ${account.playerId || '<missing>'} balance is not exactly representable in hundredths`);
    }
    if (typeof value === 'number' && value < 0) {
      conflicts.push(`account ${account.playerId || '<missing>'} has a negative or unsafe balance`);
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
  const imported = await callWorker(options.url, session, 'importSnapshot', [{
    idempotencyKey: `financial-import:${snapshot.snapshotId}`,
    snapshot,
    provenance,
  }]);
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
