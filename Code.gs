// =========================================================================
// GOOGLE APPS SCRIPT WEBHOOK, TELEMETRY & DB CONTROLLER (Code.gs)
// Project: Rocket Science Billing & Telemetry System
// =========================================================================

// CONFIGURATION CONSTANTS (Update these in your GAS environment)
const LINE_CHANNEL_ACCESS_TOKEN = '03Rpw5vvp7hvCWW0gUsvoRGKrUfSLxdkyJg5lnsZ3BR4wmVRsuhIW06AK24fsX5lKeTOnaDgag59kOZe6Hxfv2UQrswlZc7mL4ZeZi5qIz+cuGuOEm3tja0Zx66srJgLREY5dbnaegtCoFZgromcvwdB04t89/1O/w1cDnyilFU=';
const SLIP_API_KEY = '697ef678-60df-4955-a13a-6ed4e26a38c0'; // SlipOk or EasySlip
const SLIP_API_URL = 'https://api.easyslip.com/v2/verify/bank'; // EasySlip bank verification endpoint
let SHEET_ID = '1NaQbaUz8fcgd32sCAfxxKNBnpmFA5vu0_YVSehhdCEQ';
try {
  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (activeSpreadsheet) {
    SHEET_ID = activeSpreadsheet.getId();
  }
} catch (err) {
  console.warn("Using default SPREADSHEET_ID: " + SHEET_ID);
}

/**
 * Group tracking & active group management backed by PropertiesService and Sheets fallback.
 */
function getActiveGroupId() {
  var props = PropertiesService.getScriptProperties();
  var gid = props.getProperty('ACTIVE_GROUP_ID') || '';
  if (gid && gid.length > 5) return gid;

  // Auto-Discovery Fallback: Scan Sheet tabs if properties are uninitialized
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);

    // 1. Check LineGroups sheet tab
    var gSheet = ss.getSheetByName('LineGroups');
    if (gSheet) {
      var gData = gSheet.getDataRange().getValues();
      for (var gi = 1; gi < gData.length; gi++) {
        var sheetGid = (gData[gi][0] || '').toString().trim();
        if (sheetGid && (sheetGid.startsWith('C') || sheetGid.startsWith('R')) && sheetGid.length > 5) {
          props.setProperty('ACTIVE_GROUP_ID', sheetGid);
          return sheetGid;
        }
      }
    }

    // 2. Check Bets sheet
    var bSheet = ss.getSheetByName('Bets');
    if (bSheet) {
      var bData = bSheet.getDataRange().getValues();
      for (var bi = bData.length - 1; bi >= 1; bi--) {
        for (var col = 0; col < bData[bi].length; col++) {
          var val = (bData[bi][col] || '').toString().trim();
          if ((val.startsWith('C') || val.startsWith('R')) && val.length >= 15) {
            props.setProperty('ACTIVE_GROUP_ID', val);
            recordGroupActivity(val, null, null, null, 'Discovered from Bets');
            return val;
          }
        }
      }
    }

    // 3. Check LineChatLogs sheet
    var cSheet = ss.getSheetByName('LineChatLogs');
    if (cSheet) {
      var cData = cSheet.getDataRange().getValues();
      for (var ci = cData.length - 1; ci >= 1; ci--) {
        var logUid = (cData[ci][1] || '').toString().trim();
        if ((logUid.startsWith('C') || logUid.startsWith('R')) && logUid.length >= 15) {
          props.setProperty('ACTIVE_GROUP_ID', logUid);
          recordGroupActivity(logUid, null, null, null, 'Discovered from ChatLogs');
          return logUid;
        }
      }
    }
  } catch (e) {
    Logger.log('[getActiveGroupId] Discovery Error: ' + e.toString());
  }

  return '';
}

function saveActiveGroupId(groupId) {
  if (groupId && typeof groupId === 'string' && groupId.length > 5) {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('ACTIVE_GROUP_ID', groupId.trim());
    recordGroupActivity(groupId.trim(), null, null, null, 'เชื่อมต่อแล้ว');
  }
}

function recordGroupActivity(groupId, groupName, userId, displayName, text) {
  if (!groupId || typeof groupId !== 'string' || groupId.length <= 5) return;
  var gid = groupId.trim();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ACTIVE_GROUP_ID', gid);

  var groupsJson = props.getProperty('LINE_GROUPS') || '[]';
  var groups = [];
  try {
    groups = JSON.parse(groupsJson);
  } catch (e) {
    groups = [];
  }
  var now = new Date();
  var nowStr = Utilities.formatDate(now, 'GMT+7', 'HH:mm');

  var group = null;
  var groupIdx = -1;
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].id === gid) {
      group = groups[i];
      groupIdx = i;
      break;
    }
  }

  var groupNumber = groupIdx !== -1 ? (groupIdx + 1) : (groups.length + 1);
  var cleanName = groupName;
  if (!cleanName || cleanName.startsWith('C') || cleanName.startsWith('R') || cleanName.indexOf(gid) !== -1) {
    cleanName = '🚀 กลุ่มดวลสด #' + groupNumber;
  }

  if (!group) {
    group = {
      id: gid,
      name: cleanName,
      lastMessage: text || 'มีการเคลื่อนไหวในกลุ่ม',
      timestamp: nowStr,
      msgCount: 1
    };
    groups.push(group);
  } else {
    group.lastMessage = text || group.lastMessage;
    group.timestamp = nowStr;
    group.msgCount = (group.msgCount || 0) + 1;
    if (groupName && !groupName.startsWith('C') && !groupName.startsWith('R') && groupName.indexOf(gid) === -1) {
      group.name = groupName;
    }
  }

  props.setProperty('LINE_GROUPS', JSON.stringify(groups));

  // Persist to LineGroups sheet for permanent backup
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var lgSheet = ss.getSheetByName('LineGroups');
    if (!lgSheet) {
      lgSheet = ss.insertSheet('LineGroups');
      lgSheet.appendRow(['Group ID', 'Group Name', 'Last Active', 'Msg Count', 'Last Message']);
    }
    var lgData = lgSheet.getDataRange().getValues();
    var foundRow = -1;
    for (var r = 1; r < lgData.length; r++) {
      if (lgData[r][0] === gid) {
        foundRow = r + 1;
        break;
      }
    }
    if (foundRow !== -1) {
      lgSheet.getRange(foundRow, 2, 1, 4).setValues([[cleanName, now, group.msgCount, (text || '').substring(0, 100)]]);
    } else {
      lgSheet.appendRow([gid, cleanName, now, 1, (text || '').substring(0, 100)]);
    }
  } catch (sheetErr) {
    Logger.log('[recordGroupActivity] Sheet backup error: ' + sheetErr.toString());
  }
}

function getLineGroups() {
  var props = PropertiesService.getScriptProperties();
  var groupsJson = props.getProperty('LINE_GROUPS') || '[]';
  var list = [];
  try {
    list = JSON.parse(groupsJson);
  } catch (e) {}

  if (Array.isArray(list) && list.length > 0) return list;

  // Fallback 1: LineGroups sheet tab
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var lgSheet = ss.getSheetByName('LineGroups');
    if (lgSheet) {
      var lgData = lgSheet.getDataRange().getValues();
      for (var r = 1; r < lgData.length; r++) {
        var gId = (lgData[r][0] || '').toString().trim();
        var gName = (lgData[r][1] || '').toString().trim();
        if (gId && gId.length > 5) {
          list.push({
            id: gId,
            name: gName || ('🚀 กลุ่มดวลสด #' + gId.slice(-4)),
            lastMessage: (lgData[r][4] || 'เชื่อมต่อแล้ว').toString(),
            timestamp: 'Live',
            msgCount: Number(lgData[r][3]) || 1
          });
        }
      }
      if (list.length > 0) {
        props.setProperty('LINE_GROUPS', JSON.stringify(list));
        return list;
      }
    }
  } catch(e) {}

  var activeId = getActiveGroupId();
  if (activeId) {
    var fallbackList = [{
      id: activeId,
      name: '🚀 กลุ่มดวลสด #' + activeId.slice(-4),
      lastMessage: 'เชื่อมต่อแล้ว',
      timestamp: 'Live',
      msgCount: 1
    }];
    props.setProperty('LINE_GROUPS', JSON.stringify(fallbackList));
    return fallbackList;
  }
  return [];
}

function adminOpenRound(name) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var rSheet = ss.getSheetByName('Rockets');
  if (rSheet) {
    var rData = rSheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < rData.length; i++) {
      if (rData[i][0] === name) {
        rSheet.getRange(i + 1, 4).setValue('ACTIVE');
        found = true;
      } else if (rData[i][3] === 'ACTIVE') {
        rSheet.getRange(i + 1, 4).setValue('LOCKED');
      }
    }
    if (!found) {
      rSheet.appendRow([name, 330, 380, 'ACTIVE']);
    }
  }
  setRocketRoundStatus('ACTIVE');
  return getDashboardData();
}

/**
 * HTTP GET: Serves the bundled React Admin & Simulator UI.
 * This runs when accessing the GAS Web App URL in a browser.
 */
function doGet(e) {
  var html;
  try {
    html = HtmlService.createHtmlOutputFromFile('index');
  } catch(_) {
    html = HtmlService.createHtmlOutputFromFile('Index');
  }
  return html
    .setTitle('Rocket Science - ระบบดูแลบิลลิงและควบคุม')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * HTTP POST: LINE OA Webhook endpoint.
 * This receives messages, images, and events sent by players.
 */
function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents);
    const events = postData.events;
    
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const replyToken = event.replyToken;
      const userId = event.source.userId;
      
      // Get Player profile display name from DB first (cached), fallback to API only if new player
      let displayName = getPlayerNameFromDb(userId);
      if (!displayName) {
        const profile = getLineUserProfile(userId);
        displayName = profile ? profile.displayName : "ผู้เล่นนิรนาม";
      }
      
      if (event.type === 'message') {
        const message = event.message;
        const groupId = event.source.groupId || event.source.roomId || null;
        if (groupId) {
          recordGroupActivity(groupId, null, userId, displayName, message.text || '');
        }
        if (message.type === 'text') {
          handleTextMessage(message.text, userId, displayName, replyToken, groupId);
        } else if (message.type === 'image') {
          handleImageSlipMessage(message.id, userId, displayName, replyToken);
        }
      }
    }
  } catch (err) {
    console.error("Webhook POST Error: " + err.toString());
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Helper to format bank account number to keep leading zeros if cut off by Google Sheets.
 */
function formatBankAccount(acc) {
  if (acc === null || acc === undefined) return '';
  let str = acc.toString().trim();
  // If it's purely digits and doesn't start with '0', check if it's missing a leading zero
  if (/^\d+$/.test(str) && !str.startsWith('0')) {
    // If it is 9 digits (standard 10-digit account/mobile), 11 digits (standard 12-digit BAAC/GSB), or 14 digits (standard 15-digit GSB)
    if (str.length === 9 || str.length === 11 || str.length === 14) {
      str = '0' + str;
    }
  }
  return str;
}

/**
 * Helper to clean and normalize User ID (converts case-insensitive 'user' to lowercase 'user').
 */
function cleanUserId(userId) {
  if (userId === null || userId === undefined) return '';
  var id = userId.toString().trim();
  return id.toLowerCase() === 'user' ? 'user' : id;
}

/**
 * Generate a unique Passport-style ID (2 uppercase letters + 6 digits, e.g. RS481729).
 */
function generatePassportStyleId(sheet) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const data = sheet.getDataRange().getValues();
  const existingIds = new Set(data.slice(1).map(row => row[0] ? row[0].toString().trim().toUpperCase() : ''));
  
  let code = '';
  let attempts = 0;
  while (attempts < 1000) {
    const letters = chars[Math.floor(Math.random() * 26)] + chars[Math.floor(Math.random() * 26)];
    const digits = Math.floor(100000 + Math.random() * 900000).toString();
    code = letters + digits;
    if (!existingIds.has(code)) {
      return code;
    }
    attempts++;
  }
  return 'PL' + Date.now().toString().slice(-6); // fallback
}

/**
 * Get or create a unique short Passport-style ID mapped to a raw LINE User ID.
 */
function getOrCreateShortUserId(rawLineUserId, displayName) {
  if (!rawLineUserId) return '';
  const searchId = rawLineUserId.toString().trim();
  
  // If it's already a short ID or a sandbox ID, return as is
  if (searchId.toLowerCase() === 'user' || searchId.length <= 8) {
    return searchId;
  }
  
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  
  // Check column 7 (LINE User ID)
  for (let i = 1; i < data.length; i++) {
    const rowLineId = data[i][7] ? data[i][7].toString().trim() : '';
    if (rowLineId === searchId) {
      return data[i][0] ? data[i][0].toString().trim() : '';
    }
  }
  
  // Check column 0 (User ID) for legacy registrations
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      // If legacy player, update their LINE User ID in column 8 (column index 7)
      sheet.getRange(i + 1, 8).setValue(searchId);
      return rowId;
    }
  }
  
  // Register new player with generated short ID
  const shortId = generatePassportStyleId(sheet);
  sheet.appendRow([shortId, displayName || 'ผู้เล่น LINE', 0, new Date(), '', '', '', searchId]);
  return shortId;
}

/**
 * Translate a short Passport-style ID back to its raw LINE User ID.
 */
function getRawLineUserId(shortUserId) {
  if (!shortUserId) return '';
  const searchId = shortUserId.toString().trim();
  if (searchId.toLowerCase() === 'user' || searchId.length > 8) {
    return searchId;
  }
  
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      const rawLineId = data[i][7] ? data[i][7].toString().trim() : '';
      return rawLineId || searchId;
    }
  }
  return searchId;
}

/**
 * Helper to update a player's registered bank details.
 */
function updatePlayerBank(userId, bankName, accountNumber, accountName) {
  var searchId = cleanUserId(userId);
  if (!searchId) return;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      sheet.getRange(i + 1, 5).setValue(bankName);
      // Force cell formatting as plain text to preserve leading zeros
      sheet.getRange(i + 1, 6).setNumberFormat('@').setValue(accountNumber.toString());
      sheet.getRange(i + 1, 7).setValue(accountName);
      return;
    }
  }
}

/**
 * Helper to retrieve a player's registered bank details.
 */
function getPlayerBank(userId) {
  var searchId = cleanUserId(userId);
  if (!searchId) return null;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      const bankName = data[i][4] ? data[i][4].toString() : '';
      const bankAccount = data[i][5] ? formatBankAccount(data[i][5]) : '';
      const accountName = data[i][6] ? data[i][6].toString() : '';
      if (bankName && bankAccount) {
        return {
          bankName: bankName,
          accountNumber: bankAccount,
          accountName: accountName
        };
      }
    }
  }
  return null;
}

/**
 * Check if a player has any successful deposit on record (Transactions sheet).
 * Returns true if the player has at least one 'success' deposit, or an approved manual deposit.
 */
function hasSuccessfulDeposit(userId) {
  if (!userId) return false;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Transactions');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
  for (let i = 1; i < data.length; i++) {
    const rowUserId = data[i][1] ? data[i][1].toString().trim() : '';
    const txId = data[i][0] ? data[i][0].toString() : '';
    const status = data[i][6] ? data[i][6].toString() : '';
    // Must be a deposit transaction (TX prefix), not withdrawal (WD prefix)
    if (rowUserId === searchId && txId.indexOf('WD') !== 0 && status === 'success') {
      return true;
    }
  }
  return false;
}

/**
 * Helper to get active bets for a player.
 */
function getPlayerActiveBets(userId) {
  var searchId = cleanUserId(userId);
  if (!searchId) return [];
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  const data = sheet.getDataRange().getValues();
  const activeBets = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[9];
    if (status === 'matched' || status === 'pending_match') {
      const playerLowId = row[1] ? row[1].toString().trim() : '';
      const playerHighId = row[3] ? row[3].toString().trim() : '';
      if (playerLowId === searchId || playerHighId === searchId) {
        activeBets.push({
          orderNumber: row[0].toString(),
          playerLowId: playerLowId,
          playerLowName: row[2].toString(),
          playerHighId: playerHighId,
          playerHighName: row[4].toString(),
          amount: Number(row[5]) || 0,
          type: row[6].toString(),
          rangeMin: row[7] ? Number(row[7]) : null,
          rangeMax: row[8] ? Number(row[8]) : null,
          status: status,
          opponentName: playerLowId === searchId ? row[4].toString() : row[2].toString()
        });
      }
    }
  }
  return activeBets;
}

/**
 * Helper to request bet cancellation or direct cancel.
 */
/**
 * Helper to request bet cancellation or direct cancel.
 */
function handleCancelBetRequest(userId, orderNo, displayName) {
  var searchId = cleanUserId(userId);
  if (!searchId || !orderNo) return "🚫 ไม่สามารถทำรายการยกเลิกได้ครับ";
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  const data = sheet.getDataRange().getValues();
  const searchOrder = orderNo.toString().trim().replace(/#/g, '');
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0].toString().trim() === searchOrder || row[0].toString().trim().endsWith(searchOrder)) {
      const status = row[9];
      const playerLowId = row[1] ? row[1].toString().trim() : '';
      const playerLowName = row[2] ? row[2].toString().trim() : '';
      const playerHighId = row[3] ? row[3].toString().trim() : '';
      const playerHighName = row[4] ? row[4].toString().trim() : '';
      const amount = Number(row[5]) || 0;
      
      const isCreator = (playerLowId === searchId || playerHighId === searchId || 
                         playerLowId === cleanUserId(userId) || playerHighId === cleanUserId(userId) ||
                         (displayName && (playerLowName === displayName || playerHighName === displayName)));
      if (!isCreator && searchId !== 'admin') {
        return "🚫 ขออภัยครับ แผลดวลนี้ไม่ใช่แผลของคุณ";
      }
      
      if (status === 'resolved' || status === 'cancelled' || status === 'void') {
        return `⚠️ แผลดวล Order #${orderNo} จบหรือถูกยกเลิกแล้วครับ`;
      }
      
      if (status === 'pending_match') {
        // Direct cancel
        sheet.getRange(i + 1, 10).setValue('cancelled');
        // Refund credit to the creator
        adjustPlayerBalance(userId, amount);
        var targetGroupId = (row[12] && row[12].toString().trim()) || (row[7] && row[7].toString().trim()) || getActiveGroupId();
        return {
          success: true,
          flex: constructCancelOrderMiniFlex(row[0].toString().trim()),
          orderNo: row[0].toString().trim(),
          targetGroupId: targetGroupId
        };
      }
      
      if (status === 'matched') {
        // Request cancel
        sheet.getRange(i + 1, 10).setValue('pending_cancel');
        return `⛔ ร้องขอยกเลิก Order #${orderNo} (รอคู่ดวลกดยืนยันครับ 🚀)`;
      }
    }
  }
  return `🚫 ไม่พบแผลดวล Order #${orderNo} ในระบบครับ`;
}

/**
 * Handle incoming LINE text commands (ชล200, ชย500, ต, เช็คยอด, ถอนยอด, ฝากเงิน, etc.)
 */
