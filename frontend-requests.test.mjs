import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DASHBOARD_PAGE_LIMITS,
  buildRunBody,
  createRequestId,
  isSupportedFinalTime,
} from './frontendRequests.js';

test('createRequestId produces unique non-empty IDs', () => {
  const first = createRequestId();
  const second = createRequestId();
  assert.equal(typeof first, 'string');
  assert.ok(first.length >= 8);
  assert.notEqual(first, second);
});

test('buildRunBody forwards a stable request ID at the top level', () => {
  assert.deepEqual(buildRunBody('adminOpenRound', ['Round'], 'req-1'), {
    functionName: 'adminOpenRound',
    args: ['Round'],
    requestId: 'req-1',
  });
  assert.deepEqual(buildRunBody('getDashboardData', []), {
    functionName: 'getDashboardData',
    args: [],
  });
  assert.equal('requestId' in buildRunBody('getDashboardData', [], undefined), false);
});

test('dashboard page limits stay within the bounded Worker caps', () => {
  assert.ok(Number.isSafeInteger(DASHBOARD_PAGE_LIMITS.playersLimit));
  assert.ok(Number.isSafeInteger(DASHBOARD_PAGE_LIMITS.transactionsLimit));
  assert.ok(DASHBOARD_PAGE_LIMITS.playersLimit >= 1 && DASHBOARD_PAGE_LIMITS.playersLimit <= 500);
  assert.ok(DASHBOARD_PAGE_LIMITS.transactionsLimit >= 1 && DASHBOARD_PAGE_LIMITS.transactionsLimit <= 500);
});

test('isSupportedFinalTime accepts tenths precision and rejects finer or malformed values', () => {
  assert.equal(isSupportedFinalTime(355.5), true);
  assert.equal(isSupportedFinalTime(330), true);
  assert.equal(isSupportedFinalTime(380.1), true);
  assert.equal(isSupportedFinalTime(355.55), false);
  assert.equal(isSupportedFinalTime(-1), false);
  assert.equal(isSupportedFinalTime(0), false);
  assert.equal(isSupportedFinalTime(Number.NaN), false);
  assert.equal(isSupportedFinalTime('355.5'), true);
});

test('App.jsx wires stable request IDs and bounded polling', async () => {
  const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  // Stable IDs are created once per admin action and reused on retry.
  assert.match(app, /createRequestId/);
  assert.match(app, /const resolveRequestId = createRequestId\(\)/);
  assert.match(app, /runBackendFunction\('adminResolveBets', \[finalTime, tMin, tMax\], resolveRequestId\)/);
  assert.match(app, /runBackendFunction\('adminApproveTransaction', \[txId\], approveRequestId\)/);
  assert.match(app, /runBackendFunction\('adminRejectTransaction', \[txId, reason\], rejectRequestId\)/);

  // Both transports forward the request ID: top-level for the direct Worker
  // body and as the explicit 4th argument for the GAS proxy.
  assert.match(app, /buildRunBody\(functionName, args, requestId\)/);
  assert.match(app, /runner\.executeAdminAction\(functionName, args, token, requestId\)/);

  // Polling passes explicit bounded page limits.
  assert.match(app, /runBackendFunction\('getDashboardData', \[DASHBOARD_PAGE_LIMITS\]\)/);

  // The tenths-of-a-second final-time input is preserved and validated.
  assert.match(app, /step="0\.1"/);
  assert.match(app, /isSupportedFinalTime/);
});
