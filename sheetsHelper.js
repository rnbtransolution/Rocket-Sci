import { google } from 'googleapis';
import dotenv from 'dotenv';
import https from 'https';
import NodeCache from 'node-cache';

dotenv.config();

const spreadsheetId = process.env.SPREADSHEET_ID;

// Reusable HTTPS agent with persistent Keep-Alive to eliminate TCP/TLS handshake latency
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

// Singleton Memoized Clients
let authClient = null;
let sheetsClient = null;
let parsedCredentials = null;

// In-Memory Cache for Google Sheets read operations (default TTL: 60 seconds)
const sheetsCache = new NodeCache({
  stdTTL: 60,
  checkperiod: 120,
  useClones: false,
});

// In-Memory Row Index Cache: Map<sheetName, Map<idValueClean, rowIndex>>
// Eliminates repetitive "GET ${sheetName}!A:A" calls on every update
const rowIndexCache = new Map();

/**
 * Populate or update the row index cache for a given sheet.
 * @param {string} sheetName - e.g. 'Players', 'Transactions', 'Bets'
 * @param {Array<Array>} rows - 2D matrix from Google Sheets
 */
function populateRowIndexCache(sheetName, rows) {
  if (!Array.isArray(rows)) return;
  let sheetMap = rowIndexCache.get(sheetName);
  if (!sheetMap) {
    sheetMap = new Map();
    rowIndexCache.set(sheetName, sheetMap);
  }
  sheetMap.clear();

  // Row 1 is header, data starts at index 1 -> row 2 in Sheets
  for (let i = 1; i < rows.length; i++) {
    const rawVal = rows[i]?.[0];
    if (rawVal !== undefined && rawVal !== null) {
      const cleanId = String(rawVal).trim().toLowerCase();
      if (cleanId) {
        sheetMap.set(cleanId, i + 1);
      }
    }
  }
}

/**
 * Get the 1-based row index for an entity ID in a given sheet.
 * Fast O(1) lookup from in-memory cache, falling back to column A fetch if not found.
 */