function handleTextMessage(text, userId, displayName, replyToken, groupId) {
  userId = getOrCreateShortUserId(userId, displayName);
  // Log user message
  logLineChatMessage(userId, displayName, 'player', text, 'text');
  
  // Normalize: strip leading/trailing space and collapse internal whitespace into one space
  // `clean` (no spaces, lowercase) is used for single-word/shortcode commands
  // `normalized` (collapsed spaces, lowercase) is used for multi-word commands like bank registration
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  const clean = text.replace(/\s+/g, '').toLowerCase();
  
  // A. CHECK BALANCE ("เช็คยอด", "คงเหลือ", "balance")
  if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
    if (groupId) {
      replyToLine(replyToken, `💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
    } else {
      const balance = getPlayerBalance(userId, displayName);
      const balanceFlex = constructBalanceFlex(displayName, balance);
      replyToLine(replyToken, balanceFlex, userId);
    }
    return;
  }
  
  // B. LIST ACTIVE DEALS ("รายการจับคู่", "matched", "รายการดวล")
  if (clean === 'รายการจับคู่' || clean === 'matched' || clean === 'รายการดวล') {
    const matchedBets = getPlayerActiveBets(userId);
    if (matchedBets.length === 0) {
      replyToLine(replyToken, `📝 รายการดวลของคุณ:\n\n❌ ปัจจุบันไม่มีแผลดวลค้างหรือรอคู่ในระบบครับ`, userId);
    } else {
      let replyMsg = `📝 รายการดวลของคุณ (${matchedBets.length} รายการ):\n`;
      matchedBets.forEach(b => {
        const side = b.playerLowId === userId ? 'ต่ำ (Low)' : 'สูง (High)';
        const statusText = b.status === 'matched' ? 'ดวลกันอยู่ ☄️' : 'รอคู่ดวล ⏳';
        replyMsg += `\n-----------------------\nOrder: #${b.orderNumber}\nยอดดวล: ${b.amount} แต้ม\nฝั่งของคุณ: ${side}\nคู่ดวล: ${b.opponentName || 'รอคู่...'}\nสถานะ: ${statusText}\n${b.status === 'pending_match' ? `💡 พิมพ์ "ยกเลิก ${b.orderNumber}" เพื่อถอนแผลและรับแต้มคืน` : ''}`;
      });
      replyToLine(replyToken, replyMsg, userId);
    }
    return;
  }

  // C. CANCEL DEAL REQUEST ("ยกเลิก [orderNo]" or "ยกเลิก[orderNo]" with or without space)
  var cancelRegex = /^(ยกเลิก|cancel)\s*#?(\d{2,6})?$/;
  if (cancelRegex.test(clean)) {
    var cancelMatch = clean.match(cancelRegex);
    var cancelOrderNo = cancelMatch[2] || null;
    var cancelResult = handleCancelBetRequest(userId, cancelOrderNo, displayName);
    var cancelTagPrefix = groupId ? ('👤 [ถึงคุณ @' + displayName + ']: ') : '';
    if (groupId) {
      if (typeof cancelResult === 'object' && cancelResult.success) {
        replyToLine(replyToken, cancelResult.flex, userId);
        if (userId && userId !== groupId) {
          pushToLine(userId, cancelResult.flex);
        }
      } else if (typeof cancelResult === 'object') {
        replyToLine(replyToken, cancelResult, userId);
        if (userId && userId !== groupId) {
          pushToLine(userId, cancelResult);
        }
      } else {
        replyToLine(replyToken, cancelTagPrefix + cancelResult, userId);
        if (userId && userId !== groupId) {
          pushToLine(userId, cancelResult);
        }
      }
    } else {
      // 1:1 Private Chat cancellation
      if (typeof cancelResult === 'object' && cancelResult.success) {
        replyToLine(replyToken, cancelResult.flex, userId);
        // Also notify the LINE group where the bet was created!
        var groupToNotify = cancelResult.targetGroupId || getActiveGroupId();
        if (groupToNotify) {
          pushLineGroupMessage(groupToNotify, cancelResult.flex);
        }
      } else {
        replyToLine(replyToken, cancelResult, userId);
      }
    }
    return;
  }
  
  // D. INITIATE DEPOSIT ("ฝากเงิน", "เติมเงิน", "deposit", "เติมเครดิต")
  if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit' || clean === 'เติมเครดิต') {
    if (groupId) {
      replyToLine(replyToken, `💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
    } else {
      const depositFlex = constructDepositFlex();
      replyToLine(replyToken, depositFlex, userId);
    }
    return;
  }

  // E. INITIATE WITHDRAWAL ("ถอนเงิน", "ถอนยอด", "withdraw")
  if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
    if (groupId) {
      replyToLine(replyToken, `💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
    } else {
      const bank = getPlayerBank(userId);
      if (!bank) {
        if (hasSuccessfulDeposit(userId)) {
          const regFlex = constructBankRegistrationFlex();
          replyToLine(replyToken, regFlex, userId);
        } else {
          replyToLine(replyToken, `❌ ไม่พบประวัติการฝากเงินผ่านระบบ!\n\nเพื่อความปลอดภัยสูงสุด กรุณาฝากเงินเข้ามาก่อนครับ`, userId);
        }
      } else {
        const balance = getPlayerBalance(userId, displayName);
        const withdrawFlex = constructWithdrawalFlex(bank.bankName, bank.accountNumber, bank.accountName, balance);
        replyToLine(replyToken, withdrawFlex, userId);
      }
    }
    return;
  }

  // F1. BANK ACCOUNT REGISTRATION - DISABLED FOR SECURITY
  const bankRegRegex = /^(บัญชี|ลงทะเบียนบัญชี|สมัครบัญชี)\s+(\S+)\s+([\d\-\.]+)\s+(.+)$/;
  if (bankRegRegex.test(normalized)) {
    replyToLine(replyToken,
      `📋 การลงทะเบียนบัญชีธนาคารต้องผ่านการยืนยันจากทีมงานครับ\n\n` +
      `📸 กรุณาถ่ายรูปหน้าสมุดบัญชี หรือสกรีนช็อตแอปธนาคาร ที่แสดง\n` +
      `  • ชื่อ-นามสกุลเจ้าของบัญชี\n` +
      `  • เลขบัญชีที่ใช้โอนเงินเข้ามาครั้งแรก\n\n` +
      `แล้วส่งรูปมาในแชทนี้เลยครับ ทีมงานจะดำเนินการลงทะเบียนให้ภายใน 24 ชั่วโมง\n\n` +
      `📞 สอบถาม: 089-104-1992`,
      userId
    );
    return;
  }

  // F2. PROCESS WITHDRAWAL REQUEST ("ถอน [amount]")
  const withdrawRegex = /^(ถอน|withdraw)(\d+)$/;
  if (withdrawRegex.test(clean)) {
    if (groupId) {
      replyToLine(replyToken, `💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
      return;
    }
    const match = clean.match(withdrawRegex);
    const withdrawAmt = parseInt(match[2]);
    const bank = getPlayerBank(userId);
    if (!bank) {
      replyToLine(replyToken,
        `🏦 ยังไม่มีข้อมูลบัญชีธนาคารในระบบของท่านครับ\n\n` +
        `📸 กรุณาส่งรูปถ่าย หรือสกรีนช็อต หน้าสมุดบัญชีธนาคารที่แสดง:\n` +
        `  • ชื่อ-นามสกุล เจ้าของบัญชี\n` +
        `  • เลขบัญชีที่ตรงกับบัญชีที่โอนเงินเข้ามาครับ\n\n` +
        `⚠️ ต้องเป็นบัญชีเดียวกับที่ใช้โอนเงินฝากเข้ามาเท่านั้น\n\n` +
        `ทีมงานจะตรวจสอบและลงทะเบียนให้ภายใน 24 ชั่วโมงครับ\n` +
        `📞 ติดต่อด่วน: 089-104-1992`,
        userId
      );
      return;
    }
    const balance = getPlayerBalance(userId, displayName);
    if (withdrawAmt <= 0) {
      replyToLine(replyToken, `❌ จำนวนเงินถอนต้องมากกว่า 0 แต้มครับ`, userId);
      return;
    }
    if (balance < withdrawAmt) {
      replyToLine(replyToken, `❌ เครดิตไม่เพียงพอสำหรับการถอนเงินจำนวนนี้!\nยอดเงินของท่าน: ${balance} แต้ม\nยอดที่ต้องการถอน: ${withdrawAmt} แต้ม`, userId);
      return;
    }
    
    // Process withdrawal: lock balance by deducting
    adjustPlayerBalance(userId, -withdrawAmt, displayName);
    
    // Log withdrawal transaction with WD prefix
    logTransaction(userId, displayName, withdrawAmt, 0, 'PENDING_WITHDRAW', 'escalated', `Withdrawal request to ${bank.bankName} ${bank.accountNumber} ${bank.accountName}`);
    
    replyToLine(replyToken, `📥 ได้รับคำขอถอนเงินจำนวน ${withdrawAmt} แต้ม เรียบร้อยแล้วครับ!\n\nระบบกำลังส่งต่อข้อมูลให้แอดมินพิจารณาอนุมัติโอนเงินแบบแมนนวลเข้าบัญชีธนาคาร ${bank.bankName} เลขบัญชี ${bank.accountNumber} ของคุณครับ\n\nยอดคงเหลือหลังทำรายการ: ${balance - withdrawAmt} แต้ม`, userId);
    return;
  }

  // G. PROCESS DEPOSIT AMOUNT REQUEST (pure numbers or "ฝาก [amount]")
  const pureNumRegex = /^\d+$/;
  const depositTextRegex = /^(ฝาก|ฝากเงิน|เติม|เติมเงิน)(\d+)$/;
  let depositAmt = null;
  
  if (pureNumRegex.test(clean)) {
    depositAmt = parseInt(clean);
  } else if (depositTextRegex.test(clean)) {
    depositAmt = parseInt(clean.match(depositTextRegex)[2]);
  }
  
  if (depositAmt !== null) {
    if (depositAmt < 100 || depositAmt > 10000) {
      replyToLine(replyToken, `⚠️ ขออภัยครับ ระบบรองรับการฝากยอดขั้นต่ำ 100 THB และสูงสุดไม่เกิน 10,000 THB ต่อครั้งครับ`, userId);
      return;
    }
    
    // Log pending deposit transaction
    logTransaction(userId, displayName, depositAmt, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
    
    const invoiceFlex = constructDepositInvoiceFlex(depositAmt);
    replyToLine(replyToken, invoiceFlex, userId);
    return;
  }

  // Admin Command: Lock / Close Betting for Round
  var closeRoundRegex = /^(ปิดรอบ|ปิดรับดวล|ล็อครอบ|3-2-go|32go)$/i;
  if (closeRoundRegex.test(clean)) {
    var currentRound = getActiveRocketRound();
    setRocketRoundStatus('CLOSED');
    replyToLine(replyToken, '❌ ปิดรับดวลรอบ ' + (currentRound ? currentRound.name : '') + ' เรียบร้อยแล้วครับ', userId);
    return;
  }

  // Admin Command: Open Betting Round
  var openRoundRegex = /^(เปิดรอบ|เปิดรับดวล)$/i;
  if (openRoundRegex.test(clean)) {
    setRocketRoundStatus('ACTIVE');
    var activeProps = PropertiesService.getScriptProperties();
    var activeMin = Number(activeProps.getProperty('ACTIVE_MIN')) || 800;
    var activeMax = Number(activeProps.getProperty('ACTIVE_MAX')) || 880;
    replyToLine(replyToken, '🚀 เปิดรับดวลแล้วครับ | ราคาปัจจุบัน: ' + (activeMin / 10) + '-' + (activeMax / 10) + 'วิ (window=' + (activeMax - activeMin) + 'cs)', userId);
    return;
  }

  // Admin Command: Set Admin Quote Range  e.g. "ราคา800-880" or "ราคย80.0-88.0"
  // Business Rule: window (rMax - rMin) MUST be exactly 80 centiseconds = 8.0s flight time window
  var adminQuoteRegex = /^(ราคา|quote|setquote)\s*(\d{2,5})[-\/](\d{2,5})$/i;
  if (adminQuoteRegex.test(clean)) {
    var qm = clean.match(adminQuoteRegex);
    var qMin = parseInt(qm[2]);
    var qMax = parseInt(qm[3]);
    var qWindow = qMax - qMin;
    if (qWindow !== 80) {
      replyToLine(replyToken,
        '⚠️ ราคาไม่ถูกต้อง! window = ' + qWindow + 'cs\n\nกฤษฎสำคัญ: rMax − rMin ต้อง = 80cs (8.0วิ)\nตัวอย่าง: ราคา800-880 (ช่วง 80.0-88.0วิ)\nหรือ ราคา760-840 (ช่วง 76.0-84.0วิ)',
        userId
      );
      return;
    }
    PropertiesService.getScriptProperties().setProperties({
      'ACTIVE_MIN': String(qMin),
      'ACTIVE_MAX': String(qMax)
    });
    // Broadcast to group so everyone sees the new quote
    var quoteNotice = '📍 [ราคาช่างประกาศ]: ' + (qMin / 10) + 'วิ – ' + (qMax / 10) + 'วิ (window ' + qWindow + 'cs = 8.0s)\n\nตัวเลือกความเสี่ยง:\n• -10: ' + ((qMin - 10) / 10) + '-' + ((qMax - 10) / 10) + 'วิ  → ก่อนราคา − 1.0วิ\n• -5:  ' + ((qMin - 5) / 10) + '-' + ((qMax - 5) / 10) + 'วิ  → ก่อนราคา − 0.5วิ\n• ปกติ: ' + (qMin / 10) + '-' + (qMax / 10) + 'วิ  → ราคาช่าง\n• +5:  ' + ((qMin + 5) / 10) + '-' + ((qMax + 5) / 10) + 'วิ  → หลังราคา +0.5วิ\n• +10: ' + ((qMin + 10) / 10) + '-' + ((qMax + 10) / 10) + 'วิ  → หลังราคา +1.0วิ';
    var groupTargetQ = groupId || getActiveGroupId();
    if (groupTargetQ) pushLineGroupMessage(groupTargetQ, quoteNotice);
    replyToLine(replyToken, '✅ ตั้งราคาช่าง: ' + (qMin / 10) + '-' + (qMax / 10) + 'วิ เรียบร้อยครับ', userId);
    return;
  }


  // 1. MATCH ACTION: ACCEPT / LOCK DEALS
  // Regex group 2 = orderNo, group 4 = custom match amount (or group 3 if numeric)
  var specificAcceptRegex = /^(?:(\u0e15|\u0e15\u0e34\u0e14|\u0e04\u0e23\u0e31\u0e1a|\u0e40\u0e04|\u0e08\u0e49\u0e32|\u0e22\u0e2d\u0e21\u0e23\u0e31\u0e1a|\u0e14\u0e35\u0e25|\u0e23\u0e31\u0e1a\u0e41\u0e1c\u0e25|\u0e23\u0e31\u0e1a)\s*)?#?(\d{2,6})(?:\s*(\u0e15|\u0e15\u0e34\u0e14|\u0e23\u0e31\u0e1a))?(?:\s+(\d+))?$/i;
  var reverseAcceptRegex = /^#?(\d{2,6})\s*(\u0e15|\u0e15\u0e34\u0e14|\u0e23\u0e31\u0e1a)?(?:\s*(\d+))?$/i;
  var rawText = (text || '').trim();
  var acceptMatchResult = rawText.match(specificAcceptRegex) || clean.match(specificAcceptRegex)
    || rawText.match(reverseAcceptRegex) || clean.match(reverseAcceptRegex);
  var isReverseMatch = !!(rawText.match(reverseAcceptRegex) || clean.match(reverseAcceptRegex));

  var targetOrderNo = null;
  var customMatchAmount = null;
  if (acceptMatchResult) {
    if (isReverseMatch) {
      targetOrderNo = acceptMatchResult[1] || null;
      if (acceptMatchResult[3]) customMatchAmount = parseInt(acceptMatchResult[3]);
    } else {
      targetOrderNo = acceptMatchResult[2] || null;
      if (acceptMatchResult[4]) customMatchAmount = parseInt(acceptMatchResult[4]);
      else if (acceptMatchResult[3] && /^\d+$/.test(acceptMatchResult[3])) customMatchAmount = parseInt(acceptMatchResult[3]);
    }
  }

  var isAcceptCmd = !!acceptMatchResult || ['\u0e15', '\u0e15\u0e34\u0e14', '\u0e04\u0e23\u0e31\u0e1a', '\u0e40\u0e04', '\u0e08\u0e49\u0e32'].indexOf(clean) !== -1;
  if (isAcceptCmd) {
    var tagPrefix = groupId ? ('\ud83d\udc64 [\u0e16\u0e36\u0e07\u0e04\u0e38\u0e13 @' + displayName + ']: ') : '';

    var matchedBet = matchExistingOpenBet(userId, displayName, targetOrderNo, customMatchAmount);

    if (matchedBet && matchedBet.error === 'BELOW_MIN_PERCENT_LIMIT') {
      var minMsg = tagPrefix + '⚠️ ยอดดวลขั้นต่ำคือ 20% (' + (matchedBet.minAllowed || 0) + ' pt) ของ Order #' + (matchedBet.orderNumber || targetOrderNo) + ' ครับ (คุณระบุ ' + (matchedBet.provided || 0) + ' pt)';
      replyToLine(replyToken, minMsg, userId);
    } else if (matchedBet && matchedBet.error === 'OWN_BET') {
      var ownBetMsg = tagPrefix + '⚠️ คุณไม่สามารถรับแผลดวลของตัวเองได้ครับ';
      replyToLine(replyToken, ownBetMsg, userId);
    } else if (matchedBet && matchedBet.error === 'CANCELLED') {
      var cancelMsg = tagPrefix + '🚫 แผล Order #' + matchedBet.orderNumber + ' ถูกยกเลิกไปแล้วครับ';
      replyToLine(replyToken, cancelMsg, userId);
    } else if (matchedBet && matchedBet.error === 'ALREADY_MATCHED') {
      var alreadyMsg = tagPrefix + '⚠️ แผล Order #' + matchedBet.orderNumber + ' มีคู่ดวลแล้ว ไม่สามารถรับซ้ำได้ครับ';
      replyToLine(replyToken, alreadyMsg, userId);
    } else if (matchedBet && matchedBet.error === 'INSUFFICIENT_BALANCE') {
      var needed = (matchedBet.required || 0) - (matchedBet.current || 0);
      var insuffMsg = tagPrefix + '⚠️ แต้มไม่พอ (มี ' + (matchedBet.current || 0) + 'pt | ขาด ' + needed + 'pt) พิมพ์ "ฝากเงิน"';
      replyToLine(replyToken, insuffMsg, userId);
    } else if (matchedBet && matchedBet.error === 'BELOW_MIN_LIMIT') {
      var minMsg = tagPrefix + '⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + (matchedBet.provided || 0) + ' pt)';
      replyToLine(replyToken, minMsg, userId);
    } else if (matchedBet && matchedBet.error === 'NOT_FOUND') {
      var notFoundMsg = tagPrefix + '🚫 ไม่พบแผล Order #' + targetOrderNo + ' ในระบบครับ';
      replyToLine(replyToken, notFoundMsg, userId);
    } else if (matchedBet && matchedBet.error === 'EXCEEDS_ORDER_AMOUNT') {
      var exceedsMsg = tagPrefix + '⚠️ ยอดรับดวล (' + (matchedBet.provided || 0) + ' pt) เกินยอดของ Order #' + (matchedBet.orderNumber || targetOrderNo) + ' (รับได้สูงสุด ' + (matchedBet.maxAllowed || 0) + ' pt ครับ)';
      replyToLine(replyToken, exceedsMsg, userId);
    } else if (matchedBet && matchedBet.orderNumber) {
      var matchFlex = constructMatchNotificationFlex(matchedBet.orderNumber, matchedBet.amount, matchedBet.playerLowName, matchedBet.playerHighName, matchedBet.rangeInfo, false, null);
      replyToLine(replyToken, matchFlex, userId);
      // Also push to both players in 1-on-1 private chat if different
      if (matchedBet.creatorId) {
        pushToLine(matchedBet.creatorId, matchFlex);
      }
      if (matchedBet.matcherId && matchedBet.matcherId !== matchedBet.creatorId) {
        pushToLine(matchedBet.matcherId, matchFlex);
      }
      // If partial match split occurred, broadcast the remaining child bet card to the group!
      if (matchedBet.isSplit && matchedBet.splitOrderNumber && matchedBet.remainingAmount >= 100) {
        var groupTarget = groupId || getActiveGroupId();
        if (groupTarget) {
          var splitCard = constructBetOpenFlex(
            matchedBet.splitOrderNumber,
            matchedBet.remainingAmount,
            matchedBet.splitSide,
            matchedBet.creatorName,
            matchedBet.rangeInfo,
            false,
            null,
            false
          );
          pushLineGroupMessage(groupTarget, splitCard);
        }
      }
    } else {
      var noOpenMsg = tagPrefix + '🚫 ไม่มีแผลดวลฝั่งตรงข้ามที่รอคู่ในขณะนี้ครับ';
      replyToLine(replyToken, noOpenMsg, userId);
    }
    return;
  }

  // 2. PARSE BET FORMULAS
  // Rule 1 (admin quote): ชล100, ชถ500, +5ชล100, -5ชถ100, +10ชล100, -10ชถ500
  // Rule 2 (custom range): 760-840ล500, 800-880ถ500 (window must = 80s)
  var isChotoy = clean.indexOf('ชตย') !== -1 || text.indexOf('ชตย') !== -1;
  var cleanBetText = clean.replace(/ชตย/g, '').trim();

  var keywordsHigh = ['ชล', 'ล', 'ไล่', 'สูง', 'ชสูง', 'ช่างสูง', 'ช่างไล่', 'ส'];
  var keywordsLow  = ['ชย', 'ชถ', 'ย', 'ถ', 'ยั่ง', 'ถอย', 'ต่ำ', 'ชต่ำ', 'ช่างต่ำ', 'ช่างยั่ง', 'ช่างถอย', 'ต'];

  // Detect rate-offset prefix BEFORE keyword matching (supports +-5 and +-10)
  var offsetDelta = 0;
  var strippedBetText = cleanBetText;
  if (/^[+\-]\d+/.test(strippedBetText)) {
    var deltaMatch = strippedBetText.match(/^([+\-]\d+)/);
    var deltaVal = parseInt(deltaMatch[1]);
    if (deltaVal !== 5 && deltaVal !== -5 && deltaVal !== 10 && deltaVal !== -10) {
      var deltaErrMsg = groupId
        ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ การปรับราคาช่างรองรับเฉพาะ +/-5 และ +/-10 วินาทีเท่านั้นครับ (เช่น +5ชล, -5ชถ, +10ชล, -10ชถ)'
        : '⚠️ การปรับราคาช่างรองรับเฉพาะ +/-5 และ +/-10 วินาทีเท่านั้นครับ (เช่น +5ชล, -5ชถ, +10ชล, -10ชถ)';
      replyToLine(replyToken, deltaErrMsg, userId);
      return;
    }
    offsetDelta = deltaVal;
    strippedBetText = strippedBetText.replace(/^[+\-]\d+/, '').trim();
  }

  var rangeRegex = /^(\d+)[-\/](\d+)([a-zA-Z\u0e00-\u0e7f]+)(\d*)?$/;
  var simpleRegex = /^([a-zA-Z\u0e00-\u0e7f]+)(\d*)?$/;

  var betType = '';
  var rangeMin = null;
  var rangeMax = null;
  var side = '';
  var amount = 0;

  if (rangeRegex.test(cleanBetText)) {
    // Rule 2: Custom range
    var rMatch = cleanBetText.match(rangeRegex);
    rangeMin = parseInt(rMatch[1]);
    rangeMax = parseInt(rMatch[2]);
    var rCmd = rMatch[3];
    side = keywordsLow.indexOf(rCmd) !== -1 ? 'low' : (keywordsHigh.indexOf(rCmd) !== -1 ? 'high' : '');
    amount = rMatch[4] ? parseInt(rMatch[4]) : 500;
    betType = 'custom_range';

    if (side) {
      // 1. Check low-to-high order
      if (rangeMin >= rangeMax) {
        var orderErrMsg = groupId
          ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ ระบุช่วงเวลาจากต่ำไปสูงเท่านั้นครับ เช่น 300-380' + rCmd + ' (คุณระบุ ' + rangeMin + '-' + rangeMax + ')'
          : '⚠️ ระบุช่วงเวลาจากต่ำไปสูงเท่านั้นครับ เช่น 300-380' + rCmd + ' (คุณระบุ ' + rangeMin + '-' + rangeMax + ')';
        replyToLine(replyToken, orderErrMsg, userId);
        return;
      }

      // 2. Strict 80-second range window
      if (rangeMax - rangeMin !== 80) {
        var diff = rangeMax - rangeMin;
        var windowErrMsg = groupId
          ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ ช่วงราคาต้องห่างกัน 80 วินาทีพอดีครับ เช่น 300-380' + rCmd + ' (คุณระบุ ' + rangeMin + '-' + rangeMax + ' ห่าง ' + diff + ' วิ)'
          : '⚠️ ช่วงราคาต้องห่างกัน 80 วินาทีพอดีครับ เช่น 300-380' + rCmd + ' (คุณระบุ ' + rangeMin + '-' + rangeMax + ' ห่าง ' + diff + ' วิ)';
        replyToLine(replyToken, windowErrMsg, userId);
        return;
      }

      // 3. Minimum bet amount
      if (amount < 100) {
        var minAmtMsg = groupId
          ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + amount + ' pt)'
          : '⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + amount + ' pt)';
        replyToLine(replyToken, minAmtMsg, userId);
        return;
      }
    }
  } else if (simpleRegex.test(strippedBetText)) {
    // Rule 1: Follow admin quote with optional offset
    var sMatch = strippedBetText.match(simpleRegex);
    var sCmd = sMatch[1];
    side = keywordsLow.indexOf(sCmd) !== -1 ? 'low' : (keywordsHigh.indexOf(sCmd) !== -1 ? 'high' : '');
    amount = sMatch[2] ? parseInt(sMatch[2]) : 500;
    betType = 'range';

    if (side && amount < 100) {
      var minAmtMsg = groupId
        ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + amount + ' pt)'
        : '⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + amount + ' pt)';
      replyToLine(replyToken, minAmtMsg, userId);
      return;
    }

    var baseProps = PropertiesService.getScriptProperties();
    rangeMin = Number(baseProps.getProperty('ACTIVE_MIN')) || 800;
    rangeMax = Number(baseProps.getProperty('ACTIVE_MAX')) || 880;
    rangeMin += offsetDelta;
    rangeMax += offsetDelta;
  }
  if (clean === 'กติกา' || clean === 'rule' || clean === 'rules' || clean === 'วิธีเล่น' || clean === 'คู่มือ') {
    var ruleFlex = constructRuleGuideFlex();
    replyToLine(replyToken, ruleFlex, userId);
    return;
  }

  if (!side || amount < 10) {
    const isPrivateChat = !groupId;
    if (isPrivateChat || clean === 'เมนู' || clean === 'menu' || clean === 'สวัสดี' || clean === 'help' || clean === 'เริ่ม' || clean === 'start') {
      const mainMenuFlex = constructMainMenuFlex();
      replyToLine(replyToken, mainMenuFlex, userId);
    }
    return;
  }
  
  // ROUND LOCK GUARD: Block custom/tailor-rate orders after admin sends last call
  // Uses `betType` (the correct local variable), checked against PropertiesService-backed status
  if (isRocketRoundClosed() && (betType === 'custom_range' || betType === 'custom' || betType === 'pre_quote' || offsetDelta !== 0)) {
    var closedMsg = groupId
      ? '👤 [ถึงคุณ @' + displayName + ']: ⛔ ปิดรับการเปิดราคาเองแล้ว (Final Call) กรุณารอจับคู่แผลที่เปิดค้างอยู่หรือรอรอบถัดไปครับ'
      : '⛔ ปิดรับการเปิดราคาเองแล้ว (Final Call) กรุณารอจับคู่แผลที่เปิดค้างอยู่หรือรอรอบถัดไปครับ';
    replyToLine(replyToken, closedMsg, userId);
    return;
  }
  
  // Check user credit balance
  const balance = getPlayerBalance(userId, displayName);
  if (balance < amount) {
    const needed = amount - balance;
    const msg = groupId
      ? `⚠️ แต้มไม่พอ (มี ${balance}pt | ขาด ${needed}pt) พิมพ์ "ฝากเงิน"`
      : `⚠️ เครดิตไม่พอ (มี ${balance}pt | ต้องการ ${amount}pt)\n💵 พิมพ์ "ฝากเงิน" เพื่อเติมเครดิตครับ`;
    replyToLine(replyToken, msg, userId);
    return;
  }
  
  // Write to Sheets database as open bet (credit lock happens inside saveOpenBet)
  // Generate 4-digit order numbers (1000 - 9999)
  var orderNumber = (Math.floor(Math.random() * 9000) + 1000).toString();
  var isPreQuoteBet = (betType === 'pre_quote');
  // Build the user-typed command string for the Flex card title
  var userTypedCmdStr = cleanBetText || null;
  var saveResult = saveOpenBet(orderNumber, userId, displayName, side, amount, betType, rangeMin, rangeMax, groupId, userTypedCmdStr, isPreQuoteBet);
  if (saveResult && saveResult.error) {
    var bal = saveResult.current || 0;
    var needed = amount - bal;
    var insufficientMsg = groupId
      ? '⚠️ แต้มไม่พอ (มี ' + bal + 'pt | ขาด ' + needed + 'pt) พิมพ์ "ฝากเงิน"'
      : '⚠️ เครดิตไม่พอ (มี ' + bal + 'pt | ต้องการ ' + amount + 'pt)\n💵 พิมพ์ "ฝากเงิน" เพื่อเติมเครดิตครับ';
    replyToLine(replyToken, insufficientMsg, userId);
    return;
  }
  
  var rangeInfo = (rangeMin && rangeMax) ? (rangeMin + '-' + rangeMax + 's') : '';
  var betOpenFlex = constructBetOpenFlex(orderNumber, amount, side, displayName, rangeInfo, false, userTypedCmdStr, isPreQuoteBet);
  replyToLine(replyToken, betOpenFlex, userId);
  // If created in group, also send copy to user's private 1-on-1 chat
  if (groupId && userId && userId !== groupId) {
    pushToLine(userId, betOpenFlex);
  }
}

/**
 * Handle incoming LINE image transfers (Bank slip verification check)
 */
function handleImageSlipMessage(messageId, userId, displayName, replyToken) {
  userId = getOrCreateShortUserId(userId, displayName);
  // 1. Call LINE Content API to pull image binary data
  const imageUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const headers = { "Authorization": "Bearer " + LINE_CHANNEL_ACCESS_TOKEN };
  const imageResponse = UrlFetchApp.fetch(imageUrl, { method: "get", headers: headers });
  const imageBlob = imageResponse.getBlob().setName("payslip.jpg");
  
  // 2. HTTP POST file bytes to Thai Slip Checking API (supporting both 'image' and 'file' payload parameters)
  const options = {
    method: "post",
    headers: { "Authorization": "Bearer " + SLIP_API_KEY },
    payload: { 
      image: imageBlob,
      file: imageBlob
    },
    muteHttpExceptions: true
  };
  
  let slipData;
  let responseCode = 200;
  let responseText = "";
  try {
    const apiResponse = UrlFetchApp.fetch(SLIP_API_URL, options);
    responseCode = apiResponse.getResponseCode();
    responseText = apiResponse.getContentText();
    slipData = JSON.parse(responseText);
  } catch (err) {
    logTransaction(userId, displayName, 0, 0, 'ERR_CONN', 'escalated', 'Slip Check API connectivity failure: ' + err.toString());
    replyToLine(replyToken, `⚠️ ระบบเช็คสลิปขัดข้อง\nการเชื่อมต่อไปยัง API เช็คสลิปขัดข้อง รายการเติมเงินได้ส่งให้ แอดมิน ตรวจสอบแมนนวลในระบบหลังบ้านแล้วครับ`);
    return;
  }
  
  // Handle non-200 HTTP response codes from the API
  if (responseCode !== 200) {
    let errorDetail = "";
    try {
      const errObj = JSON.parse(responseText);
      errorDetail = errObj.error ? errObj.error.message : (errObj.message || responseText);
    } catch (e) {
      errorDetail = responseText || "Unknown API response error";
    }
    
    logTransaction(userId, displayName, 0, 0, 'ERR_API_' + responseCode, 'escalated', 'API HTTP Error ' + responseCode + ': ' + errorDetail);
    
    // Check if it is a Bangkok Bank pending transaction to avoid showing scary server errors to the player
    if (errorDetail.indexOf("Bangkok Bank") !== -1 && errorDetail.indexOf("pending") !== -1) {
      replyToLine(replyToken, `🏦 สลิปธนาคารกรุงเทพอยู่ระหว่างประมวลผล\nเนื่องจากระบบธนาคารกรุงเทพมีความล่าช้าชั่วคราวในการอัพเดทข้อมูลธุรกรรม ทำให้ระบบออโต้ยังไม่สามารถตรวจสอบได้ในขณะนี้\n\nบิลของคุณได้ส่งถึงแอดมินเรียบร้อยแล้ว กำลังดำเนินการตรวจสอบแมนนวลหลังบ้านและจะปรับเครดิตให้คุณโดยเร็วที่สุดครับ`);
    } else {
      replyToLine(replyToken, `⚠️ ระบบเช็คสลิปขัดข้อง (HTTP ${responseCode})\nรายละเอียด: ${errorDetail}\n\nแอดมินได้รับบิลนี้เรียบร้อย กำลังตรวจสอบแมนนวลให้ในระบบหลังบ้านครับ`);
    }
    return;
  }
  
  // 3. Process slip parameters (EasySlip API v2)
  if (!slipData.success || !slipData.data) {
    const apiMessage = slipData.message || (slipData.error ? slipData.error.message : 'No QR code readable');
    logTransaction(userId, displayName, 0, 0, 'ERR_INVALID_SLIP', 'escalated', 'API check failed: ' + apiMessage);
    replyToLine(replyToken, `❌ สแกนสลิปไม่ผ่าน\nเหตุผล: ${apiMessage}\n\nระบบส่งต่อบิลนี้ให้แอดมินเช็คบัญชีแมนนวลแล้วครับ`);
    return;
  }
  
  // Robust field extraction supporting both EasySlip v1 (flat) and v2 (nested under rawSlip)
  var refCode = '';
  if (slipData.data) {
    if (slipData.data.rawSlip && slipData.data.rawSlip.transRef) {
      refCode = slipData.data.rawSlip.transRef;
    } else if (slipData.data.transRef) {
      refCode = slipData.data.transRef;
    } else if (slipData.data.transactionId) {
      refCode = slipData.data.transactionId;
    }
  }
 
  var actualAmount = 0;
  if (slipData.data) {
    if (slipData.data.amountInSlip !== undefined) {
      actualAmount = Number(slipData.data.amountInSlip) || 0;
    } else if (slipData.data.rawSlip && slipData.data.rawSlip.amount) {
      if (typeof slipData.data.rawSlip.amount === 'object' && slipData.data.rawSlip.amount !== null) {
        actualAmount = Number(slipData.data.rawSlip.amount.amount) || 0;
      } else {
        actualAmount = Number(slipData.data.rawSlip.amount) || 0;
      }
    } else if (slipData.data.amount !== undefined) {
      if (typeof slipData.data.amount === 'object' && slipData.data.amount !== null) {
        actualAmount = Number(slipData.data.amount.amount) || 0;
      } else {
        actualAmount = Number(slipData.data.amount) || 0;
      }
    }
  }
 
  // GUARD 1: Block slips with no readable reference code (corrupt/screenshot/re-cropped)
  if (!refCode || refCode.trim() === '') {
    logTransaction(userId, displayName, 0, actualAmount, 'NO_REF', 'escalated', 'Slip has no transaction reference code (possibly a screenshot or edited image)');
    replyToLine(replyToken, `❌ สลิปไม่มีรหัสอ้างอิง!\nระบบตรวจพบว่าสลิปนี้ไม่มีเลขอ้างอิงธุรกรรม (transRef) อาจเป็นภาพ Screenshot หรือถูกตัดต่อ\n\nกรุณาส่งสลิปจากแอปธนาคารโดยตรงครับ`);
    return;
  }
  
  // GUARD 2: Block duplicate ref codes (checks ALL statuses, not just 'success')
  if (checkIfRefExists(refCode)) {
    logTransaction(userId, displayName, 0, actualAmount, refCode, 'escalated', 'Duplicate transaction ref code — already submitted before');
    replyToLine(replyToken, `⚠️ ตรวจพบสลิปซ้ำในระบบ!\nเลขอ้างอิง: ${refCode}\nสลิปนี้เคยถูกนำมาใช้งานแล้ว ไม่ว่าจะผ่านหรือไม่ผ่านก็ตาม\n\nรายการส่งให้แอดมินตรวจสอบกรณีพิเศษครับ`);
    return;
  }
 
  // GUARD 3: Block slips older than 24 hours (stale slip fraud prevention)
  var slipDateStr = '';
  if (slipData.data) {
    if (slipData.data.rawSlip && slipData.data.rawSlip.date) {
      slipDateStr = slipData.data.rawSlip.date;
    } else if (slipData.data.rawSlip && slipData.data.rawSlip.transDate) {
      slipDateStr = slipData.data.rawSlip.transDate;
    } else if (slipData.data.date) {
      slipDateStr = slipData.data.date;
    } else if (slipData.data.transDate) {
      slipDateStr = slipData.data.transDate;
    }
  }
 
  if (slipDateStr) {
    const slipDate = new Date(slipDateStr);
    const nowDate = new Date();
    const hoursDiff = (nowDate - slipDate) / (1000 * 60 * 60);
    if (!isNaN(hoursDiff) && hoursDiff > 24) {
      logTransaction(userId, displayName, 0, actualAmount, refCode, 'escalated', `Stale slip rejected — slip date: ${slipDateStr} is more than 24 hours old`);
      replyToLine(replyToken, `⏰ สลิปหมดอายุ!\nสลิปนี้มีวันที่: ${slipDateStr}\nระบบยอมรับเฉพาะสลิปที่โอนภายใน 24 ชั่วโมงที่ผ่านมาเท่านั้น\n\nกรุณาโอนใหม่และส่งสลิปทันทีครับ`);
      return;
    }
  }
  
  // Official transfer amount is ALWAYS per the pay-in slip (actualAmount)
  var requestedAmount = findPendingRequestedAmount(userId);
  var finalCreditAmount = actualAmount > 0 ? actualAmount : (requestedAmount || 100);

  // SUCCESS: Credit player balance 1:1 based on actual slip amount, log transaction as success
  adjustPlayerBalance(userId, finalCreditAmount, displayName);
  
  var noteStr = (requestedAmount && requestedAmount !== finalCreditAmount)
    ? 'Auto approved via Slip Scanner. Marked ' + requestedAmount + ' THB vs Slip ' + finalCreditAmount + ' THB. Ref: ' + refCode
    : 'Auto approved via Slip Scanner. Ref: ' + refCode;

  logTransaction(userId, displayName, requestedAmount || finalCreditAmount, finalCreditAmount, refCode, 'success', noteStr);
  
  // GUARD: Remove the duplicate logTransaction call that appeared after the first one.
  // The single call to logTransaction at line ~767 already handles upsert of the PENDING_SLIP row.
  // Extract sender details to record registered bank account
  var senderBank = '';
  var senderAccount = '';
  var senderName = '';
  try {
    if (slipData.data) {
      if (slipData.data.sender) {
        if (slipData.data.sender.bank) {
          senderBank = slipData.data.sender.bank.abbr || slipData.data.sender.bank.id || '';
        }
        if (slipData.data.sender.account) {
          senderAccount = slipData.data.sender.account.value || '';
          senderName = slipData.data.sender.account.name || '';
        }
      } else if (slipData.data.rawSlip && slipData.data.rawSlip.sender) {
        if (slipData.data.rawSlip.sender.bank) {
          senderBank = slipData.data.rawSlip.sender.bank.abbr || slipData.data.rawSlip.sender.bank.id || '';
        }
        if (slipData.data.rawSlip.sender.account) {
          senderAccount = slipData.data.rawSlip.sender.account.value || slipData.data.rawSlip.sender.senderAccount || '';
          senderName = slipData.data.rawSlip.sender.account.name || '';
        }
      }
    }
  } catch (ex) {
    console.error("Error extracting bank details: " + ex.toString());
  }
  
  if (senderBank && senderAccount) {
    updatePlayerBank(userId, senderBank, senderAccount, senderName);
  }

  // Deliver success Flex card to player
  var slipSuccessDetails = 'เติมเงินสำเร็จผ่านระบบสแกนสลิปอัตโนมัติ เลขอ้างอิง: ' + refCode;
  var slipFlex = constructBankingFlex('Income', actualAmount, slipSuccessDetails, null, userId);
  replyToLine(replyToken, slipFlex);
}

// =========================================================================
// GOOGLE SHEETS DATABASE QUERIES & CRUD HELPER METHODS
// =========================================================================

function getPlayerBalance(userId, displayName) {
  const shortUserId = getOrCreateShortUserId(userId, displayName);
  var searchId = cleanUserId(shortUserId);
  if (!searchId) return 0;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      return Number(data[i][2]) || 0;
    }
  }
  return 0;
}

function adjustPlayerBalance(userId, delta, displayName) {
  const shortUserId = getOrCreateShortUserId(userId, displayName);
  var searchId = cleanUserId(shortUserId);
  if (!searchId) return false;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    Logger.log('[LOCK] Could not acquire lock for adjustPlayerBalance: ' + e.toString());
    return false;
  }
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
    const data = sheet.getDataRange().getValues();
    const numericDelta = Number(delta) || 0;
    for (let i = 1; i < data.length; i++) {
      const rowId = data[i][0] ? data[i][0].toString().trim() : '';
      if (rowId === searchId) {
        const cell = sheet.getRange(i + 1, 3);
        const currentBalance = Number(data[i][2]) || 0;
        // Strict Anti-Overdraft Guard: Block deductions if resulting balance would be less than 0
        if (numericDelta < 0 && (currentBalance + numericDelta < 0)) {
          Logger.log('[CREDIT BLOCK] Refused deduction for ' + searchId + ': current balance ' + currentBalance + ', attempted ' + numericDelta);
          return false;
        }
        cell.setValue(currentBalance + numericDelta);
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}


/**
 * Save a new open bet to the Bets sheet and push Flex card to the LINE group.
 * @param {string} orderNo - Unique 6-digit order number
 * @param {string} userId - Short passport-style player ID
 * @param {string} displayName - Player display name
 * @param {'low'|'high'} side - Player's chosen side
 * @param {number} amount - Bet amount in credits
 * @param {string} type - Bet type ('range', 'custom_range', 'pre_quote')
 * @param {number|null} rMin - Range minimum
 * @param {number|null} rMax - Range maximum
 * @param {string|null} targetGroupId - LINE Group ID
 * @param {string|null} userTypedCmd - Original text command typed by user (for Flex title)
 * @param {boolean} [isPreQuote] - Whether this is a pre-quote bet
 */
function saveOpenBet(orderNo, userId, displayName, side, amount, type, rMin, rMax, targetGroupId, userTypedCmd, isPreQuote) {
  var searchId = cleanUserId(userId);
  var betAmount = Number(amount) || 0;
  
  const isAdminUser = searchId === 'admin' || searchId === 'user' || (typeof userId === 'string' && (userId.toLowerCase() === 'user' || userId.toLowerCase() === 'admin'));

  // Anti-Overdraft Guard: verify regular creator has sufficient balance before locking credit
  if (!isAdminUser && betAmount > 0) {
    const currentBal = getPlayerBalance(searchId, displayName);
    if (currentBal < betAmount) {
      return { error: 'INSUFFICIENT_BALANCE', required: betAmount, current: currentBal };
    }
    // Lock creator's credit immediately
    const deducted = adjustPlayerBalance(searchId, -betAmount, displayName);
    if (!deducted) {
      return { error: 'INSUFFICIENT_BALANCE', required: betAmount, current: currentBal };
    }
  }
  
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  sheet.appendRow([
    orderNo,
    side === 'low' ? searchId : '',
    side === 'low' ? displayName : '',
    side === 'high' ? searchId : '',
    side === 'high' ? displayName : '',
    amount,
    type,
    rMin || '',
    rMax || '',
    'pending_match',
    '',
    new Date(),
    targetGroupId || ''
  ]);

  var targetGroups = [];
  if (targetGroupId && targetGroupId !== 'ALL') {
    targetGroups = [targetGroupId];
  } else {
    var activeId = getActiveGroupId();
    if (activeId) targetGroups.push(activeId);
  }

  if (targetGroups.length > 0) {
    try {
      var rangeInfoStr = (rMin && rMax) ? (rMin + '-' + rMax + 's') : '';
      var betCard = constructBetOpenFlex(orderNo, amount, side, displayName, rangeInfoStr, false, userTypedCmd || null, !!isPreQuote);
      for (var gi = 0; gi < targetGroups.length; gi++) {
        pushLineGroupMessage(targetGroups[gi], betCard);
      }
    } catch(e) {
      Logger.log('Error pushing order flex card in saveOpenBet: ' + e.toString());
    }
  }
}

/**
 * Match a player to an existing open bet.
 * Uses LockService to prevent concurrent double-match race conditions.
 * @param {string} userId - Short passport-style ID of the matcher
 * @param {string} displayName - Display name of the matcher
 * @param {string|null} targetOrderNo - Explicit order number to match (optional)
 * @param {number|null} customMatchAmount - Custom credit amount to wager (optional, ≥100)
 * @returns {Object} Match result or error descriptor
 */
function matchExistingOpenBet(userId, displayName, targetOrderNo, customMatchAmount) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    Logger.log('[LOCK] matchExistingOpenBet could not acquire lock: ' + e.toString());
    return { error: 'LOCK_TIMEOUT' };
  }

  try {
  var searchId = cleanUserId(userId);
  var matcherBal = getPlayerBalance(searchId, displayName);
  var cleanTargetOrder = targetOrderNo ? targetOrderNo.toString().trim().replace(/#/g, '') : null;
  var matchAmt = (customMatchAmount && !isNaN(customMatchAmount)) ? parseInt(customMatchAmount) : null;
  if (matchAmt !== null && matchAmt < 100) {
    return { error: 'BELOW_MIN_LIMIT', provided: matchAmt };
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  var data = sheet.getDataRange().getValues();
  
  // 1. Search by target order first if specified
  if (cleanTargetOrder) {
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const orderNo = row[0].toString().trim();
      if (orderNo === cleanTargetOrder || orderNo.endsWith(cleanTargetOrder)) {
        const status = row[9];
        let playerLowId = row[1] ? row[1].toString().trim() : '';
        let playerLowName = row[2] ? row[2].toString().trim() : '';
        let playerHighId = row[3] ? row[3].toString().trim() : '';
        let playerHighName = row[4] ? row[4].toString().trim() : '';
        const totalAmount = Number(row[5]) || 0;
        const betType = row[6] || 'range';
        const rMin = row[7];
        const rMax = row[8];
        const targetGroupId = row[12] || '';
        
        const creatorId = playerLowId ? playerLowId : playerHighId;
        const creatorName = playerLowId ? playerLowName : playerHighName;
        const creatorSide = playerLowId ? 'low' : 'high';

        // 1. OWN_BET GUARD: Check clean ID, raw ID, and displayName
        if (creatorId === searchId || creatorId === cleanUserId(userId) || (creatorName && displayName && creatorName === displayName)) {
          return { error: 'OWN_BET', orderNumber: orderNo };
        }

        // 2. STATUS GUARDS: Distinguish cancelled from matched
        if (status === 'cancelled' || status === 'void') {
          return { error: 'CANCELLED', orderNumber: orderNo };
        }
        if (status === 'matched' || status === 'resolved') {
          return { error: 'ALREADY_MATCHED', orderNumber: orderNo };
        }
        
        if (matchAmt !== null) {
          var min20Percent = Math.max(1, Math.round(totalAmount * 0.20));
          if (matchAmt < min20Percent) {
            return { error: 'BELOW_MIN_PERCENT_LIMIT', minAllowed: min20Percent, percent: 20, provided: matchAmt, orderNumber: orderNo };
          }
          if (matchAmt > totalAmount) {
            return { error: 'EXCEEDS_ORDER_AMOUNT', maxAllowed: totalAmount, provided: matchAmt, orderNumber: orderNo };
          }
        }
        var finalMatchAmt = matchAmt !== null ? matchAmt : totalAmount;
        if (matcherBal < finalMatchAmt) {
          return { error: 'INSUFFICIENT_BALANCE', required: finalMatchAmt, current: matcherBal, orderNumber: orderNo };
        }

        var isSplit = finalMatchAmt < totalAmount;
        var remainingAmount = totalAmount - finalMatchAmt;
        var splitOrderNumber = null;
        
        if (!playerLowId) {
          playerLowId = searchId;
          playerLowName = displayName;
        } else {
          playerHighId = searchId;
          playerHighName = displayName;
        }
        
        // Update matched portion in sheet
        sheet.getRange(i + 1, 2).setValue(playerLowId);
        sheet.getRange(i + 1, 3).setValue(playerLowName);
        sheet.getRange(i + 1, 4).setValue(playerHighId);
        sheet.getRange(i + 1, 5).setValue(playerHighName);
        sheet.getRange(i + 1, 6).setValue(finalMatchAmt);
        sheet.getRange(i + 1, 10).setValue('matched');
        
        adjustPlayerBalance(searchId, -finalMatchAmt, displayName);

        // If partial match: create Child split order for the remaining amount
        if (isSplit && remainingAmount >= 100) {
          splitOrderNumber = (Math.floor(Math.random() * 9000) + 1000).toString();
          sheet.appendRow([
            splitOrderNumber,
            creatorSide === 'low' ? creatorId : '',
            creatorSide === 'low' ? creatorName : '',
            creatorSide === 'high' ? creatorId : '',
            creatorSide === 'high' ? creatorName : '',
            remainingAmount,
            betType,
            rMin || '',
            rMax || '',
            'pending_match',
            '',
            new Date(),
            targetGroupId || ''
          ]);
        }

        var rangeInfoStr = (rMin && rMax) ? (rMin + '-' + rMax + 's') : '';

        return {
          orderNumber: orderNo,
          amount: finalMatchAmt,
          playerLowName: playerLowName,
          playerHighName: playerHighName,
          creatorId: creatorId,
          creatorName: creatorName,
          matcherId: searchId,
          rangeInfo: rangeInfoStr,
          isSplit: isSplit,
          remainingAmount: remainingAmount,
          splitOrderNumber: splitOrderNumber,
          splitSide: creatorSide
        };
      }
    }
    return { error: 'NOT_FOUND', targetOrderNo: cleanTargetOrder };
  }
  
  // 2. Search first open pending bet
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[9] === 'pending_match') {
      const orderNo = row[0];
      const totalAmount = Number(row[5]) || 0;
      const betType = row[6] || 'range';
      const rMin = row[7];
      const rMax = row[8];
      const targetGroupId = row[12] || '';
      
      let playerLowId = row[1] ? row[1].toString().trim() : '';
      let playerLowName = row[2];
      let playerHighId = row[3] ? row[3].toString().trim() : '';
      let playerHighName = row[4];
      
      const creatorId = playerLowId ? playerLowId : playerHighId;
      const creatorName = playerLowId ? playerLowName : playerHighName;
      const creatorSide = playerLowId ? 'low' : 'high';
      if (creatorId === searchId) continue;

      var finalMatchAmtAuto = (matchAmt !== null && matchAmt <= totalAmount) ? matchAmt : totalAmount;
      if (matcherBal < finalMatchAmtAuto) {
        return { error: 'INSUFFICIENT_BALANCE', required: finalMatchAmtAuto, current: matcherBal, orderNumber: orderNo };
      }

      var isSplitAuto = finalMatchAmtAuto < totalAmount;
      var remainingAmountAuto = totalAmount - finalMatchAmtAuto;
      var splitOrderNumberAuto = null;
      
      if (!playerLowId) {
        playerLowId = searchId;
        playerLowName = displayName;
      } else {
        playerHighId = searchId;
        playerHighName = displayName;
      }
      
      sheet.getRange(i + 1, 2).setValue(playerLowId);
      sheet.getRange(i + 1, 3).setValue(playerLowName);
      sheet.getRange(i + 1, 4).setValue(playerHighId);
      sheet.getRange(i + 1, 5).setValue(playerHighName);
      sheet.getRange(i + 1, 6).setValue(finalMatchAmtAuto);
      sheet.getRange(i + 1, 10).setValue('matched');
      
      adjustPlayerBalance(searchId, -finalMatchAmtAuto, displayName);

      if (isSplitAuto && remainingAmountAuto >= 100) {
        splitOrderNumberAuto = (Math.floor(Math.random() * 9000) + 1000).toString();
        sheet.appendRow([
          splitOrderNumberAuto,
          creatorSide === 'low' ? creatorId : '',
          creatorSide === 'low' ? creatorName : '',
          creatorSide === 'high' ? creatorId : '',
          creatorSide === 'high' ? creatorName : '',
          remainingAmountAuto,
          betType,
          rMin || '',
          rMax || '',
          'pending_match',
          '',
          new Date(),
          targetGroupId || ''
        ]);
      }

      var rangeInfoStrAuto = (rMin && rMax) ? (rMin + '-' + rMax + 's') : '';

      return {
        orderNumber: orderNo,
        amount: finalMatchAmtAuto,
        playerLowName: playerLowName,
        playerHighName: playerHighName,
        creatorId: creatorId,
        creatorName: creatorName,
        matcherId: searchId,
        rangeInfo: rangeInfoStrAuto,
        isSplit: isSplitAuto,
        remainingAmount: remainingAmountAuto,
        splitOrderNumber: splitOrderNumberAuto,
        splitSide: creatorSide
      };
    }
  }
  return { error: 'NO_OPEN_BET' };
  } finally {
    lock.releaseLock();
  }
}

function logTransaction(userId, displayName, reqAmt, actAmt, refCode, status, reason) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Transactions');
  const searchId = userId ? userId.toString().trim() : '';
  const isWithdraw = (refCode && refCode.toString().indexOf('WD') === 0) || (reason && reason.toString().toLowerCase().indexOf('withdraw') !== -1);

  if (!isWithdraw) {
    const data = sheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      const rowUserId = data[i][1] ? data[i][1].toString().trim() : '';
      const rowStatus = data[i][6] ? data[i][6].toString() : '';
      const rowRef = data[i][5] ? data[i][5].toString() : '';
      const rowReason = data[i][7] ? data[i][7].toString().toLowerCase() : '';
      const rowTxId = data[i][0] ? data[i][0].toString() : '';

      if (rowUserId === searchId && rowStatus === 'escalated' && !rowTxId.startsWith('WD') &&
          (rowRef === 'PENDING_SLIP' || rowReason.includes('waiting for user'))) {
        const updatedReqAmt = Number(reqAmt) > 0 ? reqAmt : data[i][3];
        const updatedActAmt = Number(actAmt) >= 0 ? actAmt : data[i][4];
        
        sheet.getRange(i + 1, 4).setValue(updatedReqAmt);
        sheet.getRange(i + 1, 5).setValue(updatedActAmt);
        if (refCode && refCode !== 'PENDING_SLIP') sheet.getRange(i + 1, 6).setValue(refCode);
        sheet.getRange(i + 1, 7).setValue(status);
        sheet.getRange(i + 1, 8).setValue(reason);
        sheet.getRange(i + 1, 9).setValue(new Date());
        return rowTxId;
      }
    }
  }

  const prefix = isWithdraw ? 'WD' : 'TX';
  const txId = prefix + Date.now().toString().slice(-6);
  sheet.appendRow([txId, userId, displayName, reqAmt, actAmt, refCode, status, reason, new Date()]);
  return txId;
}

/**
 * Check if a transaction ref code already exists in the sheet.
 * Checks ALL statuses (success, escalated, rejected) to prevent resubmission
 * of any slip that has already been processed or is currently under review.
 */
function checkIfRefExists(refCode) {
  if (!refCode || refCode.trim() === '') return false; // Empty refs are handled separately
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Transactions');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowRef = data[i][5] ? data[i][5].toString().trim() : '';
    const rowStatus = data[i][6] ? data[i][6].toString() : '';
    // Block if same ref was ever submitted (any status except 'rejected' explicitly cleared by admin)
    if (rowRef === refCode && (rowStatus === 'success' || rowStatus === 'escalated')) return true;
  }
  return false;
}

function findPendingRequestedAmount(userId) {
  if (userId === null || userId === undefined) return null;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Transactions');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
  // Find last transaction for user with status escalated (or pending)
  for (let i = data.length - 1; i >= 1; i--) {
    const rowUserId = data[i][1] ? data[i][1].toString().trim() : '';
    if (rowUserId === searchId && data[i][6] === 'escalated' && data[i][7].toString().includes('Waiting for user')) {
      return Number(data[i][3]) || null;
    }
  }
  return null; // Return null if no pre-requested deposit session exists
}


// --- LINE OA COMMUNICATIONS HELPERS ---

function getLineUserProfile(userId) {
  const url = `https://api.line.me/v2/bot/profile/${userId}`;
  const options = {
    method: "get",
    headers: { "Authorization": "Bearer " + LINE_CHANNEL_ACCESS_TOKEN },
    muteHttpExceptions: true
  };
  try {
    const res = UrlFetchApp.fetch(url, options);
    return JSON.parse(res.getContentText());
  } catch (e) {
    return null;
  }
}

function replyToLine(replyToken, text, userId) {
  if (replyToken === 'MOCK_REPLY_TOKEN') return; // Simulator bypass
  
  const url = 'https://api.line.me/v2/bot/message/reply';
  let messageObj;
  
  if (typeof text === 'object' && text !== null) {
    var alt = (text.header && text.header.contents && text.header.contents[0] && text.header.contents[0].text)
      || (text.contents && text.contents[0] && text.contents[0].header && text.contents[0].header.contents && text.contents[0].header.contents[0].text)
      || 'ระบบบริการ Rocket Science 🚀';
    messageObj = {
      type: 'flex',
      altText: alt,
      contents: text
    };
  } else {
    let outText = String(text);
    const pName = (userId ? getPlayerNameFromDb(userId) : null) || 'ผู้เล่น';
    const tagStr = `@${pName}`;
    if (userId && outText.indexOf('@') === -1 && outText.indexOf('ถึงคุณ') === -1) {
      outText = `👤 [ถึงคุณ ${tagStr}]: ` + outText;
    }
    messageObj = { type: 'text', text: outText };
  }
  
  const payload = {
    replyToken: replyToken,
    messages: [messageObj]
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const resBody = res.getContentText();
  if (code >= 400) {
    Logger.log('[LINE Reply Error] Status: ' + code + ' Body: ' + resBody);
  }
  
  if (userId) {
    const logText = typeof text === 'object' ? '[Flex Message]' : text;
    logLineChatMessage(userId, 'ผู้ใช้', 'bot', logText, typeof text === 'object' ? 'flex' : 'text');
  }
  
  // Fallback to push message if replyToken has expired (HTTP 400 or similar)
  if (code >= 400 && userId) {
    pushToLine(userId, text);
  }
}

// =========================================================================
// REACT INTERACTIVE DASHBOARD SYNC CHANNELS
// =========================================================================
/**
 * Admin-only: Set or update a player's registered bank account.
 * Called from the admin dashboard; not accessible to players via LINE.
 */
function adminSetPlayerBank(userId, bankName, accountNumber, accountName) {
  var searchId = cleanUserId(userId);
  if (!searchId) return { ok: false, error: 'Missing userId' };
  updatePlayerBank(searchId, bankName.trim(), accountNumber.replace(/[\-\.\s]/g, ''), accountName.trim());
  // Notify the player via LINE push
  const msg = `🏦 แอดมินได้ลงทะเบียนบัญชีธนาคารสำหรับการถอนเงินของคุณแล้วครับ

🏦 ธนาคาร: ${bankName.trim()}
🔢 เลขบัญชี: ${accountNumber.replace(/[\-\.\s]/g, '')}
👤 ชื่อบัญชี: ${accountName.trim()}

หากข้อมูลไม่ถูกต้อง กรุณาติดต่อฝ่ายสนับสนุน`;
  pushToLine(userId, msg);
  return getDashboardData();
}

/**
 * Admin: Create a brand-new player record manually.
 */
function adminCreatePlayer(lineId, displayName, initialBalance) {
  var searchId = cleanUserId(lineId);
  if (!searchId || !displayName) return { ok: false, error: 'Missing lineId or displayName' };
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  // Prevent duplicates
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === searchId) {
      return { ok: false, error: 'Player already exists' };
    }
  }
  const balance = Number(initialBalance) || 0;
  sheet.appendRow([searchId, displayName.trim(), balance, new Date(), '', '', '']);
  // Welcome push
  const msg = `🎉 ยินดีต้อนรับสู่ระบบ Rocket Science Billing ครับ!\n\nบัญชีของคุณถูกสร้างโดยแอดมินเรียบร้อยแล้ว\n💰 เครดิตเริ่มต้น: ${balance} แต้ม\n\nหากมีข้อสงสัยติดต่อฝ่ายสนับสนุน: 089-104-1992`;
  pushToLine(searchId, msg);
  return getDashboardData();
}

/**
 * Admin: Rename a player's display name.
 */
function adminUpdatePlayerName(userId, newName) {
  var searchId = cleanUserId(userId);
  if (!searchId || !newName) return { ok: false, error: 'Missing parameters' };
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === searchId) {
      sheet.getRange(i + 1, 2).setValue(newName.trim());
      return getDashboardData();
    }
  }
  return { ok: false, error: 'Player not found' };
}

