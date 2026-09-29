import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('dashboard settlement presentation consumes committed coordinator amounts', async () => {
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /data\.resolvedOrders/);
  assert.doesNotMatch(app, /Math\.round\(b\.amount \* 1\.90\)/);
  assert.doesNotMatch(app, /const isLowWinner = b\.winnerName === b\.playerLowName/);
  assert.match(app, /winnerCredit/);
  assert.match(app, /90%/);
  assert.match(app, /draw/);
});