async function getRowIndex(sheetName, idValue) {
  const cleanId = String(idValue).trim().toLowerCase();
  const sheetMap = rowIndexCache.get(sheetName);
  if (sheetMap && sheetMap.has(cleanId)) {
    return sheetMap.get(cleanId);
  }

  // Cache miss: fetch column A directly from Sheets and populate cache
  const sheets = await getSheetsClient();
  if (!sheets || !spreadsheetId) return -1;

  try {
    const colResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:A`,
    });

    const rows = colResponse.data.values || [];
    populateRowIndexCache(sheetName, rows);

    const refreshedMap = rowIndexCache.get(sheetName);
    return refreshedMap?.get(cleanId) || -1;
  } catch (err) {
    console.error(`[Sheets Cache] Error fetching row index for ${sheetName}:${idValue}:`, err.message);
    return -1;
  }
}

/**
 * Initialize and memoize Google Sheets API client with persistent HTTP keep-alive.
 */
export async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  if (!authClient) {
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      try {
        if (!parsedCredentials) {
          parsedCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        }
        authClient = new google.auth.GoogleAuth({
          credentials: parsedCredentials,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          clientOptions: { agent: httpsAgent },
        });
      } catch (e) {
        console.error('[Sheets] Error parsing GOOGLE_CREDENTIALS_JSON env var:', e);
      }
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      try {
        const credentials = {
          client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        };
        authClient = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          clientOptions: { agent: httpsAgent },
        });
      } catch (e) {
        console.error('[Sheets] Error setting up GOOGLE_SERVICE_ACCOUNT_EMAIL auth:', e);
      }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      try {
        authClient = new google.auth.GoogleAuth({
          keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          clientOptions: { agent: httpsAgent },
        });
      } catch (e) {
        console.error('[Sheets] Error loading GOOGLE_APPLICATION_CREDENTIALS file:', e);
      }
    }
  }

  if (!authClient) {
    console.warn('⚠️ [Sheets] Google credentials env var not set. Running in memory storage mode.');
    return null;
  }

  sheetsClient = google.sheets({
    version: 'v4',
    auth: authClient,
  });

  return sheetsClient;
}

// ─── BACKGROUND WRITE QUEUE & BATCH COALESCER ───────────────────────────────────

const writeQueue = [];
let isQueueProcessing = false;

async function processQueue() {
  if (isQueueProcessing || writeQueue.length === 0) return;
  isQueueProcessing = true;

  while (writeQueue.length > 0) {
    const task = writeQueue[0];
    try {
      await task();
    } catch (err) {
      console.error('[WriteQueue] Error executing task:', err.message || err);
    }
    writeQueue.shift();
  }

  isQueueProcessing = false;
}

export function queueWrite(task) {
  writeQueue.push(task);
  processQueue();
}

// ─── BATCH UPDATE COALESCER (Consolidates multi-cell/multi-row updates into 1 API call) ───

let pendingBatchUpdates = [];
let batchUpdateTimer = null;

async function flushBatchUpdates() {
  if (pendingBatchUpdates.length === 0) return;

  const updatesToSend = [...pendingBatchUpdates];
  pendingBatchUpdates = [];
  batchUpdateTimer = null;

  queueWrite(async () => {
    const sheets = await getSheetsClient();
    if (!sheets || !spreadsheetId) return;

    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updatesToSend,
        },
      });
      console.log(`[Google Sheets] Successfully flushed ${updatesToSend.length} cell updates via single batchUpdate`);
    } catch (err) {
      console.error('[Google Sheets] Error executing coalesced batchUpdate:', err.message || err);
    }
  });
}

function scheduleBatchUpdate(range, values) {
  pendingBatchUpdates.push({ range, values });
  if (!batchUpdateTimer) {
    batchUpdateTimer = setTimeout(flushBatchUpdates, 120); // 120ms debounce window
  }
}

// ─── CHAT LOG BUFFER (Buffers high-frequency group chat logging) ────────────────

const pendingChatLogs = [];
let chatLogFlushTimer = null;

async function flushChatLogs() {
  if (pendingChatLogs.length === 0) return;

  const rowsToAppend = [...pendingChatLogs];
  pendingChatLogs.length = 0;
  chatLogFlushTimer = null;

  queueWrite(async () => {
    const sheets = await getSheetsClient();
    if (!sheets || !spreadsheetId) return;

    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'LineChatLogs!A:A',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: rowsToAppend,
        },
      });
      console.log(`[Google Sheets] Flushed ${rowsToAppend.length} batched chat logs to LineChatLogs`);
    } catch (err) {
      console.error('[Google Sheets] Error flushing batched LineChatLogs:', err.message || err);
    }
  });
}

function bufferChatLog(rowValues) {
  pendingChatLogs.push(rowValues);
  // Auto-flush immediately if buffer reaches 15 items, otherwise flush within 3 seconds
  if (pendingChatLogs.length >= 15) {
    if (chatLogFlushTimer) clearTimeout(chatLogFlushTimer);
    flushChatLogs();
  } else if (!chatLogFlushTimer) {
    chatLogFlushTimer = setTimeout(flushChatLogs, 3000);
  }
}

// ─── PUBLIC API METHODS ────────────────────────────────────────────────────────

/**
 * Invalidate cached Sheets data (called when external reload is triggered or after mutations)
 */
export function invalidateSheetsCache() {
  sheetsCache.del('batch_sheets_data');
}

/**
 * Fetch all sheets in one batch call with in-memory caching.
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - If true, bypasses in-memory cache
 */
export async function batchFetchSheets(options = {}) {
  const force = options?.force === true;
  const cacheKey = 'batch_sheets_data';

  if (!force) {
    const cached = sheetsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const sheets = await getSheetsClient();
  if (!sheets || !spreadsheetId) {
    return { players: [], transactions: [], bets: [], chatLogs: [] };
  }

  try {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ['Players!A:H', 'Transactions!A:I', 'Bets!A:L', 'LineChatLogs!A:F'],
    });

    const valueRanges = response.data.valueRanges || [];
    const result = {
      players: valueRanges[0]?.values || [],
      transactions: valueRanges[1]?.values || [],
      bets: valueRanges[2]?.values || [],
      chatLogs: valueRanges[3]?.values || [],
    };

    // Cache the fresh dataset in memory
    sheetsCache.set(cacheKey, result);

    // Warm up row index cache for instant lookups
    populateRowIndexCache('Players', result.players);
    populateRowIndexCache('Transactions', result.transactions);
    populateRowIndexCache('Bets', result.bets);

    return result;
  } catch (err) {
    console.error('[Google Sheets] Error batch fetching sheets:', err.message || err);
    // Return stale cache if available on error
    const stale = sheetsCache.get(cacheKey);
    if (stale) return stale;
    return { players: [], transactions: [], bets: [], chatLogs: [] };
  }
}

/**
 * Append a row to a sheet.
 * High-velocity 'LineChatLogs' are buffered automatically; other sheets are queued directly.
 */
export function appendRowToSheet(sheetName, rowValues) {
  if (sheetName === 'LineChatLogs') {
    bufferChatLog(rowValues);
    return;
  }

  queueWrite(async () => {
    const sheets = await getSheetsClient();
    if (!sheets || !spreadsheetId) return;

    try {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:A`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [rowValues],
        },
      });

      // Update row index cache with the newly appended row
      const updatedRange = res.data?.updates?.updatedRange;
      if (updatedRange && rowValues[0]) {
        const match = updatedRange.match(/!A(\d+)/);
        if (match) {
          const newRowIndex = parseInt(match[1], 10);
          const cleanId = String(rowValues[0]).trim().toLowerCase();
          let sheetMap = rowIndexCache.get(sheetName);
          if (!sheetMap) {
            sheetMap = new Map();
            rowIndexCache.set(sheetName, sheetMap);
          }
          sheetMap.set(cleanId, newRowIndex);
        }
      }
      console.log(`[Google Sheets] Appended row to ${sheetName}`);
    } catch (err) {
      console.error(`[Google Sheets] Error appending row to ${sheetName}:`, err.message || err);
    }
  });
}