/**
 * Admin: Set a player's credit balance directly (absolute value, not delta).
 */
function adminSetPlayerBalance(userId, newBalance) {
  var searchId = cleanUserId(userId);
  if (!searchId) return { ok: false, error: 'Missing userId' };
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  const bal = Number(newBalance) || 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === searchId) {
      const oldBalance = Number(data[i][2]) || 0;
      sheet.getRange(i + 1, 3).setValue(bal);
      // Log as admin adjustment
      const tSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Transactions');
      const txId = 'ADJ' + new Date().getTime();
      tSheet.appendRow([txId, searchId, data[i][1], bal - oldBalance, bal, 'ADMIN_ADJUST', 'success', `Admin set balance: ${oldBalance} → ${bal}`, new Date()]);
      // Notify player
      const delta = bal - oldBalance;
      const sign = delta >= 0 ? '+' : '';
      pushToLine(searchId, `💰 แอดมินปรับยอดเครดิตของคุณ\n\nยอดเก่า: ${oldBalance} แต้ม\nปรับ: ${sign}${delta} แต้ม\nยอดใหม่: ${bal} แต้ม`);
      return getDashboardData();
    }
  }
  return { ok: false, error: 'Player not found' };
}

/**
 * Admin: Delete a player record permanently.
 */
