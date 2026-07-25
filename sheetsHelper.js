import { google } from 'googleapis';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

let sheetsClient = null;
const spreadsheetId = process.env.SPREADSHEET_ID;

// Initialize Sheets API Client
export async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable is not defined.');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// Background write queue to process updates sequentially (avoid rate limits & concurrent updates)
const writeQueue = [];
let processing = false;

async function processQueue() {
  if (processing || writeQueue.length === 0) return;
  processing = true;

  while (writeQueue.length > 0) {
    const task = writeQueue[0];
    try {
      await task();
    } catch (err) {
      console.error('Error executing Google Sheets write task:', err);
    }
    writeQueue.shift();
  }

  processing = false;
}

export function queueWrite(task) {
  writeQueue.push(task);
  processQueue();
}

// Fetch all sheets in one batch call for startup speed
export async function batchFetchSheets() {
  const sheets = await getSheetsClient();
  try {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ['Players!A:G', 'Transactions!A:I', 'Bets!A:L', 'LineChatLogs!A:F'],
    });

    const valueRanges = response.data.valueRanges || [];
    return {
      players: valueRanges[0]?.values || [],
      transactions: valueRanges[1]?.values || [],
      bets: valueRanges[2]?.values || [],
      chatLogs: valueRanges[3]?.values || [],
    };
  } catch (err) {
    console.error('Error batch fetching sheets:', err);
    throw err;
  }
}

// Append a row to a sheet in the background
export function appendRowToSheet(sheetName, rowValues) {
  queueWrite(async () => {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:A`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [rowValues],
      },
    });
    console.log(`[Google Sheets] Appended row to ${sheetName}`);
  });
}

// Update a row's values by looking up the ID in the first column
export function updateRowInSheet(sheetName, idValue, columnIndexMap) {
  queueWrite(async () => {
    const sheets = await getSheetsClient();
    
    // 1. Fetch the first column to locate the row index
    const colResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:A`,
    });
    
    const rows = colResponse.data.values || [];
    const cleanSearchId = idValue.toString().trim().toLowerCase();
    
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      const cellVal = rows[i][0] ? rows[i][0].toString().trim().toLowerCase() : '';
      if (cellVal === cleanSearchId) {
        rowIndex = i + 1; // 1-based row index in Google Sheets
        break;
      }
    }
    
    if (rowIndex === -1) {
      console.warn(`[Google Sheets] Could not find row with ID "${idValue}" in ${sheetName}`);
      return;
    }

    // 2. Perform updates for each column specified
    // columnIndexMap is an object like: { colIndex (0-based): newValue }
    const batchUpdates = [];
    for (const [colIndexStr, val] of Object.entries(columnIndexMap)) {
      const colIndex = parseInt(colIndexStr, 10);
      const colLetter = getColumnLetter(colIndex);
      batchUpdates.push({
        range: `${sheetName}!${colLetter}${rowIndex}`,
        values: [[val]],
      });
    }

    if (batchUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: batchUpdates,
        },
      });
      console.log(`[Google Sheets] Updated row ${rowIndex} in ${sheetName} for ID "${idValue}"`);
    }
  });
}

// Overwrite an entire sheet's content (e.g. for database resets)
export function overwriteSheet(sheetName, dataMatrix) {
  queueWrite(async () => {
    const sheets = await getSheetsClient();
    
    // 1. Clear contents
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });
    
    // 2. Update with new matrix
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: dataMatrix,
      },
    });
    console.log(`[Google Sheets] Overwrote sheet ${sheetName} with ${dataMatrix.length} rows`);
  });
}

// Convert 0-based column index to Excel column letter (0 = A, 1 = B, etc.)
function getColumnLetter(colIndex) {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}
