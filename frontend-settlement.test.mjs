import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('dashboard settlement presentation consumes committed coordinator amounts', async () => {
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /data\.resolvedOrders/);
  assert.match(app, /validateSettlementResponse/);
  assert.match(app, /data\.dashboard\.players/);
  assert.match(app, /data\.dashboard\.transactions/);
  assert.match(app, /data\.dashboard\.bets/);
  assert.doesNotMatch(app, /setBets\(data\.resolvedOrders\)/);
  assert.doesNotMatch(app, /Math\.round\(b\.amount \* 1\.90\)/);
  assert.doesNotMatch(app, /const isLowWinner = b\.winnerName === b\.playerLowName/);
  assert.match(app, /winnerCredit/);
  assert.match(app, /90%/);
  assert.match(app, /draw/);
});

test('dashboard settlement rejects malformed committed payout fields', async () => {
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /Number\.isFinite\(order\.amount\)/);
  assert.match(app, /Number\.isFinite\(order\.winnerCredit\)/);
  assert.match(app, /Number\.isFinite\(order\.houseFee\)/);
  assert.match(app, /throw new Error\(['"]Coordinator settlement response is invalid/);
});