function adminDeletePlayer(userId) {
  if (!userId) return { ok: false, error: 'Missing userId' };
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === searchId) {
      sheet.deleteRow(i + 1);
      return getDashboardData();
    }
  }
  return { ok: false, error: 'Player not found' };
}

function safeFormatDate(val, format) {
  if (!val) return '';
  if (typeof val === 'string' && val.trim().length > 0) {
    var d = new Date(val);
    if (!isNaN(d.getTime())) {
      try {
        return Utilities.formatDate(d, 'GMT+7', format || 'HH:mm:ss');
      } catch(_) {
        return val;
      }
    }
    return val;
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    try {
      return Utilities.formatDate(val, 'GMT+7', format || 'HH:mm:ss');
    } catch(_) {
      return val.toString();
    }
  }
  return '';
}

/**
 * Fetch players, transactions, and bets from Google Sheet database.
 */
function getDashboardData() {
  // Open spreadsheet ONCE and reuse across all sheet reads to avoid repeated API overhead
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const avatars = ['🐉', '🐯', '🦅', '🦁', '🐻', '🐼', '🦊', '🦉'];

  // 1. Players sheet
  const pData = ss.getSheetByName('Players').getDataRange().getValues();
  const players = [];
  for (let i = 1; i < pData.length; i++) {
    const row = pData[i];
    players.push({
      id: row[0].toString(),
      name: row[1].toString(),
      balance: Number(row[2]) || 0,
      joinDate: safeFormatDate(row[3], 'dd/MM/yy') || '-',
      bankName: row[4] ? row[4].toString() : '',
      bankAccount: row[5] ? formatBankAccount(row[5]) : '',
      accountName: row[6] ? row[6].toString() : '',
      isUser: row[0].toString() === 'user',
      avatar: avatars[i % avatars.length],
      lineUserId: row[7] ? row[7].toString() : ''
    });
  }

  // 2. Transactions sheet
  const tData = ss.getSheetByName('Transactions').getDataRange().getValues();
  const transactions = [];
  for (let i = tData.length - 1; i >= 1; i--) { // Reverse order = newest first
    const row = tData[i];
    transactions.push({
      id: row[0].toString(),
      playerId: row[1].toString(),
      playerName: row[2].toString(),
      requestedAmount: Number(row[3]) || 0,
      actualAmount: Number(row[4]) || 0,
      slipRef: row[5] ? row[5].toString() : '',
      status: row[6] ? row[6].toString() : 'pending',
      reviewReason: row[7] ? row[7].toString() : '',
      timestamp: safeFormatDate(row[8], 'HH:mm:ss'),
      logs: [`Verified in Sheets Database`, `Status: ${row[6] || 'pending'}`]
    });
  }

  // 3. Bets sheet
  const bData = ss.getSheetByName('Bets').getDataRange().getValues();
  const bets = [];
  for (let i = 1; i < bData.length; i++) {
    const row = bData[i];
    bets.push({
      id: 'bet_' + row[0].toString(),
      orderNumber: row[0].toString(),
      playerLowId: row[1] ? row[1].toString() : '',
      playerLowName: row[2] ? row[2].toString() : '',
      playerHighId: row[3] ? row[3].toString() : '',
      playerHighName: row[4] ? row[4].toString() : '',
      amount: Number(row[5]) || 0,
      type: row[6] ? row[6].toString() : '',
      rangeMin: row[7] ? Number(row[7]) : null,
      rangeMax: row[8] ? Number(row[8]) : null,
      status: row[9] ? row[9].toString() : '',
      winnerName: row[10] ? row[10].toString() : '',
      timestamp: safeFormatDate(row[11], 'HH:mm:ss')
    });
  }

  // 4. LineChatLogs sheet (inline — reuses same ss, no extra openById call)
  const chatLogs = [];
  try {
    const cData = ss.getSheetByName('LineChatLogs').getDataRange().getValues();
    for (let i = 1; i < cData.length; i++) {
      const row = cData[i];
      chatLogs.push({
        timestamp: safeFormatDate(row[0], 'HH:mm:ss'),
        userId: row[1] ? row[1].toString() : '',
        displayName: row[2] ? row[2].toString() : '',
        sender: row[3] ? row[3].toString() : '',
        text: row[4] ? row[4].toString() : '',
        type: row[5] ? row[5].toString() : 'text'
      });
    }
  } catch (e) {
    // LineChatLogs sheet may not exist yet — return empty array gracefully
  }

  return {
    players: players,
    transactions: transactions,
    bets: bets,
    chatLogs: chatLogs,
    activeGroupId: getActiveGroupId(),
    lineGroups: getLineGroups()
  };
}

