import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function createGasContext() {
  const workerRequests = [];
  const context = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => ({
          WORKER_API_URL: 'https://worker.example.com/api/run',
          SHEET_ID: 'sheet-id',
        })[key] ?? null,
        setProperty: () => undefined,
        setProperties: () => undefined,
      }),
    },
    CacheService: {
      getScriptCache: () => ({ remove: () => undefined }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => null,
      openById: () => { throw new Error('Unexpected spreadsheet access'); },
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        workerRequests.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ result: { success: true } }),
        };
      },
    },
  };
  vm.runInNewContext(code, context, { filename: 'Code.gs' });
  return { context, workerRequests };
}

test('forwards a stable caller-supplied request ID across proxied mutation retries', () => {
  const { context, workerRequests } = createGasContext();

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = context.executeAdminAction('adminOpenRound', ['Retry Round'], 'session-token', 'req-stable-open-1');
    assert.equal(result.success, true);
  }

  assert.equal(workerRequests.length, 2);
  const payloads = workerRequests.map((request) => JSON.parse(request.options.payload));
  for (const payload of payloads) {
    assert.equal(payload.functionName, 'adminOpenRound');
    assert.deepEqual(payload.args, ['Retry Round']);
    assert.equal(payload.requestId, 'req-stable-open-1');
    assert.equal(typeof payload.requestId, 'string');
  }
  assert.equal(payloads[0].requestId, payloads[1].requestId);
  assert.match(String(workerRequests[0].options.headers.Authorization), /^Bearer session-token$/);
});

test('extracts a request ID from a legacy object-shaped args payload', () => {
  const { context, workerRequests } = createGasContext();

  context.executeAdminAction('adminSetPlayerBalance', { requestId: 'req-object-1', 0: 'PLX' }, 'session-token');

  assert.equal(workerRequests.length, 1);
  const payload = JSON.parse(workerRequests[0].options.payload);
  assert.equal(payload.requestId, 'req-object-1');
});

test('does not invent a request ID when the caller provides none', () => {
  const { context, workerRequests } = createGasContext();

  context.executeAdminAction('adminBroadcastFinalCall', ['ALL'], 'session-token');

  assert.equal(workerRequests.length, 1);
  const payload = JSON.parse(workerRequests[0].options.payload);
  assert.equal('requestId' in payload, false);
});
