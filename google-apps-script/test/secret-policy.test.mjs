import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function createGasContext(properties = {}) {
  const sheets = new Map();
  const openedSpreadsheets = [];
  const scriptPropertyWrites = [];
  const context = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] ?? null,
        setProperty: (key, value) => {
          scriptPropertyWrites.push(key);
          properties[key] = value;
        },
        setProperties: (values) => {
          scriptPropertyWrites.push(...Object.keys(values));
          Object.assign(properties, values);
        },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => null,
      openById: (id) => {
        openedSpreadsheets.push(id);
        return {
          getSheetByName: (name) => sheets.get(name) ?? null,
          insertSheet: (name) => {
            const sheet = createSheet();
            sheets.set(name, sheet);
            return sheet;
          },
        };
      },
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content) => ({
        content,
        setMimeType() { return this; },
      }),
    },
    UrlFetchApp: {
      fetch: () => { throw new Error('Unexpected external request'); },
    },
  };
  vm.runInNewContext(code, context, { filename: 'Code.gs' });
  return { context, sheets, openedSpreadsheets, scriptPropertyWrites };
}

function createSheet(initialRows = []) {
  const rows = initialRows.map((row) => [...row]);
  let setValueCalls = 0;
  return {
    rows,
    get setValueCalls() { return setValueCalls; },
    getLastRow: () => rows.length,
    getDataRange: () => ({ getValues: () => rows.map((row) => [...row]) }),
    appendRow: (row) => rows.push([...row]),
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        setValue(value) {
          setValueCalls += 1;
          rows[row - 1] ??= [];
          rows[row - 1][column - 1] = value;
        },
        setValues(values) {
          values.forEach((valuesRow, rowOffset) => {
            rows[row - 1 + rowOffset] ??= [];
            valuesRow.forEach((value, columnOffset) => {
              rows[row - 1 + rowOffset][column - 1 + columnOffset] = value;
            });
          });
        },
      };
    },
  };
}

test('required Script Properties fail explicitly when unset and never use source fallbacks', () => {
  const { context } = createGasContext();

  assert.throws(
    () => context.getScriptSecret_('LINE_CHANNEL_ACCESS_TOKEN'),
    /Required Script Property is missing: LINE_CHANNEL_ACCESS_TOKEN/,
  );
  assert.throws(
    () => context.getSlipApiKey_(),
    /Required Script Property is missing: SLIP_API_KEY/,
  );
  assert.throws(
    () => context.getScriptSecret_('PROJECTION_API_KEY'),
    /Required Script Property is missing: PROJECTION_API_KEY/,
  );
  assert.throws(
    () => context.getWorkerApiUrl_(),
    /Required Script Property is missing: WORKER_API_URL/,
  );
});