/**
 * Approve transaction manually from dashboard
 */
function adminApproveTransaction(txId) {
  if (txId === null || txId === undefined) return false;
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tSheet = ss.getSheetByName('Transactions');
  const tData = tSheet.getDataRange().getValues();
  const searchId = txId.toString().trim();
  
  for (let i = 1; i < tData.length; i++) {
    const rowTxId = tData[i][0] ? tData[i][0].toString().trim() : '';
    if (rowTxId === searchId) {
      const userId = tData[i][1];
      const displayName = tData[i][2];
      const reqAmt = Number(tData[i][3]) || 0;
      let actualAmount = Number(tData[i][4]) || 0;
      if (actualAmount <= 0) {
        actualAmount = reqAmt;
        tSheet.getRange(i + 1, 5).setValue(actualAmount);
      }
      
      tSheet.getRange(i + 1, 7).setValue('success');
      tSheet.getRange(i + 1, 8).setValue('Manually approved by supervisor');
      
      const isWithdrawal = searchId.indexOf('WD') === 0 || (tData[i][5] && tData[i][5].toString().toUpperCase().indexOf('WD') !== -1) || (tData[i][7] && tData[i][7].toString().toLowerCase().indexOf('withdraw') !== -1);

      if (isWithdrawal) {
        // Withdrawal: the balance was already deducted, we just record the actual payout in sheet
        tSheet.getRange(i + 1, 5).setValue(reqAmt);
        let details = "ถอนเงินคืนเข้าบัญชีของคุณ";
        const bank = getPlayerBank(userId);
        if (bank) {
          details = "โอนเข้าบัญชี " + bank.bankName + " " + bank.accountNumber + " (" + bank.accountName + ")";
        }
        const wdFlex = constructBankingFlex("withdraw", reqAmt, details, null, userId);
        pushToLine(userId, wdFlex);
        logLineChatMessage(userId, displayName || 'ผู้เล่น', 'bot', `💸 [ถอนเงินสำเร็จ]: ` + reqAmt + ` THB โอนเข้าบัญชีแล้ว 🚀`, 'text');
      } else {
        // Deposit: credit player balance
        adjustPlayerBalance(userId, actualAmount, displayName);
        const dpFlex = constructBankingFlex("deposit", actualAmount, "เติมเงินสำเร็จ (แอดมินอนุมัติแมนนวล)", null, userId);
        pushToLine(userId, dpFlex);
        logLineChatMessage(userId, displayName || 'ผู้เล่น', 'bot', `🟢 [เติมเงินสำเร็จ]: +` + actualAmount + `pt เข้าบัญชีเรียบร้อย 🚀`, 'text');
      }
      return true;
    }
  }
  return false;
}

function adminRejectTransaction(txId, reason) {
  if (txId === null || txId === undefined) return false;
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tSheet = ss.getSheetByName('Transactions');
  const tData = tSheet.getDataRange().getValues();
  const searchId = txId.toString().trim();
  
  for (let i = 1; i < tData.length; i++) {
    const rowTxId = tData[i][0] ? tData[i][0].toString().trim() : '';
    if (rowTxId === searchId) {
      const userId = tData[i][1];
      const displayName = tData[i][2];
      const reqAmt = Number(tData[i][3]) || 0;
      
      tSheet.getRange(i + 1, 7).setValue('rejected');
      tSheet.getRange(i + 1, 8).setValue(reason || 'Rejected by supervisor');
      
      const isWithdrawal = searchId.indexOf('WD') === 0 || (tData[i][5] && tData[i][5].toString().toUpperCase().indexOf('WD') !== -1) || (tData[i][7] && tData[i][7].toString().toLowerCase().indexOf('withdraw') !== -1);
      
      if (isWithdrawal) {
        // Withdrawal rejected: refund the locked balance back to player
        adjustPlayerBalance(userId, reqAmt, displayName);
        const currentBalance = getPlayerBalance(userId, displayName);
        const rejFlex = constructRejectionFlex("WD", reqAmt, reason || 'ข้อมูลไม่ถูกต้อง', currentBalance, userId);
        pushToLine(userId, rejFlex);
        logLineChatMessage(userId, displayName || 'ผู้เล่น', 'bot', `❌ [ปฏิเสธถอนเงิน]: ยอด ` + reqAmt + ` THB (คืนแต้มเข้าบัญชีแล้ว)`, 'text');
      } else {
        const currentBalance = getPlayerBalance(userId, displayName);
        const rejFlex = constructRejectionFlex("DP", reqAmt, reason || 'สลิปไม่ผ่านเกณฑ์ตรวจสอบ', currentBalance, userId);
        pushToLine(userId, rejFlex);
        logLineChatMessage(userId, displayName || 'ผู้เล่น', 'bot', `❌ [ปฏิเสธฝากเงิน]: ยอด ` + reqAmt + ` THB (สาเหตุ: ` + (reason || 'สลิปไม่ผ่านเกณฑ์') + `)`, 'text');
      }
      return true;
    }
  }
  return false;
}


/**
 * Resolve matched bets in spreadsheet database based on final rocket time
 */
function adminResolveBets(finalTime, targetMin, targetMax) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const bSheet = ss.getSheetByName('Bets');
  if (!bSheet) return getDashboardData();
  
  // 1. Perform automatic matching of any unmatched pending bets
  autoMatchPendingBets(ss, bSheet);
  
  // 2. Read sheet values again to resolve matched bets
  const bData = bSheet.getDataRange().getValues();
  const timeSec = Number(finalTime);
  const tMin = targetMin ? Number(targetMin) : (Number(PropertiesService.getScriptProperties().getProperty('TARGET_MIN')) || 330);
  const tMax = targetMax ? Number(targetMax) : (Number(PropertiesService.getScriptProperties().getProperty('TARGET_MAX')) || 380);
  
  for (let i = 1; i < bData.length; i++) {
    const row = bData[i];
    const status = row[9];
    
    if (status === 'matched') {
      const orderNo = row[0];
      const pLowId = cleanUserId(row[1]);
      const pLowName = row[2];
      const pHighId = cleanUserId(row[3]);
      const pHighName = row[4];
      const amount = Number(row[5]);
      const type = row[6];
      const rangeMin = row[7] ? Number(row[7]) : tMin;
      const rangeMax = row[8] ? Number(row[8]) : tMax;
      
      let isLowWinner = true;
      if (type === 'range' || (rangeMin && rangeMax)) {
        const midPoint = (rangeMin + rangeMax) / 2;
        if (timeSec < rangeMin) {
          isLowWinner = true;
        } else if (timeSec > rangeMax) {
          isLowWinner = false;
        } else {
          isLowWinner = timeSec <= midPoint;
        }
      } else {
        isLowWinner = timeSec < ((tMin + tMax) / 2);
      }
      
      const winnerId = isLowWinner ? pLowId : pHighId;
      const winnerName = isLowWinner ? pLowName : pHighName;
      const loserId = isLowWinner ? pHighId : pLowId;
      const loserName = isLowWinner ? pHighName : pLowName;
      
      // Calculate 10% commission deduction from winnings (opponent's bet portion)
      const commissionRate = 0.10;
      const winnings = amount;
      const commission = winnings * commissionRate;
      const payout = amount + (winnings - commission); // amount * 1.90
      
      // Perform payment in Sheets
      adjustPlayerBalance(winnerId, payout);
      
      // Settle row
      bSheet.getRange(i + 1, 10).setValue('resolved');
      bSheet.getRange(i + 1, 11).setValue(winnerName);
      
      // Send auto messages (push notifications) to winner and loser
      try {
        const winBal = getPlayerBalance(winnerId, winnerName);
        const winFlex = constructMatchResultFlex(true, orderNo, amount, finalTime, payout, winBal, winnings, commission, winnerId);
        pushToLine(winnerId, winFlex);
      } catch (err) {
        Logger.log("Error pushing win message: " + err);
      }
      
      try {
        const loseBal = getPlayerBalance(loserId, loserName);
        const loseFlex = constructMatchResultFlex(false, orderNo, amount, finalTime, 0, loseBal, winnings, commission, loserId);
        pushToLine(loserId, loseFlex);
      } catch (err) {
        Logger.log("Error pushing lose message: " + err);
      }
    }
  }

  // 3. Broadcast Round Summary Flex to all active groups
  try {
    var ssInfo = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Rockets');
    var rocketName = 'ช่างบั้งไฟสด';
    if (ssInfo) {
      var rData = ssInfo.getDataRange().getValues();
      for (var r = 1; r < rData.length; r++) {
        if (rData[r][3] === 'ACTIVE' || rData[r][3] === 'LOCKED') {
          rocketName = rData[r][0] || rocketName;
          break;
        }
      }
    }
    var roundFlex = constructRoundSummaryFlex(timeSec, tMin, tMax, rocketName);
    sendAdminMessageToLine('ALL', roundFlex);
  } catch(e) {
    Logger.log("Error pushing round summary flex: " + e.toString());
  }

  setRocketRoundStatus('ACTIVE');
  return getDashboardData();
}