/**
 * Update a row's values by ID.
 * Leverages in-memory row index cache and coalesces multiple cell updates into batchUpdate requests.
 */
export async function updateRowInSheet(sheetName, idValue, columnIndexMap) {
  if (!idValue) return;

  const rowIndex = await getRowIndex(sheetName, idValue);
  if (rowIndex === -1) {
    console.warn(`[Google Sheets] Could not find row index for ID "${idValue}" in ${sheetName}`);
    return;
  }

  for (const [colIndexStr, val] of Object.entries(columnIndexMap)) {
    const colIndex = parseInt(colIndexStr, 10);
    const colLetter = getColumnLetter(colIndex);
    scheduleBatchUpdate(`${sheetName}!${colLetter}${rowIndex}`, [[val]]);
  }
}

/**
 * Overwrite an entire sheet's content (e.g. database resets).
 */
export function overwriteSheet(sheetName, dataMatrix) {
  queueWrite(async () => {
    const sheets = await getSheetsClient();
    if (!sheets || !spreadsheetId) return;

    try {
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${sheetName}!A:Z`,
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: dataMatrix,
        },
      });

      // Reset and rebuild row index cache for this sheet
      populateRowIndexCache(sheetName, dataMatrix);
      invalidateSheetsCache();
      console.log(`[Google Sheets] Overwrote sheet ${sheetName} with ${dataMatrix.length} rows`);
    } catch (err) {
      console.error(`[Google Sheets] Error overwriting sheet ${sheetName}:`, err.message || err);
    }
  });
}

/**
 * Convert 0-based column index to Excel column letter (0 = A, 1 = B, etc.)
 */
export function getColumnLetter(colIndex) {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/**
 * Return in-memory cache statistics for health monitoring.
 */
export function getCacheStats() {
  return {
    sheetsCache: sheetsCache.getStats(),
    cachedKeys: sheetsCache.keys(),
    pendingBatchUpdates: pendingBatchUpdates.length,
    pendingChatLogs: pendingChatLogs.length,
    writeQueueLength: writeQueue.length,
  };
}