test('projection events with the same ledger ID update balances and audit only once', () => {
  const { context, sheets } = createGasContext();
  sheets.set('Players', createSheet([
    ['id', 'name', 'balance', 'createdAt', '', '', '', 'lineUserId'],
    ['player-1', 'Ledger Player', 0, new Date(), '', '', '', 'line-player-1'],
  ]));
  sheets.set('LedgerProjection', createSheet([
    ['eventId', 'accountId', 'deltaHundredths', 'balanceAfterHundredths', 'eventType', 'referenceId', 'createdAt'],
  ]));
  const event = {
    eventId: 'ledger-event-1',
    ledgerEntry: {
      entryId: 'ledger-event-1',
      accountId: 'player-1',
      deltaHundredths: 2500,
      balanceAfterHundredths: 2500,
      eventType: 'deposit',
      referenceId: 'transaction-1',
      createdAt: 1000,
    },
    snapshot: {
      accounts: [{
        playerId: 'player-1',
        lineUserId: 'line-player-1',
        displayName: 'Ledger Player',
        balanceHundredths: 2500,
        active: true,
        kind: 'player',
      }],
    },
  };

  const first = context.applyProjectionEvent_(event);
  const duplicate = context.applyProjectionEvent_(event);

  assert.equal(first.success, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(sheets.get('LedgerProjection').rows.length, 2);
  assert.equal(sheets.get('LedgerProjection').rows[1][0], 'ledger-event-1');
  assert.equal(sheets.get('Players').setValueCalls, 1);
  assert.equal(sheets.get('Players').rows[1][2], 25);
});

test('legacy GAS financial writer entry points reject direct calls without touching Sheets', () => {
  const { context, openedSpreadsheets, scriptPropertyWrites } = createGasContext();
  const forbidden = [
    () => context.adjustPlayerBalance('player-1', 100),
    () => context.saveOpenBet('order-1', 'player-1', 'Player', 'low', 100),
    () => context.matchExistingOpenBet('player-2', 'Player 2', 'order-1'),
    () => context.adminApproveTransaction('transaction-1'),
    () => context.adminRejectTransaction('transaction-1', 'rejected'),
    () => context.adminResolveBets(350),
    () => context.adminVoidRound(),
    () => context.adminSetPlayerBalance('player-1', 100),
    () => context.adminDeletePlayer('player-1'),
    () => context.handleCancelBetRequest('player-1', 'order-1', 'Player'),
    () => context.releasePreQuoteBets(330, 380),
    () => context.setRocketRoundStatus('CLOSED'),
    () => context.setQuoteReleased(true),
    () => context.setActiveRocketRound('Round', 330, 380, false),
    () => context.setTargetMinMax(330, 380),
    () => context.resetGoogleSheetsDatabase(),
  ];

  for (const call of forbidden) {
    assert.equal(call().error, 'MIGRATION_REQUIRED');
  }
  assert.deepEqual(openedSpreadsheets, []);
  assert.deepEqual(scriptPropertyWrites, []);
});

test('admin RPCs proxy to the Worker with the supplied session token', () => {
  const calls = [];
  const { context } = createGasContext({ WORKER_API_URL: 'https://worker.example/api/run' });
  context.UrlFetchApp.fetch = (url, options) => {
    calls.push({ url, options });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ success: true, result: { success: true } }),
    };
  };

  const result = context.executeAdminAction('adminApproveTransaction', ['tx-1'], 'session-1');

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://worker.example/api/run');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer session-1');
  assert.deepEqual(JSON.parse(calls[0].options.payload), {
    functionName: 'adminApproveTransaction',
    args: ['tx-1'],
  });
});

test('unsupported saveOpenBet is rejected instead of proxied', () => {
  const calls = [];
  const { context } = createGasContext({ WORKER_API_URL: 'https://worker.example/api/run' });
  context.UrlFetchApp.fetch = (...args) => {
    calls.push(args);
    throw new Error('Unsupported action must not reach the Worker');
  };

  const result = context.executeAdminAction('saveOpenBet', ['order-1'], 'session-1');

  assert.equal(result.error, 'MIGRATION_REQUIRED');
  assert.deepEqual(calls, []);
});

test('GAS dashboard admin login is forwarded to the Worker', () => {
  const calls = [];
  const { context } = createGasContext({ WORKER_API_URL: 'https://worker.example/api/run' });
  context.UrlFetchApp.fetch = (url, options) => {
    calls.push({ url, options });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        success: true,
        data: { success: true, token: 'local-session-token', expiresAt: 1234, username: 'admin' },
      }),
    };
  };

  const result = context.executeAdminAction('adminLogin', ['admin', 'local-password']);

  assert.equal(result.token, 'local-session-token');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.payload), {
    functionName: 'adminLogin',
    args: ['admin', 'local-password'],
  });
  assert.equal(calls[0].options.headers, undefined);
});

test('public GAS POST accepts only authenticated projection delivery', () => {
  const { context } = createGasContext({ PROJECTION_API_KEY: 'local-projection-test-key' });
  const denied = context.doPost({
    postData: {
      contents: JSON.stringify({ functionName: 'adminResolveBets', args: [350] }),
    },
    parameter: {},
  });
  const allowed = context.doPost({
    postData: {
      contents: JSON.stringify({
        action: 'projection',
        projectionKey: 'local-projection-test-key',
        event: {
          eventId: 'ledger-event-1',
          ledgerEntry: { entryId: 'ledger-event-1', accountId: 'player-1', deltaHundredths: 0, balanceAfterHundredths: 0 },
          snapshot: { accounts: [] },
        },
      }),
    },
    parameter: {},
  });

  assert.match(denied.content, /MIGRATION_REQUIRED/);
  assert.match(allowed.content, /"success":true/);
});