function adminVoidRound() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const bSheet = ss.getSheetByName('Bets');
  const bData = bSheet.getDataRange().getValues();

  for (let i = 1; i < bData.length; i++) {
    const status = bData[i][9];
    if (status === 'pending_match' || status === 'matched' || status === 'pending_cancel') {
      const orderNo = bData[i][0];
      const lowId = bData[i][1];
      const lowName = bData[i][2];
      const highId = bData[i][3];
      const highName = bData[i][4];
      const amt = Number(bData[i][5]) || 0;

      bSheet.getRange(i + 1, 10).setValue('cancelled');

      if (lowId) adjustPlayerBalance(lowId, amt, lowName);
      if (highId) adjustPlayerBalance(highId, amt, highName);
    }
  }

  setRocketRoundStatus('ACTIVE');

  var groups = getLineGroups();
  var activeId = getActiveGroupId();
  var targetGroups = {};
  for (var gi = 0; gi < groups.length; gi++) {
    if (groups[gi].id) targetGroups[groups[gi].id] = true;
  }
  if (activeId) targetGroups[activeId] = true;
  var groupKeys = Object.keys(targetGroups);

  if (groupKeys.length > 0) {
    try {
      var roundNotice = "⛔ [โมฆะรอบ / ช่าง ⛔]: ยกเลิกแผลดวลค้างทั้งหมด และคืนแต้ม 100% เรียบร้อยครับ 🚀";
      for (var gk = 0; gk < groupKeys.length; gk++) {
        pushLineGroupMessage(groupKeys[gk], roundNotice);
      }
    } catch(e) {
      Logger.log("Error pushing void notice: " + e);
    }
  }

  return getDashboardData();
}

/**
 * Automatically match pending bets in Sheets database
 */
function autoMatchPendingBets(ss, bSheet) {
  const bData = bSheet.getDataRange().getValues();
  
  // System bots to match against if no opposite real players
  const bots = [
    { id: 'p1', name: 'วชิระ ส. (โบ๊ท)' },
    { id: 'p2', name: 'เบนซ์ (Benz)' },
    { id: 'p3', name: 'อาร์ต (Art)' },
    { id: 'p4', name: 'เจ๋ง (Jeng)' }
  ];
  
  for (let i = 1; i < bData.length; i++) {
    const row = bData[i];
    const status = row[9];
    
    if (status === 'pending_match') {
      const orderNo = row[0];
      let pLowId = cleanUserId(row[1]);
      let pLowName = row[2];
      let pHighId = cleanUserId(row[3]);
      let pHighName = row[4];
      const amount = Number(row[5]);
      
      // Search for opposite pending bet of same amount in other rows
      let paired = false;
      for (let j = i + 1; j < bData.length; j++) {
        const oRow = bData[j];
        const oStatus = oRow[9];
        const oAmount = Number(oRow[5]);
        
        if (oStatus === 'pending_match' && oAmount === amount) {
          let oLowId = oRow[1];
          let oHighId = oRow[3];
          
          if (pLowId && !pHighId && !oLowId && oHighId && pLowId !== oHighId) {
            pHighId = oHighId;
            pHighName = oRow[4];
            paired = true;
          } else if (!pLowId && pHighId && oLowId && !oHighId && pHighId !== oLowId) {
            pLowId = oLowId;
            pLowName = oRow[2];
            paired = true;
          }
          
          if (paired) {
            bSheet.getRange(i + 1, 2).setValue(pLowId);
            bSheet.getRange(i + 1, 3).setValue(pLowName);
            bSheet.getRange(i + 1, 4).setValue(pHighId);
            bSheet.getRange(i + 1, 5).setValue(pHighName);
            bSheet.getRange(i + 1, 10).setValue('matched');
            
            // Cancel/clear second row
            bSheet.getRange(j + 1, 10).setValue('cancelled');
            bData[j][9] = 'cancelled';
            break;
          }
        }
      }
      
      // If no opponent found, auto-match against system bot
      if (!paired) {
        let opponent = null;
        for (let bIdx = 0; bIdx < bots.length; bIdx++) {
          const candidate = bots[bIdx];
          if (candidate.id !== pLowId && candidate.id !== pHighId) {
            opponent = candidate;
            break;
          }
        }
        
        if (opponent) {
          if (!pLowId) {
            pLowId = opponent.id;
            pLowName = opponent.name;
          } else {
            pHighId = opponent.id;
            pHighName = opponent.name;
          }
          
          // Lock bot player credit balance
          adjustPlayerBalance(opponent.id, -amount);
          
          bSheet.getRange(i + 1, 2).setValue(pLowId);
          bSheet.getRange(i + 1, 3).setValue(pLowName);
          bSheet.getRange(i + 1, 4).setValue(pHighId);
          bSheet.getRange(i + 1, 5).setValue(pHighName);
          bSheet.getRange(i + 1, 10).setValue('matched');
        }
      }
    }
  }
}

/**
 * Request Cancel Bet
 */
function adminRequestCancelBet(betId) {
  const orderNo = betId.replace('bet_', '');
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const bSheet = ss.getSheetByName('Bets');
  const bData = bSheet.getDataRange().getValues();
  for (let i = 1; i < bData.length; i++) {
    if (bData[i][0].toString() === orderNo) {
      bSheet.getRange(i + 1, 10).setValue('pending_cancel');
      return true;
    }
  }
  return false;
}

/**
 * Handle verification of client simulation mock slips
 */
function verifyMockSlipFromClient(depositAmt, realAmt, ref, isQRValid, isDupe) {
  let status = 'success';
  let reason = '';
  if (!isQRValid) {
    status = 'escalated';
    reason = 'QR Scan Failed (Client Mock)';
  } else if (isDupe) {
    status = 'escalated';
    reason = 'Duplicate Transaction (Client Mock)';
  } else if (realAmt !== depositAmt) {
    status = 'escalated';
    reason = `Amount Mismatch (Requested ${depositAmt} vs Slip ${realAmt})`;
  } else {
    // Add credit
    adjustPlayerBalance('user', realAmt);
  }
  
  logTransaction('user', 'คุณ (You)', depositAmt, realAmt, ref, status, reason);
  return { status: status, reason: reason };
}

/**
 * Simulate messaging text command from client dashboard
 */
function simulateTextMessageFromDashboard(text, userId, displayName, targetGroupId) {
  handleTextMessage(text, userId, displayName, 'MOCK_REPLY_TOKEN', targetGroupId || null);
}

/**
 * Delete spreadsheet database values
 */
function resetGoogleSheetsDatabase() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  
  // Reset Players
  const pSheet = ss.getSheetByName('Players');
  pSheet.clearContents();
  pSheet.appendRow(['User ID', 'Display Name', 'Balance (Credits)', 'Registered Date', 'Bank Name', 'Bank Account Number', 'Bank Account Holder Name', 'LINE User ID']);

  // Reset Transactions
  const tSheet = ss.getSheetByName('Transactions');
  tSheet.clearContents();
  tSheet.appendRow(['Tx ID', 'User ID', 'Display Name', 'Requested Amount', 'Actual Amount', 'Bank Ref', 'Status', 'Reason', 'Timestamp']);

  // Reset Bets
  const bSheet = ss.getSheetByName('Bets');
  bSheet.clearContents();
  bSheet.appendRow(['Order Number', 'Player Low ID', 'Player Low Name', 'Player High ID', 'Player High Name', 'Amount', 'Type', 'Range Min', 'Range Max', 'Status', 'Winner Name', 'Timestamp']);

  // Reset LineChatLogs
  const cSheet = ss.getSheetByName('LineChatLogs') || ss.insertSheet('LineChatLogs');
  cSheet.clearContents();
  cSheet.appendRow(['Timestamp', 'User ID', 'Display Name', 'Sender', 'Message Text', 'Message Type']);
}

/**
 * Push a message to a LINE Group (using groupId directly, no Players lookup).
 * @param {string} groupId - LINE Group ID (starts with 'C')
 * @param {Object|string} text - Message payload
 */
function pushLineGroupMessage(groupId, text) {
  if (!groupId) {
    Logger.log('[pushLineGroupMessage] Error: No groupId specified.');
    return { success: false, error: 'NO_GROUP_ID' };
  }
  var url = 'https://api.line.me/v2/bot/message/push';
  var messageObj;
  if (typeof text === 'object' && text !== null) {
    var alt = (text.header && text.header.contents && text.header.contents[0] && text.header.contents[0].text)
      ? text.header.contents[0].text
      : 'ระบบบริการ Rocket Science 🚀';
    messageObj = { type: 'flex', altText: alt, contents: text };
  } else {
    messageObj = { type: 'text', text: String(text) };
  }
  var payload = { to: groupId, messages: [messageObj] };
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    var body = res.getContentText();
    Logger.log('[pushLineGroupMessage to ' + groupId + '] Status: ' + code + ' Body: ' + body);
    
    if (code === 200) {
      return { success: true, code: 200, groupId: groupId };
    }

    var errorMsg = 'LINE API Error (HTTP ' + code + ')';
    if (body && (body.indexOf('monthly limit') !== -1 || body.indexOf('reached your monthly') !== -1)) {
      errorMsg = 'โควตา Push Message ของ LINE OA เดือนนี้เต็มแล้ว (300/300 ข้อความ) — กรุณาอัปเกรดแพ็กเกจเป็น Basic/Pro ที่ manager.line.biz เพื่อส่งข้อความได้ไม่จำกัดครับ';
    } else if (body && body.indexOf('Invalid reply token') !== -1) {
      errorMsg = 'โทเค็นตอบกลับหมดอายุ';
    } else if (body && body.indexOf('Authentication failed') !== -1) {
      errorMsg = 'LINE Channel Access Token ไม่ถูกต้องหรือหมดอายุ';
    }

    // Fallback: If flex fails and NOT a quota error, try sending plain text
    if (typeof text === 'object' && code !== 429 && body.indexOf('monthly limit') === -1) {
      var headerStr = (text.header && text.header.contents && text.header.contents[0] && text.header.contents[0].text) || '';
      var fbText = '🚀 ' + headerStr;
      var fbRes = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
        payload: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: fbText }] }),
        muteHttpExceptions: true
      });
      var fbCode = fbRes.getResponseCode();
      if (fbCode === 200) {
        return { success: true, code: fbCode, groupId: groupId, fallback: true };
      }
    }
    return { success: false, code: code, error: errorMsg, body: body, groupId: groupId };
  } catch (e) {
    Logger.log('[pushLineGroupMessage] Exception: ' + e.toString());
    return { success: false, error: e.toString(), groupId: groupId };
  }
}

/**
 * Diagnostic test push from Admin Portal to verify LINE group connectivity
 */
function adminTestPushGroupMessage(targetGroupId) {
  var gid = targetGroupId || getActiveGroupId();
  if (!gid) {
    return { success: false, error: 'ไม่พบ Group ID ที่เชื่อมต่อ — กรุณาใส่ Group ID ก่อนทดสอบครับ' };
  }
  var testMsg = '🔔 ทดสอบการเชื่อมต่อระบบ Rocket Science จาก Admin Web App (เวลา: ' + Utilities.formatDate(new Date(), 'GMT+7', 'HH:mm:ss') + ') 🚀';
  var res = pushLineGroupMessage(gid, testMsg);
  return {
    success: res.success,
    code: res.code,
    groupId: gid,
    body: res.body || '',
    error: res.error || null
  };
}

/**
 * Push a message to a player's 1-on-1 LINE OA DM (resolves short ID → raw LINE userId).
 * @param {string} userId - Short passport-style ID or raw LINE userId
 * @param {Object|string} text - Message payload
 */
function pushToLine(userId, text) {
  if (!userId || userId === 'user' || (typeof userId === 'string' && userId.startsWith('p') && !userId.startsWith('player_U'))) return;

  var rawLineUserId = (typeof userId === 'string' && (userId.startsWith('U') || userId.startsWith('C')))
    ? userId
    : getRawLineUserId(userId);
  if (!rawLineUserId) return;
  
  const url = 'https://api.line.me/v2/bot/message/push';
  let messageObj;
  
  if (typeof text === 'object' && text !== null) {
    var alt = (text.header && text.header.contents && text.header.contents[0] && text.header.contents[0].text)
      ? text.header.contents[0].text
      : 'ระบบบริการ Rocket Science 🚀';
    messageObj = {
      type: 'flex',
      altText: alt,
      contents: text
    };
  } else {
    messageObj = { type: 'text', text: String(text) };
  }
  
  const payload = {
    to: rawLineUserId,
    messages: [messageObj]
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    var body = res.getContentText();
    Logger.log('[pushToLine to ' + rawLineUserId + '] Status: ' + code + ' Body: ' + body);
    if (code !== 200 && typeof text === 'object') {
      var headerStr = (text.header && text.header.contents && text.header.contents[0] && text.header.contents[0].text) || '';
      var fbText = '🚀 ' + headerStr;
      UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
        payload: JSON.stringify({ to: rawLineUserId, messages: [{ type: 'text', text: fbText }] }),
        muteHttpExceptions: true
      });
    }
  } catch (e) {
    Logger.log('[pushToLine] Error: ' + e.toString());
  }
  
  // Log the push message
  const logText = typeof text === 'object' ? '[Flex Message]' : String(text);
  logLineChatMessage(userId, 'ผู้ใช้', 'bot', logText, typeof text === 'object' ? 'flex' : 'text');
}

// =========================================================================
// LINE FLEX MESSAGE CREATOR HELPERS
// =========================================================================

function constructMainMenuFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#0D9488",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "🚀 Rocket Science Menu",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "เลือกบริการที่คุณต้องการทำรายการครับ",
          "size": "xxs",
          "color": "#64748B",
          "align": "center",
          "wrap": true
        },
        {
          "type": "separator",
          "margin": "xs",
          "color": "#F1F5F9"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "xs",
          "margin": "xs",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#0284C7",
              "action": {
                "type": "message",
                "label": "💳 เช็คยอด",
                "text": "เช็คยอด"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#10B981",
              "action": {
                "type": "message",
                "label": "💰 ฝากเงิน",
                "text": "ฝากเงิน"
              }
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "xs",
          "margin": "xs",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#64748B",
              "action": {
                "type": "message",
                "label": "💸 ถอนเงิน",
                "text": "ถอนเงิน"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#6366F1",
              "action": {
                "type": "message",
                "label": "⚔️ รายการดวล",
                "text": "รายการดวล"
              }
            }
          ]
        }
      ]
    }
  };
}

function constructBalanceFlex(displayName, balance) {
  var formattedBal = Number(balance || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#0284C7",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "💰 ยอดแต้มของคุณ",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": formattedBal,
          "weight": "bold",
          "color": "#0284C7",
          "size": "xl",
          "align": "center"
        },
        {
          "type": "text",
          "text": "แต้มคงเหลือ",
          "color": "#94A3B8",
          "size": "xxs",
          "align": "center"
        },
        {
          "type": "separator",
          "margin": "xs",
          "color": "#F1F5F9"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "👤 ชื่อ", "color": "#94A3B8", "size": "xxs", "flex": 4 },
            { "type": "text", "text": displayName || "ผู้เล่น", "weight": "bold", "color": "#334155", "size": "xxs", "flex": 6, "align": "end" }
          ]
        }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "xs",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#10B981",
              "action": {
                "type": "message",
                "label": "💰 ฝากเงิน",
                "text": "ฝากเงิน"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#64748B",
              "action": {
                "type": "message",
                "label": "💸 ถอนเงิน",
                "text": "ถอนเงิน"
              }
            }
          ]
        }
      ]
    }
  };
}

function constructDepositFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#10B981",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "💰 ฝากเครดิต",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "เลือกยอดเงินที่ต้องการฝากครับ",
          "size": "xxs",
          "color": "#64748B",
          "align": "center",
          "wrap": true
        },
        {
          "type": "separator",
          "margin": "xs",
          "color": "#F1F5F9"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "xs",
          "margin": "xs",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#10B981",
              "action": {
                "type": "message",
                "label": "100 บาท",
                "text": "100"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#10B981",
              "action": {
                "type": "message",
                "label": "300 บาท",
                "text": "300"
              }
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "xs",
          "margin": "xs",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#10B981",
              "action": {
                "type": "message",
                "label": "500 บาท",
                "text": "500"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#10B981",
              "action": {
                "type": "message",
                "label": "1,000 บาท",
                "text": "1000"
              }
            }
          ]
        }
      ]
    }
  };
}

function constructDepositInvoiceFlex(depositAmt) {
  var formattedAmt = Number(depositAmt || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#10B981",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "🧾 ใบแจ้งยอดโอน",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": formattedAmt + " THB",
          "weight": "bold",
          "color": "#059669",
          "size": "xl",
          "align": "center"
        },
        {
          "type": "text",
          "text": "ยอดโอนเงินฝาก",
          "color": "#94A3B8",
          "size": "xxs",
          "align": "center"
        },
        {
          "type": "separator",
          "margin": "xs",
          "color": "#F1F5F9"
        },
        {
          "type": "box",
          "layout": "vertical",
          "margin": "xs",
          "contents": [
            {
              "type": "box",
              "layout": "horizontal",
              "contents": [
                { "type": "text", "text": "🏦 SCB", "color": "#94A3B8", "size": "xxs", "flex": 4 },
                { "type": "text", "text": "064-2-35656-6", "weight": "bold", "color": "#334155", "size": "xxs", "flex": 6, "align": "end" }
              ]
            },
            {
              "type": "box",
              "layout": "horizontal",
              "contents": [
                { "type": "text", "text": "👤 ชื่อ", "color": "#94A3B8", "size": "xxs", "flex": 4 },
                { "type": "text", "text": "อิทธิรัตน์ แนวหล่า", "weight": "bold", "color": "#334155", "size": "xxs", "flex": 6, "align": "end" }
              ]
            }
          ]
        },
        {
          "type": "separator",
          "margin": "xs",
          "color": "#F1F5F9"
        },
        {
          "type": "text",
          "text": "💡 โอนเสร็จส่งสลิปในแชทรับเครดิตทันทีครับ",
          "size": "xxs",
          "color": "#64748B",
          "align": "center",
          "wrap": true,
          "margin": "xs"
        }
      ]
    }
  };
}

function constructBankRegistrationFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#0D9488",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "📋 ยืนยันบัญชีธนาคาร",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "📸 ส่งรูปสมุดบัญชี หรือ สกรีนช็อตแอปธนาคารที่เห็นชื่อ-เลขบัญชีตรงกับที่ใช้โอนฝากเข้ามาครับ",
          "size": "xxs",
          "color": "#334155",
          "wrap": true,
          "align": "center"
        }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": "#0D9488",
          "action": {
            "type": "uri",
            "label": "📞 ติดต่อ 089-104-1992",
            "uri": "tel:0891041992"
          }
        }
      ]
    }
  };
}

function constructWithdrawalFlex(bankName, accountNumber, accountName, balance) {
  var formattedBal = Number(balance || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#64748B",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "💸 ถอนเงินคืน",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": formattedBal + " pt",
          "weight": "bold",
          "color": "#10B981",
          "size": "xl",
          "align": "center"
        },
        {
          "type": "text",
          "text": "เครดิตคงเหลือ",
          "color": "#94A3B8",
          "size": "xxs",
          "align": "center"
        },
        {
          "type": "separator",
          "margin": "xs",
          "color": "#F1F5F9"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "🏦 บัญชีรับเงิน", "color": "#94A3B8", "size": "xxs", "flex": 4 },
            { "type": "text", "text": (bankName || '') + ' ' + (accountNumber || ''), "weight": "bold", "color": "#334155", "size": "xxs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "👤 ชื่อบัญชี", "color": "#94A3B8", "size": "xxs", "flex": 4 },
            { "type": "text", "text": accountName || "ผู้เล่น", "weight": "bold", "color": "#334155", "size": "xxs", "flex": 6, "align": "end" }
          ]
        }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "xs",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#64748B",
              "action": {
                "type": "message",
                "label": "ถอน 100",
                "text": "ถอน 100"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#64748B",
              "action": {
                "type": "message",
                "label": "ถอน 500",
                "text": "ถอน 500"
              }
            }
          ]
        }
      ]
    }
  };
}


function constructCancelOrderMiniFlex(orderNo) {
  return {
    "type": "bubble",
    "size": "micro",
    "body": {
      "type": "box",
      "layout": "vertical",
      "paddingAll": "md",
      "backgroundColor": "#1E1B4B",
      "cornerRadius": "md",
      "contents": [
        {
          "type": "text",
          "text": "⛔️ ยกเลิกสำเร็จ ⛔️",
          "weight": "bold",
          "color": "#EF4444",
          "size": "sm",
          "align": "center"
        },
        {
          "type": "text",
          "text": "ยกเลิก Order #" + orderNo + " สำเร็จ!",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center",
          "margin": "xs"
        }
      ]
    }
  };
}

function constructRuleGuideFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#E0E7FF",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "🚀 ROCKET SCIENCE",
          "weight": "bold",
          "color": "#4338CA",
          "size": "xxs",
          "align": "center"
        },
        {
          "type": "text",
          "text": "📖 กติกา & วิธีการเล่นบั้งไฟ",
          "weight": "bold",
          "color": "#1E1B4B",
          "size": "sm",
          "align": "center",
          "margin": "xs"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#DCFCE7",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "1️⃣ แทงตามราคาช่าง (ปรับได้ ±5 / ±10)",
              "weight": "bold",
              "color": "#166534",
              "size": "xs"
            },
            {
              "type": "text",
              "text": "• ทายชนะ (สูง): ชล, +5ชล, -5ชล, +10ชล, -10ชล\n• ทายแพ้ (ต่ำ): ชถ, +5ชถ, -5ชถ, +10ชถ, -10ชถ\nเช่น ชล500, +5ชล1000, -10ชถ200",
              "color": "#14532D",
              "size": "xxs",
              "wrap": true,
              "margin": "xs"
            }
          ]
        },
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#E0F2FE",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "2️⃣ เปิดราคาเอง (ช่วงห่าง 80 วิพอดี)",
              "weight": "bold",
              "color": "#0369A1",
              "size": "xs"
            },
            {
              "type": "text",
              "text": "• ช่วงเวลาห่าง 80 วิ: 300-380ล500 หรือ 350-430ถ1000\n• เผื่อช่างไม่ต่อย: ใส่ ชตย เช่น 300-380ล500 ชตย",
              "color": "#0C4A6E",
              "size": "xxs",
              "wrap": true,
              "margin": "xs"
            }
          ]
        },
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#F3E8FF",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "3️⃣ การรับแผลดวล & ขั้นต่ำ 20%",
              "weight": "bold",
              "color": "#6B21A8",
              "size": "xs"
            },
            {
              "type": "text",
              "text": "• แตะปุ่มเปอร์เซ็นต์ [20%] [40%] [80%] [100%]\n• หรือพิมพ์: [เลขบิล] [แต้ม] เช่น 4812 200 หรือ ต4812\n• ขั้นต่ำการรับแผลคือ 20% ของยอดแผล",
              "color": "#581C87",
              "size": "xxs",
              "wrap": true,
              "margin": "xs"
            }
          ]
        },
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#FFE4E6",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "4️⃣ การยกเลิกแผลดวล",
              "weight": "bold",
              "color": "#9F1239",
              "size": "xs"
            },
            {
              "type": "text",
              "text": "• พิมพ์ ยกเลิก [เลขบิล] เช่น ยกเลิก 4812 (ก่อนมีคู่รับ)",
              "color": "#881337",
              "size": "xxs",
              "wrap": true,
              "margin": "xs"
            }
          ]
        }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "horizontal",
      "paddingAll": "xs",
      "contents": [
        {
          "type": "button",
          "action": {
            "type": "message",
            "label": "📋 ดูกระดานดวลสด",
            "text": "กระดานดวล"
          },
          "style": "primary",
          "color": "#334155",
          "height": "sm"
        }
      ]
    }
  };
}

function constructBetOpenFlex(orderNo, amount, side, creatorName, rangeInfo, isChotoy, userTypedCmd, isPreQuote) {
  var sideShort = side === 'high' ? 'ล' : 'ถ';
  var cleanCmd = (userTypedCmd && typeof userTypedCmd === 'string') ? userTypedCmd.trim() : (sideShort + amount);
  // Strip any leading range numbers like "350-450" or "300/380" in front of the betting command
  cleanCmd = cleanCmd.replace(/^\d+[-\/]\d+/, '').trim();
  // Strip trailing "pt" if present
  cleanCmd = cleanCmd.replace(/pt$/i, '').trim();
  if (!cleanCmd) cleanCmd = sideShort + amount;

  var cardTitle = (cleanCmd.indexOf(amount.toString()) !== -1) ? cleanCmd : (cleanCmd + ' ' + amount);
  var numAmount = Number(amount) || 100;

  var amt20 = Math.max(1, Math.round(numAmount * 0.20));
  var amt40 = Math.max(1, Math.round(numAmount * 0.40));
  var amt80 = Math.max(1, Math.round(numAmount * 0.80));
  var amt100 = numAmount;

  // Row 1: [20% Amt] [40% Amt] [80% Amt] (Pastel Blue)
  var row1Buttons = [
    { label: amt20.toString(), val: amt20 },
    { label: amt40.toString(), val: amt40 },
    { label: amt80.toString(), val: amt80 }
  ].map(function(item) {
    return {
      "type": "box",
      "layout": "vertical",
      "flex": 1,
      "backgroundColor": "#BAE6FD",
      "cornerRadius": "sm",
      "paddingAll": "xs",
      "action": {
        "type": "message",
        "label": item.label,
        "text": "ต " + orderNo + " " + item.val
      },
      "contents": [
        { "type": "text", "text": item.label, "color": "#0369A1", "weight": "bold", "size": "xs", "align": "center" }
      ]
    };
  });

  // Row 2: [100% Amt] [Cancel] (Pastel Green & Pastel Red)
  var row2Buttons = [
    {
      "type": "box",
      "layout": "vertical",
      "flex": 1,
      "backgroundColor": "#BBF7D0",
      "cornerRadius": "sm",
      "paddingAll": "xs",
      "action": {
        "type": "message",
        "label": amt100.toString(),
        "text": "ต " + orderNo + " " + amt100
      },
      "contents": [
        { "type": "text", "text": amt100.toString(), "color": "#15803D", "weight": "bold", "size": "xs", "align": "center" }
      ]
    },
    {
      "type": "box",
      "layout": "vertical",
      "flex": 1,
      "backgroundColor": "#FECDD3",
      "cornerRadius": "sm",
      "paddingAll": "xs",
      "action": {
        "type": "message",
        "label": "⛔ ยกเลิก",
        "text": "ยกเลิก " + orderNo
      },
      "contents": [
        { "type": "text", "text": "⛔ ยกเลิก", "color": "#9F1239", "weight": "bold", "size": "xs", "align": "center" }
      ]
    }
  ];

  var bodyContents = [
    {
      "type": "text",
      "text": cardTitle + (isChotoy ? ' (ชตย)' : ''),
      "weight": "bold",
      "color": "#1E293B",
      "size": "md",
      "align": "center"
    },
    {
      "type": "separator",
      "margin": "xs",
      "color": "#F1F5F9"
    },
    {
      "type": "box",
      "layout": "horizontal",
      "spacing": "xs",
      "margin": "xs",
      "contents": row1Buttons
    },
    {
      "type": "box",
      "layout": "horizontal",
      "spacing": "xs",
      "margin": "xs",
      "contents": row2Buttons
    },
    {
      "type": "text",
      "text": "หรือพิมพ์: " + orderNo + " [จำนวนเงิน]",
      "size": "xxs",
      "color": "#2563EB",
      "weight": "bold",
      "align": "center",
      "margin": "xs"
    }
  ];

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#334155",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "Order #" + orderNo + (isPreQuote ? ' (รอราคาช่าง)' : ''),
          "weight": "bold",
          "color": "#F8FAFC",
          "size": "xs",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": bodyContents
    }
  };
}

function constructMatchNotificationFlex(orderNo, amount, playerLowName, playerHighName, rangeInfo, isChotoy, rocketName) {
  var lowText = playerLowName || "ผู้เล่น";
  var highText = playerHighName || "คู่ดวล";
  var cleanAmt = typeof amount === 'number' ? amount : (parseInt(amount) || amount);

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#1E1B4B",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "🚀 แมตช์สำเร็จ #" + orderNo,
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "sm",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": cleanAmt + " pt",
          "weight": "bold",
          "color": "#059669",
          "size": "xl",
          "align": "center"
        },
        {
          "type": "separator",
          "margin": "sm",
          "color": "#F0F0F0"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "sm",
          "contents": [
            { "type": "text", "text": "🔻 ต่ำ (Low):", "color": "#DC2626", "size": "xs", "weight": "bold", "flex": 4 },
            { "type": "text", "text": "@" + lowText, "color": "#1E293B", "size": "xs", "weight": "bold", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "🔺 สูง (High):", "color": "#16A34A", "size": "xs", "weight": "bold", "flex": 4 },
            { "type": "text", "text": "@" + highText, "color": "#1E293B", "size": "xs", "weight": "bold", "flex": 6, "align": "end" }
          ]
        },
        ...(rangeInfo ? [{
          "type": "text",
          "text": "ช่วงราคา: " + rangeInfo,
          "color": "#64748B",
          "size": "xxs",
          "align": "center",
          "margin": "sm"
        }] : [])
      ]
    }
  };
}

function constructRoundSummaryFlex(finalTime, targetMin, targetMax, rocketName) {
  var isLowWin = finalTime < targetMin;
  var isHighWin = finalTime > targetMax;
  var outcomeTitle = isLowWin ? "🔻 ฝั่งต่ำ (ชล)" : (isHighWin ? "🔺 ฝั่งสูง (ชถ)" : "🎯 ในราคาช่าง (คืนแต้ม)");
  var outcomeColor = isLowWin ? "#DC2626" : (isHighWin ? "#16A34A" : "#D97706");

  var bodyContents = [
    {
      "type": "text",
      "text": finalTime + "s",
      "weight": "bold",
      "color": "#1E1B4B",
      "size": "3xl",
      "align": "center"
    },
    {
      "type": "text",
      "text": "เวลาบั้งไฟจริง",
      "size": "xxs",
      "color": "#64748B",
      "align": "center",
      "margin": "none"
    },
    {
      "type": "separator",
      "margin": "sm",
      "color": "#F0F0F0"
    },
    {
      "type": "box",
      "layout": "horizontal",
      "margin": "sm",
      "contents": [
        { "type": "text", "text": "🎯 ราคาช่าง:", "color": "#64748B", "size": "xs", "flex": 4 },
        { "type": "text", "text": targetMin + " - " + targetMax + " s", "color": "#1E293B", "weight": "bold", "size": "xs", "align": "end", "flex": 6 }
      ]
    },
    {
      "type": "box",
      "layout": "horizontal",
      "margin": "xs",
      "contents": [
        { "type": "text", "text": "👑 ฝั่งชนะ:", "color": "#64748B", "size": "xs", "flex": 4 },
        { "type": "text", "text": outcomeTitle, "color": outcomeColor, "weight": "bold", "size": "xs", "align": "end", "flex": 6 }
      ]
    }
  ];

  if (rocketName) {
    bodyContents.push({
      "type": "box",
      "layout": "horizontal",
      "margin": "xs",
      "contents": [
        { "type": "text", "text": "🚀 บั้งไฟ:", "color": "#64748B", "size": "xs", "flex": 4 },
        { "type": "text", "text": rocketName, "color": "#334155", "weight": "bold", "size": "xs", "align": "end", "flex": 6 }
      ]
    });
  }

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#1E1B4B",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "🏆 ประกาศผลสรุปดวล",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "sm",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "md",
      "contents": bodyContents
    }
  };
}

function constructBankingFlex(type, amount, accountDetails, targetUrl, userId) {
  var formattedAmount = "";
  try {
    var parsedAmount = parseFloat(amount.toString().replace(/,/g, ''));
    if (!isNaN(parsedAmount)) {
      formattedAmount = parsedAmount.toLocaleString('th-TH', { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2 
      });
    } else {
      formattedAmount = amount.toString();
    }
  } catch (e) {
    formattedAmount = amount.toString();
  }

  var now = new Date();
  var dateStr = Utilities.formatDate(now, "GMT+7", "dd/MM/yyyy HH:mm:ss");

  var isIncome = (type === "Income" || type === "deposit" || type === "เงินเข้า" || type === "ฝากเงิน");
  var headerBgColor = isIncome ? "#10B981" : "#F43F5E"; 
  var badgeText = isIncome ? "เงินเข้า" : "เงินออก";
  var amountText = (isIncome ? "+" : "-") + formattedAmount + " บาท";

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💳 " + badgeText + ": " + amountText,
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center"
        }
      ],
      "backgroundColor": headerBgColor,
      "paddingAll": "sm"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "contents": [
        { "type": "text", "text": accountDetails, "size": "xxs", "color": "#334155", "wrap": true },
        { "type": "text", "text": "🕒 " + dateStr, "size": "xxs", "color": "#94A3B8" }
      ],
      "paddingAll": "sm"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": headerBgColor,
          "action": {
            "type": "message",
            "label": "🏠 เมนูหลัก",
            "text": "เมนู"
          }
        }
      ],
      "paddingAll": "sm"
    }
  };
}

// =========================================================================
// LINE OA VIRTUAL CHAT CONTROLLER & LOGGING
// =========================================================================

function logLineChatMessage(userId, displayName, sender, messageText, messageType) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName('LineChatLogs');
    if (!sheet) {
      sheet = ss.insertSheet('LineChatLogs');
      sheet.appendRow(['Timestamp', 'User ID', 'Display Name', 'Sender', 'Message Text', 'Message Type']);
    }
    
    let actualDisplayName = displayName;
    if (sender === 'admin' || sender === 'bot') {
      actualDisplayName = getPlayerNameFromDb(userId) || displayName;
    }
    
    sheet.appendRow([new Date(), userId, actualDisplayName, sender, messageText, messageType || 'text']);
  } catch (err) {
    console.error("Error logging LINE chat message: " + err.toString());
  }
}

function getPlayerNameFromDb(userId) {
  if (!userId) return null;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Players');
    if (!sheet) return null;
    const data = sheet.getDataRange().getValues();
    const searchId = userId.toString().trim();
    for (let i = 1; i < data.length; i++) {
      const rowId = data[i][0] ? data[i][0].toString().trim() : '';
      const rowLineId = data[i][7] ? data[i][7].toString().trim() : '';
      if (rowId === searchId || rowLineId === searchId) {
        return data[i][1] ? data[i][1].toString() : '';
      }
    }
  } catch (e) {
    console.error("Error in getPlayerNameFromDb: " + e.toString());
  }
  return null;
}

function getLineChatLogs() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('LineChatLogs');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const logs = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      logs.push({
        timestamp: row[0] ? Utilities.formatDate(new Date(row[0]), "GMT+7", "HH:mm:ss") : '',
        userId: row[1] ? row[1].toString() : '',
        displayName: row[2] ? row[2].toString() : '',
        sender: row[3] ? row[3].toString() : '',
        text: row[4] ? row[4].toString() : '',
        type: row[5] ? row[5].toString() : 'text'
      });
    }
    return logs;
  } catch (err) {
    console.error("Error fetching LINE chat logs: " + err.toString());
    return [];
  }
}

// ============================================================
// Admin Hotkey Broadcast Wrappers (GAS-side Flex constructors)
// These are called directly from frontend via window.google.script.run
// to avoid sending large Flex objects through the GAS bridge.
// ============================================================

/**
 * Manually set the active group ID from the admin portal.
 * This is the fallback for when the bot hasn't received any webhook yet.
 */
function adminSetActiveGroupId(groupId) {
  if (!groupId || typeof groupId !== 'string' || groupId.trim().length < 5) {
    return { success: false, error: 'Invalid group ID' };
  }
  var gid = groupId.trim();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ACTIVE_GROUP_ID', gid);
  recordGroupActivity(gid, null, null, null, 'Set manually by Admin');
  Logger.log('[adminSetActiveGroupId] Set ACTIVE_GROUP_ID = ' + gid);
  return { success: true, groupId: gid };
}

/**
 * Scan all sheets to discover known group IDs.
 * Returns { activeGroupId, lineGroups, discovered } for the frontend to display.
 */
function adminDiscoverGroupIds() {
  var props = PropertiesService.getScriptProperties();
  var activeId = props.getProperty('ACTIVE_GROUP_ID') || '';
  var lineGroupsJson = props.getProperty('LINE_GROUPS') || '[]';
  var discovered = {};

  // From ScriptProperties
  if (activeId) discovered[activeId] = 'ScriptProperty';

  // From LINE_GROUPS
  try {
    var groups = JSON.parse(lineGroupsJson);
    groups.forEach(function(g) { if (g.id) discovered[g.id] = g.name || 'กลุ่มที่รู้จัก'; });
  } catch(e) {}

  // Scan Bets sheet col 12 (targetGroupId)
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var bSheet = ss.getSheetByName('Bets');
    if (bSheet) {
      var bData = bSheet.getDataRange().getValues();
      for (var bi = 1; bi < bData.length; bi++) {
        var gv = (bData[bi][12] || '').toString().trim();
        if (gv && gv.length > 5 && !discovered[gv]) discovered[gv] = 'จาก Bets sheet';
      }
    }
    // Scan LineChatLogs sheet (userId col may contain group IDs starting with C/R)
    var cSheet = ss.getSheetByName('LineChatLogs');
    if (cSheet) {
      var cData = cSheet.getDataRange().getValues();
      for (var ci = 1; ci < cData.length; ci++) {
        var uid = (cData[ci][1] || '').toString().trim();
        if (uid && (uid.startsWith('C') || uid.startsWith('R')) && uid.length > 10 && !discovered[uid]) {
          discovered[uid] = 'จาก LineChatLogs';
        }
      }
    }
  } catch(e) {
    Logger.log('[adminDiscoverGroupIds] Error: ' + e.toString());
  }

  var discoveredList = Object.keys(discovered).map(function(id) {
    return { id: id, source: discovered[id] };
  });

  Logger.log('[adminDiscoverGroupIds] Found: ' + JSON.stringify(discoveredList));
  return {
    activeGroupId: activeId,
    lineGroups: JSON.parse(lineGroupsJson),
    discovered: discoveredList
  };
}

function adminBroadcastQuote(targetId, name, minVal, maxVal, isChotoy) {
  var quoteFlex = {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#BAE6FD",
      "paddingAll": "md",
      "contents": [
        { "type": "text", "text": "\uD83D\uDE80 ราคาช่างเปิด \u27A1 " + (name || 'ช่างบั้งไฟสด'), "weight": "bold", "color": "#0369A1", "size": "sm", "align": "center", "wrap": true }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#F0F9FF",
      "spacing": "sm",
      "paddingAll": "md",
      "contents": [
        { "type": "text", "text": "\u23F1\uFE0F ช่วงราคา: " + minVal + "-" + maxVal + " วิ" + (isChotoy ? " (ชตย)" : ""), "weight": "bold", "color": "#0284C7", "size": "sm", "align": "center", "wrap": true },
        { "type": "text", "text": "\u26A1 พิมพ์ ชล / ชถ (\u00B15, \u00B110) ได้ทันที", "color": "#64748B", "size": "xs", "align": "center", "wrap": true }
      ]
    }
  };
  adminOpenRound(name);
  setTargetMinMax(Number(minVal), Number(maxVal));
  return sendAdminMessageToLine(targetId || 'ALL', quoteFlex);
}

function adminBroadcastFinalCall(targetId) {
  setRocketRoundStatus('CLOSED');
  var closeFlex = {
    "type": "bubble",
    "size": "kilo",
    "header": { "type": "box", "layout": "vertical", "backgroundColor": "#FECDD3", "paddingAll": "md", "contents": [
      { "type": "text", "text": "⛔ FINAL CALL · ปิดรับดวล", "weight": "bold", "color": "#9F1239", "size": "sm", "align": "center", "wrap": true }
    ]},
    "body": { "type": "box", "layout": "vertical", "backgroundColor": "#FFF1F2", "spacing": "xs", "paddingAll": "md", "contents": [
      { "type": "text", "text": "⛔ ปิดรับเปิดราคาเองแล้วครับ (รอจับคู่แผลค้าง 🚀)", "color": "#BE123C", "size": "xs", "align": "center", "wrap": true }
    ]}
  };
  return sendAdminMessageToLine(targetId || 'ALL', closeFlex);
}

function adminBroadcastVoidRound(targetId) {
  adminVoidRound();
  var voidFlex = {
    "type": "bubble",
    "size": "kilo",
    "header": { "type": "box", "layout": "vertical", "backgroundColor": "#FECDD3", "paddingAll": "md", "contents": [
      { "type": "text", "text": "⛔ ช่าง ⛔ (โมฆะรอบ)", "weight": "bold", "color": "#9F1239", "size": "sm", "align": "center", "wrap": true }
    ]},
    "body": { "type": "box", "layout": "vertical", "backgroundColor": "#FFF1F2", "spacing": "xs", "paddingAll": "md", "contents": [
      { "type": "text", "text": "ยกเลิกและคืนแต้มทุกแผลดวล 100% เรียบร้อยครับ 🚀", "weight": "bold", "color": "#BE123C", "size": "xs", "align": "center", "wrap": true }
    ]}
  };
  return sendAdminMessageToLine(targetId || 'ALL', voidFlex);
}

function adminBroadcastRuleGuide(targetId) {
  var ruleGuideFlex = constructRuleGuideFlex();
  return sendAdminMessageToLine(targetId || 'ALL', ruleGuideFlex);
}

function adminBroadcastScamWarning(targetId) {
  var warnFlex = {
    "type": "bubble",
    "size": "kilo",
    "header": { "type": "box", "layout": "vertical", "backgroundColor": "#FDE68A", "paddingAll": "md", "contents": [
      { "type": "text", "text": "🚨 เตือนความปลอดภัย", "weight": "bold", "color": "#92400E", "size": "sm", "align": "center", "wrap": true }
    ]},
    "body": { "type": "box", "layout": "vertical", "backgroundColor": "#FEFCE8", "spacing": "xs", "paddingAll": "md", "contents": [
      { "type": "text", "text": "⚠️ ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA 1:1 เท่านั้นครับ", "weight": "bold", "color": "#B45309", "size": "xs", "align": "center", "wrap": true }
    ]}
  };
  return sendAdminMessageToLine(targetId || 'ALL', warnFlex);
}

// ============================================================

function sendAdminMessageToLine(targetId, messageText) {
  var isObj = (typeof messageText === 'object' && messageText !== null);
  var clean = isObj ? '' : (messageText || '').toString().replace(/\s+/g, '').toLowerCase();

  // Update round lock status automatically if broadcast contains explicit round open/close keywords
  var isExplicitCloseCmd = isObj 
    ? false 
    : (clean.indexOf('ปิดรับดวล') !== -1 || clean.indexOf('ปิดรอบ') === 0 || clean.indexOf('ล็อครอบ') === 0 || clean.indexOf('3-2-go') === 0);
  var isExplicitOpenCmd = isObj 
    ? false 
    : (clean.indexOf('เปิดรอบ') === 0 || clean.indexOf('เปิดรับดวล') === 0);

  if (isExplicitCloseCmd) {
    setRocketRoundStatus('CLOSED');
  } else if (isExplicitOpenCmd) {
    setRocketRoundStatus('ACTIVE');
  }

  var logMsg = isObj ? '[Flex Message]' : messageText;

  // ─── Broadcast to ALL active groups ───
  if (!targetId || targetId === 'ALL' || targetId === 'GROUP_STREAM') {
    var groups = getLineGroups();
    var activeId = getActiveGroupId();
    var targetIds = {};
    for (var gi = 0; gi < groups.length; gi++) {
      if (groups[gi].id) targetIds[groups[gi].id] = true;
    }
    if (activeId) targetIds[activeId] = true;

    // Fallback: scan Bets sheet for group IDs
    if (Object.keys(targetIds).length === 0) {
      try {
        var ss = SpreadsheetApp.openById(SHEET_ID);
        var bSheet = ss.getSheetByName('Bets');
        if (bSheet) {
          var bData = bSheet.getDataRange().getValues();
          for (var bi = 1; bi < bData.length; bi++) {
            var gVal = (bData[bi][12] && bData[bi][12].toString().trim()) || (bData[bi][7] && bData[bi][7].toString().trim());
            if (gVal && (gVal.startsWith('C') || gVal.startsWith('R') || gVal.startsWith('c') || gVal.startsWith('r'))) {
              targetIds[gVal] = true;
            }
          }
        }
      } catch (e) {
        Logger.log('[sendAdminMessageToLine] Bets fallback error: ' + e.toString());
      }
    }

    var keys = Object.keys(targetIds);
    if (keys.length === 0) {
      Logger.log('[sendAdminMessageToLine] No active groups found to broadcast. ACTIVE_GROUP_ID=' + getActiveGroupId());
      return { success: false, error: 'ไม่พบกลุ่ม LINE ที่เชื่อมต่อ — กรุณาใส่ Group ID ก่อนส่งครับ', targets: [] };
    }
    var sendResults = [];
    for (var k = 0; k < keys.length; k++) {
      var r = pushLineGroupMessage(keys[k], messageText);
      sendResults.push(r);
      logLineChatMessage(keys[k], 'กลุ่ม', 'admin', logMsg, isObj ? 'flex' : 'text');
    }
    return { success: true, count: keys.length, targets: keys, results: sendResults };
  }

  // ─── Single target: resolve payload if keyword ───
  var payload = messageText;
  if (!isObj) {
    if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
      var name = getPlayerNameFromDb(targetId) || "ผู้เล่น";
      var balance = getPlayerBalance(targetId, name);
      payload = constructBalanceFlex(name, balance);
    } else if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit') {
      payload = constructDepositFlex();
    } else if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
      var bank = getPlayerBank(targetId);
      if (bank) {
        var balW = getPlayerBalance(targetId, bank.accountName || "ผู้เล่น");
        payload = constructWithdrawalFlex(bank.bankName, bank.accountNumber, bank.accountName, balW);
      } else {
        payload = "❌ ผู้เล่นรายนี้ยังไม่ได้ลงทะเบียนบัญชีธนาคาร (กรุณาทำรายการฝากเงินเข้ามาก่อน)";
      }
    } else if (clean === 'เมนู' || clean === 'menu' || clean === 'เริ่ม' || clean === 'start') {
      payload = constructMainMenuFlex();
    }
  }

  // ─── Route by ID type ───
  // Group IDs start with 'C' or 'R', User IDs start with 'U'
  var isGroupTarget = typeof targetId === 'string' && (targetId.startsWith('C') || targetId.startsWith('R') || /^\d{10,}$/.test(targetId));
  var singleRes = null;
  if (isGroupTarget) {
    singleRes = pushLineGroupMessage(targetId, payload);
  } else {
    pushToLine(targetId, payload);
    singleRes = { success: true, targetId: targetId };
  }

  logLineChatMessage(targetId, isGroupTarget ? 'กลุ่ม' : 'ผู้เล่น', 'admin', logMsg, (typeof payload === 'object') ? 'flex' : 'text');
  return { success: true, count: 1, targets: [targetId], result: singleRes };
}



function constructRejectionFlex(type, amount, reason, currentBalance, userId) {
  var formattedAmount = "";
  try {
    var parsedAmount = parseFloat(amount.toString().replace(/,/g, ''));
    if (!isNaN(parsedAmount)) {
      formattedAmount = parsedAmount.toLocaleString('th-TH', { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2 
      });
    } else {
      formattedAmount = amount.toString();
    }
  } catch (e) {
    formattedAmount = amount.toString();
  }

  var isWithdrawal = (type === "WD" || type === "withdraw" || type === "ถอนเงิน");
  var title = isWithdrawal ? "ปฏิเสธถอนเงิน" : "ปฏิเสธฝากเงิน";

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "❌ " + title + " (" + formattedAmount + "B)",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs",
          "align": "center"
        }
      ],
      "backgroundColor": "#F43F5E",
      "paddingAll": "sm"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "contents": [
        { "type": "text", "text": "เหตุผล: " + (reason || "ข้อมูลไม่ถูกต้อง"), "size": "xxs", "color": "#E11D48", "wrap": true }
      ],
      "paddingAll": "sm"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": "#F43F5E",
          "action": {
            "type": "uri",
            "label": "📞 ติดต่อ 089-104-1992",
            "uri": "tel:0891041992"
          }
        }
      ],
      "paddingAll": "sm"
    }
  };
}

function constructMatchResultFlex(isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission, userId, rocketName, rangeInfo) {
  var isWin = !!isWinner;
  var headerBg = isWin ? "#10B981" : "#F43F5E";
  var headerTitle = isWin ? "🏆 ชนะ (" + finalTime + "s)" : "☄️ แพ้ (" + finalTime + "s)";
  var formattedAmt = isWin 
    ? "+" + Number(payout || (amount * 1.9)).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-" + Number(amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var amtColor = isWin ? "#059669" : "#E11D48";
  var dateStr = Utilities.formatDate(new Date(), "GMT+7", "dd MMM yy HH:mm");

  return {
    "type": "bubble",
    "size": "giga",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": headerBg,
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": headerTitle,
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md",
          "align": "center"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "lg",
      "contents": [
        {
          "type": "text",
          "text": "Order #" + orderNo,
          "color": "#94A3B8",
          "size": "xs",
          "align": "center"
        },
        {
          "type": "text",
          "text": formattedAmt,
          "weight": "bold",
          "color": amtColor,
          "size": "3xl",
          "align": "center",
          "margin": "xs"
        },
        {
          "type": "text",
          "text": dateStr,
          "color": "#94A3B8",
          "size": "xxs",
          "align": "center",
          "margin": "xs"
        },
        {
          "type": "separator",
          "margin": "md",
          "color": "#F1F5F9"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "md",
          "contents": [
            { "type": "text", "text": "ทีม", "color": "#94A3B8", "size": "xs", "flex": 4 },
            { "type": "text", "text": rocketName || "ช่างบั้งไฟสด", "weight": "bold", "color": "#334155", "size": "xs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "ราคาช่าง", "color": "#94A3B8", "size": "xs", "flex": 4 },
            { "type": "text", "text": rangeInfo ? (rangeInfo + "s") : "รอราคาช่าง", "weight": "bold", "color": "#334155", "size": "xs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "คงเหลือ", "color": "#94A3B8", "size": "xs", "flex": 4 },
            { "type": "text", "text": Number(currentBalance || 0).toLocaleString('th-TH') + " pt", "weight": "bold", "color": "#10B981", "size": "xs", "flex": 6, "align": "end" }
          ]
        }
      ]
    }
  };
}

function constructOpenRoundQuoteFlex(name, min, max, isChotoy) {
  var roundName = name || 'บั้งไฟสด';
  var minVal = min || 330;
  var maxVal = max || 380;

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#BAE6FD",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "🚀 ราคาช่างเปิด ➔ " + roundName,
          "weight": "bold",
          "color": "#0369A1",
          "size": "sm",
          "align": "center",
          "wrap": true
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#F0F9FF",
      "spacing": "sm",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "⏱️ ช่วงราคา: " + minVal + "-" + maxVal + " วิ" + (isChotoy ? ' (ชตย)' : ''),
          "weight": "bold",
          "color": "#0284C7",
          "size": "sm",
          "align": "center",
          "wrap": true
        },
        {
          "type": "text",
          "text": "⚡ พิมพ์ ชล / ชถ (±5, ±10) ได้ทันที",
          "color": "#64748B",
          "size": "xs",
          "align": "center",
          "wrap": true
        }
      ]
    }
  };
}

function constructRoundCloseFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#FECDD3",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "⛔ FINAL CALL · ปิดรับดวล",
          "weight": "bold",
          "color": "#9F1239",
          "size": "sm",
          "align": "center",
          "wrap": true
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#FFF1F2",
      "spacing": "sm",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "⚠️ ปิดรับการเปิดราคาเองรอบนี้แล้วครับ",
          "weight": "bold",
          "color": "#BE123C",
          "size": "xs",
          "align": "center",
          "wrap": true
        },
        {
          "type": "text",
          "text": "(จับคู่เฉพาะแผลที่เปิดค้างอยู่เท่านั้น)",
          "color": "#64748B",
          "size": "xs",
          "align": "center",
          "wrap": true
        }
      ]
    }
  };
}

function constructVoidRoundFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#FECDD3",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "⛔ ช่าง ⛔ (โมฆะรอบ)",
          "weight": "bold",
          "color": "#9F1239",
          "size": "sm",
          "align": "center",
          "wrap": true
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#FFF1F2",
      "spacing": "sm",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "ยกเลิกและคืนแต้มทุกแผลดวล 100% เรียบร้อยครับ 🚀",
          "weight": "bold",
          "color": "#BE123C",
          "size": "xs",
          "align": "center",
          "wrap": true
        }
      ]
    }
  };
}

function constructSecurityWarningFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#FDE68A",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "🚨 เตือนความปลอดภัย",
          "weight": "bold",
          "color": "#92400E",
          "size": "sm",
          "align": "center",
          "wrap": true
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#FEFCE8",
      "spacing": "sm",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA 1-on-1 เท่านั้นครับ ห้ามโอนเงินผ่านแชตกลุ่มเด็ดขาด ❌",
          "weight": "bold",
          "color": "#B45309",
          "size": "xs",
          "align": "center",
          "wrap": true
        }
      ]
    }
  };
}

// =========================================================================
// ROUND STATUS — Persisted in ScriptProperties (survives across GAS invocations)
// =========================================================================

/**
 * Persist round open/close status across stateless GAS webhook invocations.
 * Uses ScriptProperties so the state survives between separate HTTP requests.
 * @param {'ACTIVE'|'CLOSED'} status
 */
function setRocketRoundStatus(status) {
  PropertiesService.getScriptProperties().setProperty('ROUND_STATUS', status);
  Logger.log('[ROUND] Status set to: ' + status);
}

/**
 * Returns true if the admin has locked the current round (no more custom-range bets).
 * Reads from ScriptProperties — consistent across concurrent webhook invocations.
 * @returns {boolean}
 */
function isRocketRoundClosed() {
  var status = PropertiesService.getScriptProperties().getProperty('ROUND_STATUS');
  return status === 'CLOSED';
}

/**
 * Returns active round metadata.
 * @returns {{ name: string, status: string }}
 */
function getActiveRocketRound() {
  var status = PropertiesService.getScriptProperties().getProperty('ROUND_STATUS') || 'ACTIVE';
  return { name: 'ทั่วไป', status: status };
}

/**
 * Set the active target min/max range in script properties.
 */
function setTargetMinMax(minVal, maxVal) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('TARGET_MIN', String(minVal));
  props.setProperty('TARGET_MAX', String(maxVal));
  Logger.log('[ROUND] Target range set: ' + minVal + '-' + maxVal);
}

/**
 * Fetch real-time LINE OA message quota and monthly consumption status
 */
function adminGetLineQuota() {
  try {
    var headers = { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN };
    var qRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota', { headers: headers, muteHttpExceptions: true });
    var cRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: headers, muteHttpExceptions: true });
    var quotaJson = JSON.parse(qRes.getContentText());
    var consJson = JSON.parse(cRes.getContentText());
    var totalLimit = quotaJson.value || 0;
    var used = consJson.totalUsage || 0;
    return {
      type: quotaJson.type || 'limited',
      limit: totalLimit,
      totalUsage: used,
      remaining: Math.max(0, totalLimit - used),
      isExhausted: totalLimit > 0 && used >= totalLimit
    };
  } catch (e) {
    Logger.log('[adminGetLineQuota] Error: ' + e.toString());
    return { error: e.toString() };
  }
}
