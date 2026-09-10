// =========================================================================
// GOOGLE APPS SCRIPT WEBHOOK, TELEMETRY & DB CONTROLLER (Code.gs)
// Project: Rocket Science Billing & Telemetry System
// =========================================================================

// Secrets live in Script Properties (Project Settings → Script properties).
// Required keys: LINE_CHANNEL_ACCESS_TOKEN, SLIP_API_KEY, ADMIN_API_KEY
// Optional: LINE_CHANNEL_SECRET, ALLOW_LINE_WEBHOOK (=true only if GAS is the LINE webhook)
function getScriptSecret_(key) {
  var props = PropertiesService.getScriptProperties();
  return (props.getProperty(key) || '').toString();
}

function getLineToken_() {
  return getScriptSecret_('LINE_CHANNEL_ACCESS_TOKEN');
}

function getSlipApiKey_() {
  return getScriptSecret_('SLIP_API_KEY');
}

function getAdminApiKey_() {
  return getScriptSecret_('ADMIN_API_KEY');
}

const SLIP_API_URL = 'https://connect.slip2go.com/api/verify-slip/qr-base64/info';
let SHEET_ID = '1NaQbaUz8fcgd32sCAfxxKNBnpmFA5vu0_YVSehhdCEQ';
try {
  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (activeSpreadsheet) {
    SHEET_ID = activeSpreadsheet.getId();
  }
} catch (err) {
  console.warn("Using default SPREADSHEET_ID: " + SHEET_ID);
}

/** One-time helper: run from GAS editor after clasp push to load secrets into Script Properties */
function bootstrapScriptSecrets(lineToken, slipKey, adminKey, lineSecret) {
  var props = PropertiesService.getScriptProperties();
  if (lineToken) props.setProperty('LINE_CHANNEL_ACCESS_TOKEN', String(lineToken));
  if (slipKey) props.setProperty('SLIP_API_KEY', String(slipKey));
  if (adminKey) props.setProperty('ADMIN_API_KEY', String(adminKey));
  if (lineSecret) props.setProperty('LINE_CHANNEL_SECRET', String(lineSecret));
  props.setProperty('ALLOW_LINE_WEBHOOK', 'false'); // Node is the single LINE writer
  return { ok: true, keys: Object.keys(props.getProperties()) };
}

function assertAdminApiKey_(provided) {
  var expected = getAdminApiKey_();
  if (!expected) {
    throw new Error('ADMIN_API_KEY Script Property is not configured');
  }
  if (String(provided || '') !== expected) {
    throw new Error('Unauthorized');
  }
}

var _memGroupNameCache = {};
var _memChatLogSheet = null;

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
    var lSheet = ss.getSheetByName('LineChatLogs');
    if (lSheet) {
      var lData = lSheet.getDataRange().getValues();
      for (var li = lData.length - 1; li >= 1; li--) {
        var uVal = (lData[li][1] || '').toString().trim();
        if ((uVal.startsWith('C') || uVal.startsWith('R')) && uVal.length >= 15) {
          props.setProperty('ACTIVE_GROUP_ID', uVal);
          recordGroupActivity(uVal, null, null, null, 'Discovered from LineChatLogs');
          return uVal;
        }
      }
    }
  } catch (e) {
    Logger.log('[getActiveGroupId Fallback Error]: ' + e);
  }

  // 4. Fallback default active test group
  var hardcodedActive = 'Ccec6199403ca536e46079e37db1a1387';
  props.setProperty('ACTIVE_GROUP_ID', hardcodedActive);
  return hardcodedActive;
}

function setActiveGroupId(groupId) {
  if (!groupId || typeof groupId !== 'string') return;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ACTIVE_GROUP_ID', groupId.trim());
  if (groupId.trim().length > 5) {
    recordGroupActivity(groupId.trim(), null, null, null, 'เชื่อมต่อแล้ว');
  }
}

/**
 * Fetch real Group or Room name from LINE Messaging API with double-layer caching (Memory + CacheService)
 * @param {string} groupId 
 * @returns {string}
 */
function fetchLINEGroupName(groupId) {
  if (!groupId || typeof groupId !== 'string') return '';
  var gid = groupId.trim();
  if (!gid.startsWith('C') && !gid.startsWith('c') && !gid.startsWith('R') && !gid.startsWith('r')) return '';
  
  if (_memGroupNameCache[gid]) {
    return _memGroupNameCache[gid];
  }

  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get('GRP_NAME_' + gid);
    if (cached) {
      _memGroupNameCache[gid] = cached;
      return cached;
    }
  } catch(_) {}

  try {
    var endpoint = (gid.startsWith('R') || gid.startsWith('r'))
      ? ('https://api.line.me/v2/bot/room/' + gid + '/summary')
      : ('https://api.line.me/v2/bot/group/' + gid + '/summary');
    var response = UrlFetchApp.fetch(endpoint, {
      headers: {
        'Authorization': 'Bearer ' + getLineToken_()
      },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
      var data = JSON.parse(response.getContentText());
      if (data && data.groupName) {
        var resName = data.groupName.trim();
        _memGroupNameCache[gid] = resName;
        try { cache.put('GRP_NAME_' + gid, resName, 86400); } catch(_) {}
        return resName;
      }
    }
  } catch (e) {
    Logger.log('[fetchLINEGroupName Error for ' + gid + ']: ' + e);
  }

  // Persist clean fallback so we NEVER make repeated failed HTTP calls
  var fallback = 'ห้องดวลสด #' + gid.slice(-4);
  _memGroupNameCache[gid] = fallback;
  try { cache.put('GRP_NAME_' + gid, fallback, 86400); } catch(_) {}
  return fallback;
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

  // If group exists with a valid name, reuse it immediately without hitting LINE API
  if (!cleanName && group && group.name && !group.name.startsWith('C') && !group.name.startsWith('R') && group.name.indexOf(gid) === -1 && group.name.indexOf('กลุ่มดวลสด') === -1) {
    cleanName = group.name;
  }

  // If still no valid name, fetch/cached lookup
  if (!cleanName || cleanName.startsWith('C') || cleanName.startsWith('R') || cleanName.indexOf(gid) !== -1 || cleanName.indexOf('กลุ่มดวลสด') !== -1) {
    cleanName = fetchLINEGroupName(gid) || ('ห้องดวลสด #' + gid.slice(-4));
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
    group.name = cleanName;
    group.lastMessage = text || group.lastMessage;
    group.timestamp = nowStr;
    group.msgCount = (group.msgCount || 0) + 1;
  }

  props.setProperty('LINE_GROUPS', JSON.stringify(groups));

  // High-Speed: Persist to LineGroups sheet ONLY if newly discovered or every 10 minutes (throttled)
  // This eliminates 500-800ms of synchronous Google Sheets I/O on every group chat message!
  try {
    var cache = CacheService.getScriptCache();
    var lastSyncKey = 'LG_SYNC_' + gid;
    var needsSync = (groupIdx === -1) || !cache.get(lastSyncKey);
    if (needsSync) {
      cache.put(lastSyncKey, '1', 600); // 10 minutes throttle
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
        lgSheet.appendRow([gid, cleanName, now, group.msgCount, (text || '').substring(0, 100)]);
      }
    }
  } catch (sheetErr) {
    Logger.log('[recordGroupActivity] Sheet backup error: ' + sheetErr.toString());
  }
}

var _memLineGroups = null;

function getLineGroups() {
  if (_memLineGroups) return _memLineGroups;
  var props = PropertiesService.getScriptProperties();
  var groupsJson = props.getProperty('LINE_GROUPS') || '[]';
  var list = [];
  try {
    list = JSON.parse(groupsJson);
  } catch (e) {}

  var updatedNames = false;

  // Resolve real names for any placeholder group entries
  if (Array.isArray(list) && list.length > 0) {
    for (var i = 0; i < list.length; i++) {
      var gId = list[i].id;
      if (!list[i].name || list[i].name.indexOf('กลุ่มดวลสด') !== -1 || list[i].name.startsWith('C')) {
        var realGroupName = fetchLINEGroupName(gId);
        if (realGroupName) {
          list[i].name = realGroupName;
          updatedNames = true;
        } else {
          // Assign clean static name so it NEVER triggers another 404 HTTP request
          list[i].name = 'ห้องดวลสด #' + gId.slice(-4);
          updatedNames = true;
        }
      }
    }
    if (updatedNames) {
      props.setProperty('LINE_GROUPS', JSON.stringify(list));
    }
    _memLineGroups = list;
    return list;
  }

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
          var resolvedName = gName;
          if (!resolvedName || resolvedName.indexOf('กลุ่มดวลสด') !== -1 || resolvedName.startsWith('C')) {
            var apiName = fetchLINEGroupName(gId);
            if (apiName) {
              resolvedName = apiName;
            } else {
              resolvedName = 'ห้องดวลสด #' + gId.slice(-4);
            }
            try { lgSheet.getRange(r + 1, 2).setValue(resolvedName); } catch(_) {}
          }
          list.push({
            id: gId,
            name: resolvedName || ('ห้องดวลสด #' + gId.slice(-4)),
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
    var activeRealName = fetchLINEGroupName(activeId);
    var fallbackList = [{
      id: activeId,
      name: activeRealName || ('🚀 กลุ่มดวลสด #' + activeId.slice(-4)),
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
  var activeRound = getActiveRocketRound();
  var minVal = activeRound.targetMin || 330;
  var maxVal = activeRound.targetMax || 380;
  if (rSheet) {
    var rData = rSheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < rData.length; i++) {
      if (rData[i][0] === name) {
        rSheet.getRange(i + 1, 2).setValue(minVal);
        rSheet.getRange(i + 1, 3).setValue(maxVal);
        rSheet.getRange(i + 1, 4).setValue('ACTIVE');
        found = true;
      } else if (rData[i][3] === 'ACTIVE') {
        rSheet.getRange(i + 1, 4).setValue('LOCKED');
      }
    }
    if (!found) {
      rSheet.appendRow([name, minVal, maxVal, 'ACTIVE']);
    }
  }
  setRocketRoundStatus('ACTIVE');
  return getDashboardData();
}

/**
 * HTTP GET: Serves the bundled React Admin & Simulator UI, or JSON API for external clients.
 */
function doGet(e) {
  // Read-only JSON API for external clients (mutations must use authenticated POST / google.script.run)
  if (e && e.parameter && (e.parameter.action === 'getDashboardData' || e.parameter.api === '1')) {
    var data = getDashboardData();
    return ContentService.createTextOutput(JSON.stringify({ success: true, data: data }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e && e.parameter && e.parameter.action) {
    // Block unauthenticated mutating GET actions (legacy dual-writer path)
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Mutating GET actions are disabled. Use the Node backend or authenticated google.script.run.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

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

function invalidateDashboardCache() {
  try {
    CacheService.getScriptCache().remove('DASHBOARD_DATA_CACHE');
  } catch(_) {}
}

/**
 * Universal Action Dispatcher for Admin RPC functions.
 */
function executeAdminAction(functionName, args) {
  args = args || [];
  var result;
  switch (functionName) {
    case 'getDashboardData': return getDashboardData(args[0]);
    case 'adminApproveTransaction': 
      invalidateDashboardCache();
      return adminApproveTransaction(args[0]);
    case 'adminRejectTransaction': 
      invalidateDashboardCache();
      return adminRejectTransaction(args[0], args[1]);
    case 'adminResolveBets': 
      invalidateDashboardCache();
      return adminResolveBets(args[0], args[1], args[2]);
    case 'adminVoidRound': 
      invalidateDashboardCache();
      return adminVoidRound();
    case 'adminRequestCancelBet': 
      invalidateDashboardCache();
      return adminRequestCancelBet(args[0]);
    case 'adminSetPlayerBank': 
      invalidateDashboardCache();
      return adminSetPlayerBank(args[0], args[1], args[2], args[3]);
    case 'adminCreatePlayer': 
      invalidateDashboardCache();
      return adminCreatePlayer(args[0], args[1], args[2]);
    case 'adminUpdatePlayerName': 
      invalidateDashboardCache();
      return adminUpdatePlayerName(args[0], args[1]);
    case 'adminSetPlayerBalance': 
      invalidateDashboardCache();
      return adminSetPlayerBalance(args[0], args[1]);
    case 'adminDeletePlayer': 
      invalidateDashboardCache();
      return adminDeletePlayer(args[0]);
    case 'saveOpenBet': 
      invalidateDashboardCache();
      return saveOpenBet(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9]);
    case 'verifyMockSlipFromClient': 
      invalidateDashboardCache();
      return verifyMockSlipFromClient(args[0], args[1], args[2], args[3], args[4]);
    case 'resetGoogleSheetsDatabase': 
      invalidateDashboardCache();
      return resetGoogleSheetsDatabase();
    case 'sendAdminMessageToLine': return sendAdminMessageToLine(args[0], args[1]);
    case 'adminOpenRound': 
      invalidateDashboardCache();
      return adminOpenRound(args[0]);
    case 'adminBroadcastQuote': return adminBroadcastQuote(args[0], args[1], args[2], args[3], args[4]);
    case 'adminBroadcastFinalCall': return adminBroadcastFinalCall(args[0]);
    case 'adminBroadcastVoidRound': return adminBroadcastVoidRound(args[0]);
    case 'adminBroadcastRuleGuide': return adminBroadcastRuleGuide(args[0]);
    case 'adminBroadcastScamWarning': return adminBroadcastScamWarning(args[0]);
    case 'adminSetActiveGroupId': return adminSetActiveGroupId(args[0]);
    case 'adminDiscoverGroupIds': return adminDiscoverGroupIds();
    case 'adminTestPushGroupMessage': return adminTestPushGroupMessage(args[0]);
    default: return { error: 'Unknown function: ' + functionName };
  }
}

/**
 * HTTP POST: LINE OA Webhook endpoint & External API endpoint.
 */
function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents);
    
    // External / Pages API — require ADMIN_API_KEY (Node is preferred single writer)
    if (postData.functionName || postData.action) {
      try {
        assertAdminApiKey_(postData.apiKey || (e.parameter && e.parameter.apiKey));
      } catch (authErr) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: authErr.message }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const fn = postData.functionName || postData.action;
      const args = postData.args || [];
      const res = executeAdminAction(fn, args);
      return ContentService.createTextOutput(JSON.stringify({ success: true, data: res }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // LINE webhook on GAS is disabled by default (Node owns LINE + sheet writes)
    var allowLine = getScriptSecret_('ALLOW_LINE_WEBHOOK') === 'true';
    if (!allowLine) {
      console.warn('LINE webhook hit GAS but ALLOW_LINE_WEBHOOK!=true — ignored (use Node /webhook)');
      return ContentService.createTextOutput(JSON.stringify({ status: 'ignored', reason: 'line_webhook_disabled_on_gas' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const events = postData.events || [];
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
          handleTextMessage(message.text, userId, displayName, replyToken, groupId, message.id);
          // High-Speed: Deferred logging executed AFTER reply was dispatched to ensure sub-second response in LINE
          logLineChatMessage(userId, displayName, 'player', message.text, 'text');
        } else if (message.type === 'image') {
          handleImageSlipMessage(message.id, userId, displayName, replyToken);
        }
      } else if (event.type === 'unsend') {
        const unsendMessageId = event.unsend ? event.unsend.messageId : null;
        const groupId = event.source.groupId || event.source.roomId || null;
        handleUnsendMessage(unsendMessageId, userId, displayName, groupId);
      } else if (event.type === 'messageEdited') {
        const editMessageId = event.message ? event.message.id : null;
        const newText = event.message ? event.message.text : '';
        const groupId = event.source.groupId || event.source.roomId || null;
        handleMessageEdited(editMessageId, newText, userId, displayName, groupId, replyToken);
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

var _memUserCache = {};
var _memRawLineCache = {};

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
  
  if (_memUserCache[searchId]) {
    return _memUserCache[searchId];
  }
  
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get('SHORT_ID_' + searchId);
    if (cached) {
      _memUserCache[searchId] = cached;
      return cached;
    }
  } catch(_) {}
  
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  
  // Check column 7 (LINE User ID)
  for (let i = 1; i < data.length; i++) {
    const rowLineId = data[i][7] ? data[i][7].toString().trim() : '';
    if (rowLineId === searchId) {
      var foundShort = data[i][0] ? data[i][0].toString().trim() : '';
      if (foundShort) {
        _memUserCache[searchId] = foundShort;
        try { cache.put('SHORT_ID_' + searchId, foundShort, 21600); } catch(_) {}
        return foundShort;
      }
    }
  }
  
  // Check column 0 (User ID) for legacy registrations
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      sheet.getRange(i + 1, 8).setValue(searchId);
      _memUserCache[searchId] = rowId;
      try { cache.put('SHORT_ID_' + searchId, rowId, 21600); } catch(_) {}
      return rowId;
    }
  }
  
  // Register new player with generated short ID
  const shortId = generatePassportStyleId(sheet);
  sheet.appendRow([shortId, displayName || 'ผู้เล่น LINE', 0, new Date(), '', '', '', searchId]);
  _memUserCache[searchId] = shortId;
  try { cache.put('SHORT_ID_' + searchId, shortId, 21600); } catch(_) {}
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
  
  if (_memRawLineCache[searchId]) {
    return _memRawLineCache[searchId];
  }
  
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get('RAW_LINE_ID_' + searchId);
    if (cached) {
      _memRawLineCache[searchId] = cached;
      return cached;
    }
  } catch(_) {}
  
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      const rawLineId = data[i][7] ? data[i][7].toString().trim() : '';
      const finalId = rawLineId || searchId;
      _memRawLineCache[searchId] = finalId;
      try { cache.put('RAW_LINE_ID_' + searchId, finalId, 21600); } catch(_) {}
      return finalId;
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

function getPendingBetsList() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Bets');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const list = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[9] === 'pending_match') {
        list.push({
          orderNumber: row[0].toString(),
          playerLowId: row[1] ? row[1].toString() : '',
          playerLowName: row[2] ? row[2].toString() : '',
          playerHighId: row[3] ? row[3].toString() : '',
          playerHighName: row[4] ? row[4].toString() : '',
          amount: Number(row[5]) || 0,
          type: row[6] || 'range',
          rangeMin: row[7] ? Number(row[7]) : null,
          rangeMax: row[8] ? Number(row[8]) : null,
          status: row[9],
          timestamp: row[11],
          targetGroupId: row[12] || ''
        });
      }
    }
    return list;
  } catch (err) {
    Logger.log('[getPendingBetsList] Error: ' + err.toString());
    return [];
  }
}

/**
 * Helper to request bet cancellation or direct cancel.
 */
function handleCancelBetRequest(userId, orderNo, displayName) {
  var searchId = cleanUserId(userId);
  if (!searchId) return "🚫 ไม่สามารถทำรายการยกเลิกได้ครับ";
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  const data = sheet.getDataRange().getValues();
  const searchOrder = orderNo ? orderNo.toString().trim().replace(/#/g, '') : null;
  
  // If specific order number was requested
  if (searchOrder) {
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const curOrderNo = row[0].toString().trim();
      if (curOrderNo === searchOrder || curOrderNo.endsWith(searchOrder)) {
        const status = row[9];
        const playerLowId = row[1] ? row[1].toString().trim() : '';
        const playerLowName = row[2] ? row[2].toString().trim() : '';
        const playerHighId = row[3] ? row[3].toString().trim() : '';
        const playerHighName = row[4] ? row[4].toString().trim() : '';
        const amount = Number(row[5]) || 0;
        
        const creatorId = playerLowId ? cleanUserId(playerLowId) : cleanUserId(playerHighId);
        const creatorName = playerLowId ? playerLowName : (playerHighName || displayName || 'ผู้เล่น');
        
        const isCreator = (creatorId === searchId || creatorId === cleanUserId(userId) || 
                           playerLowId === searchId || playerHighId === searchId ||
                           (displayName && (playerLowName === displayName || playerHighName === displayName)));
        if (!isCreator && searchId !== 'admin') {
          return "🚫 ขออภัยครับ แผลดวลนี้ไม่ใช่แผลของคุณ";
        }
        
        if (status === 'matched' || status === 'pending_cancel') {
          return "⚠️ ไม่สามารถยกเลิกได้ครับ แผล Order #" + curOrderNo + " มีคู่ดวลแมตช์แล้ว (กติกาไม่อนุญาตให้ยกเลิกแผลที่แมตช์แล้วทุกกรณีครับ 🚀)";
        }

        if (status === 'resolved' || status === 'cancelled' || status === 'void') {
          return "⚠️ แผลดวล Order #" + curOrderNo + " จบหรือถูกยกเลิกแล้วครับ";
        }
        
        if (status === 'pending_match') {
          // Direct cancel
          sheet.getRange(i + 1, 10).setValue('cancelled');
          // Refund credit to the creator
          adjustPlayerBalance(creatorId || searchId, amount, creatorName);
          var targetGroupId = (row[12] && row[12].toString().trim()) || (row[7] && row[7].toString().trim()) || getActiveGroupId();
          return {
            success: true,
            flex: constructCancelOrderMiniFlex(curOrderNo),
            orderNo: curOrderNo,
            targetGroupId: targetGroupId
          };
        }
      }
    }
    return "🚫 ไม่พบแผลดวล Order #" + searchOrder + " ในระบบครับ";
  }

  // If no order number was specified (user typed "ยกเลิก"):
  // Pass 1: Look for user's pending_match bet to cancel
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const curOrderNo = row[0].toString().trim();
    const status = row[9];
    const playerLowId = row[1] ? row[1].toString().trim() : '';
    const playerLowName = row[2] ? row[2].toString().trim() : '';
    const playerHighId = row[3] ? row[3].toString().trim() : '';
    const playerHighName = row[4] ? row[4].toString().trim() : '';
    const amount = Number(row[5]) || 0;
    
    const creatorId = playerLowId ? cleanUserId(playerLowId) : cleanUserId(playerHighId);
    const creatorName = playerLowId ? playerLowName : (playerHighName || displayName || 'ผู้เล่น');
    
    const isCreator = (creatorId === searchId || creatorId === cleanUserId(userId) || 
                       playerLowId === searchId || playerHighId === searchId ||
                       (displayName && (playerLowName === displayName || playerHighName === displayName)));
    if (!isCreator && searchId !== 'admin') continue;

    if (status === 'pending_match') {
      sheet.getRange(i + 1, 10).setValue('cancelled');
      adjustPlayerBalance(creatorId || searchId, amount, creatorName);
      var targetGroupId = (row[12] && row[12].toString().trim()) || (row[7] && row[7].toString().trim()) || getActiveGroupId();
      return {
        success: true,
        flex: constructCancelOrderMiniFlex(curOrderNo),
        orderNo: curOrderNo,
        targetGroupId: targetGroupId
      };
    }
  }

  // Pass 2: If no pending_match bet, check if user has a matched bet and explain strictly why it cannot be cancelled
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const curOrderNo = row[0].toString().trim();
    const status = row[9];
    const playerLowId = row[1] ? row[1].toString().trim() : '';
    const playerLowName = row[2] ? row[2].toString().trim() : '';
    const playerHighId = row[3] ? row[3].toString().trim() : '';
    const playerHighName = row[4] ? row[4].toString().trim() : '';
    
    const creatorId = playerLowId ? cleanUserId(playerLowId) : cleanUserId(playerHighId);
    const isCreator = (creatorId === searchId || creatorId === cleanUserId(userId) || 
                       playerLowId === searchId || playerHighId === searchId ||
                       (displayName && (playerLowName === displayName || playerHighName === displayName)));
    if (!isCreator && searchId !== 'admin') continue;

    if (status === 'matched' || status === 'pending_cancel') {
      return "⚠️ ไม่สามารถยกเลิกได้ครับ แผล Order #" + curOrderNo + " มีคู่ดวลแมตช์แล้ว (กติกาไม่อนุญาตให้ยกเลิกแผลที่แมตช์แล้วทุกกรณีครับ 🚀)";
    }
  }

  return "🚫 ไม่มีแผลที่เปิดรอคู่ในระบบครับ";
}

/**
 * Message Caching & Lookup Helpers using Google Apps Script CacheService
 */
function cacheLineMessage(messageId, text, userId, displayName, groupId) {
  if (!messageId) return;
  try {
    var cache = CacheService.getScriptCache();
    var data = JSON.stringify({
      text: text || '',
      userId: cleanUserId(userId),
      displayName: displayName || 'ผู้ใช้',
      groupId: groupId || '',
      time: Date.now()
    });
    cache.put('msg_' + messageId, data, 21600); // 6 hours
  } catch (e) {
    Logger.log('[cacheLineMessage] Exception: ' + e.toString());
  }
}

function linkOrderToMessage(messageId, orderNo) {
  if (!messageId || !orderNo) return;
  try {
    var cache = CacheService.getScriptCache();
    cache.put('msg_order_' + messageId, orderNo.toString(), 21600);
  } catch (e) {}
}

function getCachedMessage(messageId) {
  if (!messageId) return null;
  try {
    var cache = CacheService.getScriptCache();
    var raw = cache.get('msg_' + messageId);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function getOrderNoByMessageId(messageId) {
  if (!messageId) return null;
  try {
    var cache = CacheService.getScriptCache();
    var orderNo = cache.get('msg_order_' + messageId);
    if (orderNo) return orderNo;
  } catch (e) {}
  return null;
}

/**
 * Handle LINE unsend events:
 * Detects unsent message and broadcasts an alert to the group.
 * RULE: Unsend does NOT cancel or modify orders or records in any way!
 * Cancellation can ONLY be done via the interactive Flex Order Card.
 */
function handleUnsendMessage(unsendMessageId, userId, displayName, groupId) {
  var searchId = cleanUserId(userId);
  var cached = unsendMessageId ? getCachedMessage(unsendMessageId) : null;
  var orderNo = unsendMessageId ? getOrderNoByMessageId(unsendMessageId) : null;
  var originalText = cached ? cached.text : null;
  var targetGroupId = groupId || (cached ? cached.groupId : null);
  var effectiveDisplayName = displayName || (cached ? cached.displayName : null);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Bets');
  if (sheet && (!orderNo || !originalText)) {
    var data = sheet.getDataRange().getValues();
    var searchMsgId = unsendMessageId ? unsendMessageId.toString().trim() : '';
    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      var rowMsgId = row[13] ? row[13].toString().trim() : '';
      if (searchMsgId && rowMsgId === searchMsgId) {
        orderNo = row[0].toString().trim();
        originalText = originalText || ('Order #' + orderNo);
        if (!effectiveDisplayName) {
          effectiveDisplayName = row[2] || row[4] || 'ผู้เล่น';
        }
        if (!targetGroupId) {
          targetGroupId = row[12] ? row[12].toString().trim() : null;
        }
        break;
      }
    }
  }

  // Fallback: match by creator ID & group within last 15 minutes if not found yet
  if (!orderNo && searchId && sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      var pLowId = cleanUserId(row[1]);
      var pHighId = cleanUserId(row[3]);
      var pLowName = row[2] ? row[2].toString().trim() : '';
      var pHighName = row[4] ? row[4].toString().trim() : '';
      var isCreator = (pLowId === searchId || pHighId === searchId || 
                       (displayName && (pLowName === displayName || pHighName === displayName)));
      if (isCreator) {
        var rowTime = row[11] ? new Date(row[11]).getTime() : 0;
        if (Date.now() - rowTime < 15 * 60 * 1000) {
          orderNo = row[0].toString().trim();
          originalText = originalText || ('Order #' + orderNo);
          if (!targetGroupId) {
            targetGroupId = row[12] ? row[12].toString().trim() : null;
          }
          break;
        }
      }
    }
  }

  effectiveDisplayName = effectiveDisplayName || 'ผู้ใช้';
  targetGroupId = targetGroupId || getActiveGroupId();

  // RULE: Unsend does NOT cancel or modify orders in any way!
  var alertFlex = constructUnsendAlertFlex(effectiveDisplayName, originalText, orderNo);
  if (targetGroupId) {
    pushLineGroupMessage(targetGroupId, alertFlex);
  } else if (userId) {
    pushToLine(userId, alertFlex);
  }
}

// Backwards compatibility alias
function handleUnsendOrder(unsendMessageId, userId, displayName, groupId) {
  handleUnsendMessage(unsendMessageId, userId, displayName, groupId);
}

/**
 * Handle LINE messageEdited events:
 * Detects edited messages in group chats and broadcasts an alert.
 * RULE: Editing does NOT modify bets or records in any way!
 */
function handleMessageEdited(editMessageId, newText, userId, displayName, groupId, replyToken) {
  var searchId = cleanUserId(userId);
  var cached = editMessageId ? getCachedMessage(editMessageId) : null;
  var orderNo = editMessageId ? getOrderNoByMessageId(editMessageId) : null;
  var originalText = cached ? cached.text : null;
  var targetGroupId = groupId || (cached ? cached.groupId : null);
  var effectiveDisplayName = displayName || (cached ? cached.displayName : null);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Bets');
  if (sheet && (!orderNo || !originalText)) {
    var data = sheet.getDataRange().getValues();
    var searchMsgId = editMessageId ? editMessageId.toString().trim() : '';
    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      var rowMsgId = row[13] ? row[13].toString().trim() : '';
      if (searchMsgId && rowMsgId === searchMsgId) {
        orderNo = row[0].toString().trim();
        originalText = originalText || ('Order #' + orderNo);
        if (!effectiveDisplayName) {
          effectiveDisplayName = row[2] || row[4] || 'ผู้เล่น';
        }
        if (!targetGroupId) {
          targetGroupId = row[12] ? row[12].toString().trim() : null;
        }
        break;
      }
    }
  }

  effectiveDisplayName = effectiveDisplayName || 'ผู้ใช้';
  targetGroupId = targetGroupId || getActiveGroupId();

  // Update cached text with newText for subsequent tracking
  if (editMessageId) {
    cacheLineMessage(editMessageId, newText, userId, effectiveDisplayName, targetGroupId);
  }

  // RULE: Edit message does NOT modify or change bets in any way!
  var alertFlex = constructEditAlertFlex(effectiveDisplayName, originalText, newText, orderNo);
  if (replyToken && replyToken !== 'MOCK_REPLY_TOKEN') {
    try {
      replyToLine(replyToken, alertFlex, userId);
      return;
    } catch (e) {
      Logger.log('[handleMessageEdited] replyToLine failed: ' + e);
    }
  }

  if (targetGroupId) {
    pushLineGroupMessage(targetGroupId, alertFlex);
  } else if (userId) {
    pushToLine(userId, alertFlex);
  }
}

/**
 * Handle incoming LINE text commands (ชล200, ชย500, ต, เช็คยอด, ถอนยอด, ฝากเงิน, etc.)
 */
function handleTextMessage(text, userId, displayName, replyToken, groupId, messageId) {
  userId = getOrCreateShortUserId(userId, displayName);
  if (messageId) {
    cacheLineMessage(messageId, text, userId, displayName, groupId);
  }

  // Normalize inputs
  const rawTrimmed = (text || '').trim();
  const normalized = rawTrimmed.replace(/\s+/g, ' ').toLowerCase();
  const clean = rawTrimmed.replace(/\s+/g, '').toLowerCase();

  // ─────────────────────────────────────────────────────────────
  // 1. CHECK BALANCE ("เช็คยอด", "คงเหลือ", "balance")
  // ─────────────────────────────────────────────────────────────
  if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
    if (groupId) {
      replyToLine(replyToken, '💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀', userId);
    } else {
      const balance = getPlayerBalance(userId, displayName);
      const balanceFlex = constructBalanceFlex(displayName, balance);
      replyToLine(replyToken, balanceFlex, userId);
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 2. LIST ACTIVE DEALS ("รายการจับคู่", "matched", "รายการดวล")
  // ─────────────────────────────────────────────────────────────
  if (clean === 'รายการจับคู่' || clean === 'matched' || clean === 'รายการดวล') {
    const matchedBets = getPlayerActiveBets(userId);
    if (matchedBets.length === 0) {
      replyToLine(replyToken, '📝 รายการดวลของคุณ:\n\n❌ ปัจจุบันไม่มีแผลดวลค้างหรือรอคู่ในระบบครับ', userId);
    } else {
      let replyMsg = '📝 รายการดวลของคุณ (' + matchedBets.length + ' รายการ):\n';
      matchedBets.forEach(function(b) {
        const side = b.playerLowId === userId ? 'ต่ำ (Low)' : 'สูง (High)';
        const statusText = b.status === 'matched' ? 'ดวลกันอยู่ ☄️' : 'รอคู่ดวล ⏳';
        replyMsg += '\n-----------------------\nOrder: #' + b.orderNumber + '\nยอดดวล: ' + b.amount + ' แต้ม\nฝั่งของคุณ: ' + side + '\nคู่ดวล: ' + (b.opponentName || 'รอคู่...') + '\nสถานะ: ' + statusText + '\n' + (b.status === 'pending_match' ? ('💡 พิมพ์ "ยกเลิก ' + b.orderNumber + '" เพื่อถอนแผลและรับแต้มคืน') : '');
      });
      replyToLine(replyToken, replyMsg, userId);
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 3. PENDING DEALS BOARD ("กระดานดวล", "แผลค้าง", "เปิดรอคู่", "รอคู่")
  // ─────────────────────────────────────────────────────────────
  if (clean === 'กระดานดวล' || clean === 'แผลค้าง' || clean === 'เปิดรอคู่' || clean === 'รอคู่') {
    const pendingList = getPendingBetsList();
    var boardFlex = constructPendingBetsFlex(pendingList);
    replyToLine(replyToken, boardFlex, userId);
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 4. CANCEL DEAL REQUEST ("ยกเลิก [orderNo]" or "ยกเลิก")
  // ─────────────────────────────────────────────────────────────
  var cancelRegex = /^(ยกเลิก|cancel)\s*#?(\d{2,6})?$/i;
  if (cancelRegex.test(clean) || cancelRegex.test(rawTrimmed)) {
    var cancelMatch = rawTrimmed.match(cancelRegex) || clean.match(cancelRegex);
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

  // ─────────────────────────────────────────────────────────────
  // 5. ADMIN COMMANDS (Round Control & Quotes)
  // ─────────────────────────────────────────────────────────────
  // Admin Command: Close / Lock Round
  var closeRoundRegex = /^(ปิดรอบ|ปิดรับดวล|ล็อครอบ|3-2-go|32go)$/i;
  if (closeRoundRegex.test(clean)) {
    var currentRound = getActiveRocketRound();
    setRocketRoundStatus('CLOSED');
    replyToLine(replyToken, '❌ ปิดรับดวลรอบ ' + (currentRound ? currentRound.name : '') + ' เรียบร้อยแล้วครับ', userId);
    return;
  }

  // Admin Command: Open Round
  var openRoundRegex = /^(เปิดรอบ|เปิดรับดวล)$/i;
  if (openRoundRegex.test(clean)) {
    setRocketRoundStatus('ACTIVE');
    var activeRound = getActiveRocketRound();
    replyToLine(replyToken, '🚀 เปิดรับดวลแล้วครับ | บั้งไฟ: ' + activeRound.name + ' | ราคาช่าง: ' + activeRound.targetMin + '-' + activeRound.targetMax + ' วิ', userId);
    return;
  }

  // Admin Command: Set Quote
  var adminQuoteRegex = /^(ราคา|quote|setquote)\s*(\d{2,5})[-\/](\d{2,5})$/i;
  if (adminQuoteRegex.test(clean) || adminQuoteRegex.test(rawTrimmed)) {
    var qm = rawTrimmed.match(adminQuoteRegex) || clean.match(adminQuoteRegex);
    var qMin = parseInt(qm[2]);
    var qMax = parseInt(qm[3]);
    if (qMin >= qMax) {
      replyToLine(replyToken, '⚠️ ช่วงราคาไม่ถูกต้อง! ค่าเริ่มต้นต้องน้อยกว่าค่าสิ้นสุด (เช่น ราคา330-380)', userId);
      return;
    }
    var curRound = getActiveRocketRound();
    setActiveRocketRound(curRound.name, qMin, qMax, curRound.isChotoy);
    var quoteNotice = '📍 [ราคาช่างประกาศ]: ' + qMin + ' – ' + qMax + ' วิ\n\nตัวเลือกปรับราคา (กติกา 50 วิ):\n• -10: ' + (qMin - 10) + '-' + (qMax - 10) + 'วิ (ชล / ชถ)\n• -5:  ' + (qMin - 5) + '-' + (qMax - 5) + 'วิ (ชล / ชถ)\n• ปกติ: ' + qMin + '-' + qMax + 'วิ (ชล / ชถ)\n• +5:  ' + (qMin + 5) + '-' + (qMax + 5) + 'วิ (ชล / ชถ)\n• +10: ' + (qMin + 10) + '-' + (qMax + 10) + 'วิ (ชล / ชถ)';
    var groupTargetQ = groupId || getActiveGroupId();
    if (groupTargetQ) pushLineGroupMessage(groupTargetQ, quoteNotice);
    replyToLine(replyToken, '✅ ตั้งราคาช่าง: ' + qMin + '-' + qMax + ' วิ เรียบร้อยครับ', userId);
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 6. MATCH ACTION: ACCEPT / LOCK DEALS (Evaluated BEFORE deposits!)
  // ─────────────────────────────────────────────────────────────
  // Formats supported:
  // - Order + Amount: "9047 500", "9047/500", "9047-500", "#9047 500", "ต9047 500", "ต 9047 500", "9047ต 500", "9047 500pt"
  // - Keyword + Amount (Match latest bet with amount): "ต 500", "ต500", "ติด 500", "รับ 500", "เค 500"
  // - Order + Keyword / Single Order: "ต9047", "ต 9047", "ติด 9047", "รับ 9047", "9047ต", "9047 ติด", "ต12", "#9047"
  // - Standalone keyword: "ต", "ติด", "รับ", "ครับ", "เค", "จ้า", "ยอมรับ", "ดีล", "รับแผล"
  // - In group chat: standalone number "500", "1000", "9047"
  var orderAndAmountRegex = /^(?:(ต|ติด|ครับ|เค|จ้า|ยอมรับ|ดีล|รับแผล|รับ)\s*)?#?(\d{2,6})\s*(?:[-/:=]|ต|ติด|รับ|\s)\s*(\d{2,6})(?:\s*(?:pt|แต้ม))?$/i;
  var keywordAndAmountRegex = /^(?:(ต|ติด|ครับ|เค|จ้า|ยอมรับ|ดีล|รับแผล|รับ)\s*)(\d{2,6})(?:\s*(?:pt|แต้ม))?$/i;
  var explicitOrderAcceptRegex = /^(?:(ต|ติด|ครับ|เค|จ้า|ยอมรับ|ดีล|รับแผล|รับ)\s*#?(\d{2,6})|#?(\d{2,6})\s*(ต|ติด|รับ)|#(\d{2,6}))$/i;
  var keywordsAcceptList = ['ต', 'ตต', 'ติด', 'ครับ', 'เค', 'จ้า', 'ยอมรับ', 'ดีล', 'รับแผล', 'รับ'];

  var targetOrderNo = null;
  var customMatchAmount = null;
  var isAcceptMatch = false;

  if (orderAndAmountRegex.test(rawTrimmed)) {
    var m1 = rawTrimmed.match(orderAndAmountRegex);
    targetOrderNo = m1[2];
    customMatchAmount = parseInt(m1[3]);
    isAcceptMatch = true;
  } else if (keywordAndAmountRegex.test(rawTrimmed)) {
    // e.g. "ต 500", "ต500", "ติด 500" -> match latest open bet with 500 pt
    var mK = rawTrimmed.match(keywordAndAmountRegex);
    targetOrderNo = null;
    customMatchAmount = parseInt(mK[2]);
    isAcceptMatch = true;
  } else if (explicitOrderAcceptRegex.test(rawTrimmed)) {
    var me = rawTrimmed.match(explicitOrderAcceptRegex);
    targetOrderNo = me[2] || me[3] || me[4];
    isAcceptMatch = true;
  } else if (explicitOrderAcceptRegex.test(clean)) {
    var mc = clean.match(explicitOrderAcceptRegex);
    targetOrderNo = mc[2] || mc[3] || mc[4];
    isAcceptMatch = true;
  } else if (keywordsAcceptList.indexOf(clean) !== -1) {
    isAcceptMatch = true;
  } else if (groupId && /^\d+$/.test(clean)) {
    // In group chat, a pure number is either matching a 4-digit order number (e.g. 9047)
    // or specifying a match amount (e.g. 500) for the latest open bet!
    var pureVal = parseInt(clean);
    if (/^\d{4}$/.test(clean) && pureVal > 1000) {
      targetOrderNo = clean;
    } else {
      customMatchAmount = pureVal;
    }
    isAcceptMatch = true;
  }

  if (isAcceptMatch) {
    var tagPrefix = groupId ? ('👤 [ถึงคุณ @' + displayName + ']: ') : '';
    var matchedBet = matchExistingOpenBet(userId, displayName, targetOrderNo, customMatchAmount);

    if (matchedBet && matchedBet.error === 'BELOW_MIN_PERCENT_LIMIT') {
      var minMsg = tagPrefix + '⚠️ ยอดดวลขั้นต่ำคือ 20% (' + (matchedBet.minAllowed || 0) + ' pt) ของ Order #' + (matchedBet.orderNumber || targetOrderNo) + ' ครับ (คุณระบุ ' + (matchedBet.provided || 0) + ' pt)';
      replyToLine(replyToken, minMsg, userId);
      return;
    } else if (matchedBet && matchedBet.error === 'OWN_BET') {
      var ownBetMsg = tagPrefix + '⚠️ คุณไม่สามารถรับแผลดวลของตัวเองได้ครับ';
      replyToLine(replyToken, ownBetMsg, userId);
      return;
    } else if (matchedBet && matchedBet.error === 'CANCELLED') {
      var cancelMsg = tagPrefix + '🚫 แผล Order #' + (matchedBet.orderNumber || targetOrderNo) + ' ถูกยกเลิกไปแล้วครับ';
      replyToLine(replyToken, cancelMsg, userId);
      return;
    } else if (matchedBet && matchedBet.error === 'ALREADY_MATCHED') {
      var alreadyMsg = tagPrefix + '⚠️ แผล Order #' + (matchedBet.orderNumber || targetOrderNo) + ' มีคู่ดวลแล้ว ไม่สามารถรับซ้ำได้ครับ';
      replyToLine(replyToken, alreadyMsg, userId);
      return;
    } else if (matchedBet && matchedBet.error === 'INSUFFICIENT_BALANCE') {
      var needed = (matchedBet.required || 0) - (matchedBet.current || 0);
      var insuffMsg = tagPrefix + '⚠️ แต้มไม่พอ (มี ' + (matchedBet.current || 0) + 'pt | ขาด ' + needed + 'pt) พิมพ์ "ฝากเงิน"';
      replyToLine(replyToken, insuffMsg, userId);
      return;
    } else if (matchedBet && matchedBet.error === 'BELOW_MIN_LIMIT') {
      var belowMinMsg = tagPrefix + '⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + (matchedBet.provided || 0) + ' pt)';
      replyToLine(replyToken, belowMinMsg, userId);
      return;
    } else if (matchedBet && matchedBet.error === 'NOT_FOUND') {
      var notFoundMsg = targetOrderNo 
        ? (tagPrefix + '🚫 ไม่พบแผล Order #' + targetOrderNo + ' ในระบบครับ')
        : (tagPrefix + '🚫 ไม่มีแผลดวลฝั่งตรงข้ามที่รอคู่ในขณะนี้ครับ');
      replyToLine(replyToken, notFoundMsg, userId);
      return;
    } else if (matchedBet && matchedBet.error === 'EXCEEDS_ORDER_AMOUNT') {
      var exceedsMsg = tagPrefix + '⚠️ ยอดรับดวล (' + (matchedBet.provided || 0) + ' pt) เกินยอดของ Order #' + (matchedBet.orderNumber || targetOrderNo) + ' (รับได้สูงสุด ' + (matchedBet.maxAllowed || 0) + ' pt ครับ)';
      replyToLine(replyToken, exceedsMsg, userId);
      return;
    } else if (matchedBet && matchedBet.orderNumber) {
      var matchFlex = constructMatchNotificationFlex(matchedBet.orderNumber, matchedBet.amount, matchedBet.playerLowName, matchedBet.playerHighName, matchedBet.rangeInfo, false, null);
      replyToLine(replyToken, matchFlex, userId);
      if (matchedBet.creatorId) {
        pushToLine(matchedBet.creatorId, matchFlex);
      }
      if (matchedBet.matcherId && matchedBet.matcherId !== matchedBet.creatorId) {
        pushToLine(matchedBet.matcherId, matchFlex);
      }
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
      return;
    } else {
      var noOpenMsg = targetOrderNo
        ? (tagPrefix + '🚫 ไม่พบแผล Order #' + targetOrderNo + ' ที่เปิดรอคู่ครับ')
        : (tagPrefix + '🚫 ไม่มีแผลดวลฝั่งตรงข้ามที่รอคู่ในขณะนี้ครับ');
      replyToLine(replyToken, noOpenMsg, userId);
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 7. PARSE BET FORMULAS (ชล, ชถ, +5ชล, -10ชถ, 330-380ล500)
  // ─────────────────────────────────────────────────────────────
  var isChotoy = clean.indexOf('ชตย') !== -1 || rawTrimmed.indexOf('ชตย') !== -1;
  var cleanBetText = clean.replace(/ชตย/g, '').trim();

  var keywordsLow  = [
    'ชย', 'ชถ', 'ย', 'ถ', 'ยั่ง', 'ถอย', 'ต่ำ', 'ชต่ำ', 'ช่างต่ำ', 'ช่างยั่ง', 'ช่างถอย',
    '+5ชย', '+5ชถ', '+5ย', '+5ถ', '-5ชย', '-5ชถ', '-5ย', '-5ถ',
    '+10ชย', '+10ชถ', '+10ย', '+10ถ', '-10ชย', '-10ชถ', '-10ย', '-10ถ',
    'low', 'l'
  ];
  var keywordsHigh = [
    'ชล', 'a', 'ไล่', 'ล', 'ลง', 'สูง', 'ชสูง', 'ช่างสูง', 'ช่างไล่',
    '+5ชล', '+5a', '+5ล', '+5ไล่', '-5ชล', '-5a', '-5ล', '-5ไล่',
    '+10ชล', '+10a', '+10ล', '+10ไล่', '-10ชล', '-10a', '-10ล', '-10ไล่',
    'ส', 'high', 'h'
  ];

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

  var rangeMin = 0;
  var rangeMax = 0;
  var betType = '';
  var side = '';
  var amount = 0;

  if (rangeRegex.test(cleanBetText)) {
    // Custom range
    var rMatch = cleanBetText.match(rangeRegex);
    rangeMin = parseInt(rMatch[1]);
    rangeMax = parseInt(rMatch[2]);
    var rCmd = rMatch[3];
    side = keywordsLow.indexOf(rCmd) !== -1 ? 'low' : (keywordsHigh.indexOf(rCmd) !== -1 ? 'high' : '');
    amount = rMatch[4] ? parseInt(rMatch[4]) : 500;
    betType = 'custom_range';

    if (side) {
      if (rangeMin >= rangeMax) {
        var orderErrMsg = groupId
          ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ ระบุช่วงเวลาจากต่ำไปสูงเท่านั้นครับ เช่น 300-350' + rCmd + ' (คุณระบุ ' + rangeMin + '-' + rangeMax + ')'
          : '⚠️ ระบุช่วงเวลาจากต่ำไปสูงเท่านั้นครับ เช่น 300-350' + rCmd + ' (คุณระบุ ' + rangeMin + '-' + rangeMax + ')';
        replyToLine(replyToken, orderErrMsg, userId);
        return;
      }

      if (rangeMax - rangeMin !== 50) {
        var diff = rangeMax - rangeMin;
        var windowErrMsg = groupId
          ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ ช่วงราคาต้องห่างกัน 50 วินาทีพอดีครับ เช่น 300-350' + rCmd + ' (คุณระบุ ' + rangeMin + '-' + rangeMax + ' ห่าง ' + diff + ' วิ)'
          : '⚠️ ช่วงราคาต้องห่างกัน 50 วินาทีพอดีครับ เช่น 300-350' + rCmd + ' (คุณระบุ ' + rangeMin + '-' + rangeMax + ' ห่าง ' + diff + ' วิ)';
        replyToLine(replyToken, windowErrMsg, userId);
        return;
      }

      if (amount < 100) {
        var minAmtMsg = groupId
          ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + amount + ' pt)'
          : '⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + amount + ' pt)';
        replyToLine(replyToken, minAmtMsg, userId);
        return;
      }
    }
  } else if (simpleRegex.test(strippedBetText)) {
    var sMatch = strippedBetText.match(simpleRegex);
    var sCmd = sMatch[1];
    side = keywordsLow.indexOf(sCmd) !== -1 ? 'low' : (keywordsHigh.indexOf(sCmd) !== -1 ? 'high' : '');
    amount = sMatch[2] ? parseInt(sMatch[2]) : 500;
    betType = 'range';

    if (side && amount < 100) {
      var minAmtMsg2 = groupId
        ? '👤 [ถึงคุณ @' + displayName + ']: ⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + amount + ' pt)'
        : '⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ' + amount + ' pt)';
      replyToLine(replyToken, minAmtMsg2, userId);
      return;
    }

    var activeRound = getActiveRocketRound();
    rangeMin = Number(activeRound.targetMin) || 330;
    rangeMax = Number(activeRound.targetMax) || 380;
    rangeMin += offsetDelta;
    rangeMax += offsetDelta;
  }

  // If a valid bet was parsed
  if (side && amount >= 100) {
    if (isRocketRoundClosed()) {
      var closedMsg = groupId
        ? '👤 [ถึงคุณ @' + displayName + ']: ⛔ ปิดรับออเดอร์แล้ว⛔️\nกรุณารอรอบถัดไปครับ'
        : '⛔ ปิดรับออเดอร์แล้ว⛔️\nกรุณารอรอบถัดไปครับ';
      replyToLine(replyToken, closedMsg, userId);
      return;
    }

    const balance = getPlayerBalance(userId, displayName);
    if (balance < amount) {
      const needed = amount - balance;
      const msg = groupId
        ? '⚠️ แต้มไม่พอ (มี ' + balance + 'pt | ขาด ' + needed + 'pt) พิมพ์ "ฝากเงิน"'
        : '⚠️ เครดิตไม่พอ (มี ' + balance + 'pt | ต้องการ ' + amount + 'pt)\n💵 พิมพ์ "ฝากเงิน" เพื่อเติมเครดิตครับ';
      replyToLine(replyToken, msg, userId);
      return;
    }

    var orderNumber = (Math.floor(Math.random() * 900000) + 100000).toString();
    var isPreQuoteBet = (betType === 'pre_quote');
    var userTypedCmdStr = cleanBetText || null;
    var saveResult = saveOpenBet(orderNumber, userId, displayName, side, amount, betType, rangeMin, rangeMax, groupId, userTypedCmdStr, isPreQuoteBet, messageId);
    if (saveResult && saveResult.error) {
      var bal = saveResult.current || 0;
      var neededBal = amount - bal;
      var insufficientMsg = groupId
        ? '⚠️ แต้มไม่พอ (มี ' + bal + 'pt | ขาด ' + neededBal + 'pt) พิมพ์ "ฝากเงิน"'
        : '⚠️ เครดิตไม่พอ (มี ' + bal + 'pt | ต้องการ ' + amount + 'pt)\n💵 พิมพ์ "ฝากเงิน" เพื่อเติมเครดิตครับ';
      replyToLine(replyToken, insufficientMsg, userId);
      return;
    }

    var rangeInfo = (rangeMin && rangeMax) ? (rangeMin + '-' + rangeMax + 's') : '';
    var betOpenFlex = constructBetOpenFlex(orderNumber, amount, side, displayName, rangeInfo, isChotoy, userTypedCmdStr, isPreQuoteBet);
    replyToLine(replyToken, betOpenFlex, userId);
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 8. DEPOSIT & WITHDRAWAL COMMANDS (1-on-1 DM Only)
  // ─────────────────────────────────────────────────────────────
  // A. Initiate Deposit Menu
  if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit' || clean === 'เติมเครดิต') {
    if (groupId) {
      replyToLine(replyToken, '💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀', userId);
    } else {
      replyToLine(replyToken, constructDepositFlex(), userId);
    }
    return;
  }

  // B. Initiate Withdrawal Menu
  if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
    if (groupId) {
      replyToLine(replyToken, '💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀', userId);
    } else {
      const bank = getPlayerBank(userId);
      if (!bank) {
        if (hasSuccessfulDeposit(userId)) {
          replyToLine(replyToken, constructBankRegistrationFlex(), userId);
        } else {
          replyToLine(replyToken, '❌ ไม่พบประวัติการฝากเงินผ่านระบบ!\n\nเพื่อความปลอดภัยสูงสุด กรุณาฝากเงินเข้ามาก่อนครับ', userId);
        }
      } else {
        const balance = getPlayerBalance(userId, displayName);
        replyToLine(replyToken, constructWithdrawalFlex(bank.bankName, bank.accountNumber, bank.accountName, balance), userId);
      }
    }
    return;
  }

  // C. Process Withdrawal Amount ("ถอน [amount]")
  const withdrawTextRegex = /^(ถอน|ถอนเงิน|ถอนยอด|withdraw)\s*(\d+)$/i;
  if (withdrawTextRegex.test(rawTrimmed) || withdrawTextRegex.test(clean)) {
    if (groupId) {
      replyToLine(replyToken, '💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀', userId);
      return;
    }
    const match = rawTrimmed.match(withdrawTextRegex) || clean.match(withdrawTextRegex);
    const withdrawAmt = parseInt(match[2]);
    const bank = getPlayerBank(userId);
    if (!bank) {
      replyToLine(replyToken,
        '🏦 ยังไม่มีข้อมูลบัญชีธนาคารในระบบของท่านครับ\n\n' +
        '📸 กรุณาส่งรูปถ่าย หรือสกรีนช็อต หน้าสมุดบัญชีธนาคารที่แสดง:\n' +
        '  • ชื่อ-นามสกุล เจ้าของบัญชี\n' +
        '  • เลขบัญชีที่ตรงกับบัญชีที่โอนเงินเข้ามาครับ\n\n' +
        '⚠️ ต้องเป็นบัญชีเดียวกับที่ใช้โอนเงินฝากเข้ามาเท่านั้น\n\n' +
        'ทีมงานจะตรวจสอบและลงทะเบียนให้ภายใน 24 ชั่วโมงครับ\n' +
        '📞 ติดต่อด่วน: 089-104-1992',
        userId
      );
      return;
    }
    const balance = getPlayerBalance(userId, displayName);
    if (withdrawAmt < 100) {
      replyToLine(replyToken, '❌ จำนวนเงินถอนขั้นต่ำคือ 100 แต้มครับ', userId);
      return;
    }
    if (balance < withdrawAmt) {
      replyToLine(replyToken, '❌ เครดิตไม่เพียงพอสำหรับการถอนเงินจำนวนนี้!\nยอดเงินของท่าน: ' + balance + ' แต้ม\nยอดที่ต้องการถอน: ' + withdrawAmt + ' แต้ม', userId);
      return;
    }
    
    adjustPlayerBalance(userId, -withdrawAmt, displayName);
    logTransaction(userId, displayName, withdrawAmt, 0, 'PENDING_WITHDRAW', 'escalated', 'Withdrawal request to ' + bank.bankName + ' ' + bank.accountNumber + ' ' + bank.accountName);
    replyToLine(replyToken, '📥 ได้รับคำขอถอนเงินจำนวน ' + withdrawAmt + ' แต้ม เรียบร้อยแล้วครับ!\n\nระบบกำลังส่งต่อข้อมูลให้แอดมินพิจารณาอนุมัติโอนเงินแบบแมนนวลเข้าบัญชีธนาคาร ' + bank.bankName + ' เลขบัญชี ' + bank.accountNumber + ' ของคุณครับ\n\nยอดคงเหลือหลังทำรายการ: ' + (balance - withdrawAmt) + ' แต้ม', userId);
    return;
  }

  // D. Process Explicit Deposit Amount ("ฝาก [amount]", "เติม [amount]")
  const depositTextRegex = /^(ฝาก|ฝากเงิน|เติม|เติมเงิน|deposit)\s*(\d+)$/i;
  if (depositTextRegex.test(rawTrimmed) || depositTextRegex.test(clean)) {
    if (groupId) {
      replyToLine(replyToken, '💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀', userId);
      return;
    }
    const match = rawTrimmed.match(depositTextRegex) || clean.match(depositTextRegex);
    const depositAmt = parseInt(match[2]);
    if (depositAmt < 100 || depositAmt > 10000) {
      replyToLine(replyToken, '⚠️ ขออภัยครับ ระบบรองรับการฝากยอดขั้นต่ำ 100 THB และสูงสุดไม่เกิน 10,000 THB ต่อครั้งครับ', userId);
      return;
    }
    logTransaction(userId, displayName, depositAmt, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
    replyToLine(replyToken, constructDepositInvoiceFlex(depositAmt), userId);
    return;
  }

  // E. Process Standalone Pure Number in 1-on-1 DM (strictly not in group)
  if (!groupId && /^\d+$/.test(clean)) {
    const pureNum = parseInt(clean);
    if (pureNum >= 100 && pureNum <= 10000) {
      logTransaction(userId, displayName, pureNum, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
      replyToLine(replyToken, constructDepositInvoiceFlex(pureNum), userId);
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 9. RULE & GUIDE COMMANDS
  // ─────────────────────────────────────────────────────────────
  if (clean === 'กติกา' || clean === 'rule' || clean === 'rules' || clean === 'วิธีเล่น' || clean === 'คู่มือ') {
    replyToLine(replyToken, RULE_GUIDE_TEXT, userId);
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 10. MAIN MENU & HELP
  // ─────────────────────────────────────────────────────────────
  if (clean === 'เมนู' || clean === 'menu' || clean === 'เริ่ม' || clean === 'start' || clean === 'help' || clean === 'สวัสดี' || clean === 'ช่วยเหลือ') {
    if (groupId) {
      replyToLine(replyToken, '💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ (ในกลุ่มใช้พิมพ์แทงดวลสด และพิมพ์ "กระดานดวล") 🚀', userId);
    } else {
      replyToLine(replyToken, constructMainMenuFlex(), userId);
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // 11. FALLBACK
  // ─────────────────────────────────────────────────────────────
  if (!groupId) {
    replyToLine(replyToken, '🤖 ไม่เข้าใจคำสั่งครับ ข้อมูลได้รับการบันทึกแล้ว แอดมินจะติดต่อกลับคุณในไม่ช้าครับ 💬\n(หรือพิมพ์ "เมนู" เพื่อดูคำสั่งที่ใช้งานได้ครับ 🚀)', userId);
  }
}

/**
 * Handle incoming LINE image transfers (Bank slip verification check)
 */
function handleImageSlipMessage(messageId, userId, displayName, replyToken) {
  userId = getOrCreateShortUserId(userId, displayName);
  // 1. Call LINE Content API to pull image binary data
  const imageUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const headers = { "Authorization": "Bearer " + getLineToken_() };
  const imageResponse = UrlFetchApp.fetch(imageUrl, { method: "get", headers: headers });
  const imageBlob = imageResponse.getBlob().setName("payslip.jpg");
  
  // 2. HTTP POST file bytes to Thai Slip Checking API (Supports Slip2Go Base64 JSON & EasySlip Multipart)
  const isSlip2Go = SLIP_API_URL.indexOf("slip2go.com") !== -1;
  let options;
  if (isSlip2Go) {
    const base64Image = Utilities.base64Encode(imageBlob.getBytes());
    const mimeType = imageBlob.getContentType() || "image/jpeg";
    const dataUri = "data:" + mimeType + ";base64," + base64Image;
    options = {
      method: "post",
      headers: {
        "Authorization": "Bearer " + getSlipApiKey_(),
        "Content-Type": "application/json"
      },
      payload: JSON.stringify({
        payload: {
          imageBase64: dataUri
        }
      }),
      muteHttpExceptions: true
    };
  } else {
    options = {
      method: "post",
      headers: { "Authorization": "Bearer " + getSlipApiKey_() },
      payload: { 
        image: imageBlob,
        file: imageBlob
      },
      muteHttpExceptions: true
    };
  }
  
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
    } else if (responseCode === 403 || errorDetail.indexOf("expired") !== -1 || errorDetail.indexOf("SERVICE_EXPIRED") !== -1) {
      replyToLine(replyToken, `📥 ได้รับสลิปเรียบร้อยแล้วครับ\nขณะนี้ระบบสแกนสลิปออโต้อยู่ระหว่างรอบบำรุงรักษาระบบ รายการเติมเงินของคุณได้ส่งต่อให้ แอดมิน ตรวจสอบและปรับเครดิตให้ในระบบหลังบ้านโดยเร็วที่สุดครับ 🙏`);
    } else {
      replyToLine(replyToken, `⚠️ ระบบเช็คสลิปขัดข้อง (HTTP ${responseCode})\nรายละเอียด: ${errorDetail}\n\nแอดมินได้รับบิลนี้เรียบร้อย กำลังตรวจสอบแมนนวลให้ในระบบหลังบ้านครับ`);
    }
    return;
  }
  
  // 3. Process slip parameters (Slip2Go & EasySlip)
  const isSuccessSlip = isSlip2Go
    ? (slipData && (slipData.code === "200000" || (slipData.data && (slipData.data.transRef || slipData.data.referenceId))))
    : (slipData && (slipData.success || slipData.data));

  if (!isSuccessSlip) {
    let apiMessage = (slipData && slipData.message) || (slipData && slipData.error ? slipData.error.message : 'No QR code readable');
    if (slipData && slipData.code === "200500") {
      apiMessage = "ไม่พบข้อมูลสลิปในระบบธนาคาร หรือ QR Code ไม่ชัดเจน";
    }
    logTransaction(userId, displayName, 0, 0, 'ERR_INVALID_SLIP', 'escalated', 'API check failed: ' + apiMessage);
    replyToLine(replyToken, `❌ สแกนสลิปไม่ผ่าน\nเหตุผล: ${apiMessage}\n\nระบบส่งต่อบิลนี้ให้แอดมินเช็คบัญชีแมนนวลแล้วครับ`);
    return;
  }
  
  // Robust field extraction supporting both Slip2Go and EasySlip (flat & v2)
  var refCode = '';
  if (slipData.data) {
    if (slipData.data.transRef) {
      refCode = slipData.data.transRef;
    } else if (slipData.data.rawSlip && slipData.data.rawSlip.transRef) {
      refCode = slipData.data.rawSlip.transRef;
    } else if (slipData.data.referenceId) {
      refCode = slipData.data.referenceId;
    } else if (slipData.data.transactionId) {
      refCode = slipData.data.transactionId;
    }
  }
 
  var actualAmount = 0;
  if (slipData.data) {
    if (slipData.data.amount !== undefined) {
      if (typeof slipData.data.amount === 'object' && slipData.data.amount !== null) {
        actualAmount = Number(slipData.data.amount.amount) || 0;
      } else {
        actualAmount = Number(slipData.data.amount) || 0;
      }
    } else if (slipData.data.amountInSlip !== undefined) {
      actualAmount = Number(slipData.data.amountInSlip) || 0;
    } else if (slipData.data.rawSlip && slipData.data.rawSlip.amount) {
      if (typeof slipData.data.rawSlip.amount === 'object' && slipData.data.rawSlip.amount !== null) {
        actualAmount = Number(slipData.data.rawSlip.amount.amount) || 0;
      } else {
        actualAmount = Number(slipData.data.rawSlip.amount) || 0;
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
    if (slipData.data.dateTime) {
      slipDateStr = slipData.data.dateTime;
    } else if (slipData.data.rawSlip && slipData.data.rawSlip.date) {
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
          senderBank = slipData.data.sender.bank.abbr || slipData.data.sender.bank.name || slipData.data.sender.bank.id || '';
        }
        if (slipData.data.sender.account) {
          senderAccount = (slipData.data.sender.account.bank && slipData.data.sender.account.bank.account) || slipData.data.sender.account.value || '';
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

  var cache = CacheService.getScriptCache();
  try {
    var cachedBal = cache.get('PLAYER_BAL_' + searchId);
    if (cachedBal !== null && cachedBal !== undefined && cachedBal !== '') {
      var parsed = Number(cachedBal);
      if (!isNaN(parsed)) return parsed;
    }
  } catch(_) {}

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      var bal = Number(data[i][2]) || 0;
      try { cache.put('PLAYER_BAL_' + searchId, String(bal), 60); } catch(_) {}
      return bal;
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
        const newBal = currentBalance + numericDelta;
        cell.setValue(newBal);
        try { CacheService.getScriptCache().put('PLAYER_BAL_' + searchId, String(newBal), 120); } catch(_) {}
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
function saveOpenBet(orderNo, userId, displayName, side, amount, type, rMin, rMax, targetGroupId, userTypedCmd, isPreQuote, messageId) {
  var searchId = cleanUserId(userId);
  var betAmount = Number(amount) || 0;
  
  const isAdminUser = searchId === 'admin' || searchId === 'user' || (typeof userId === 'string' && (userId.toLowerCase() === 'user' || userId.toLowerCase() === 'admin'));

  // Anti-Overdraft Guard: atomically deduct creator balance
  if (!isAdminUser && betAmount > 0) {
    const deducted = adjustPlayerBalance(searchId, -betAmount, displayName);
    if (!deducted) {
      const currentBal = getPlayerBalance(searchId, displayName);
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
    targetGroupId || '',
    '',
    messageId || ''
  ]);
  if (messageId) {
    linkOrderToMessage(messageId, orderNo);
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
  
  // 1. Search by target order first if specified (prioritizing pending_match)
  if (cleanTargetOrder) {
    var foundIndex = -1;
    var foundRow = null;
    var hasMatched = false;
    var hasCancelled = false;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const orderNo = row[0].toString().trim();
      if (orderNo === cleanTargetOrder || orderNo.endsWith(cleanTargetOrder)) {
        const status = row[9];
        if (status === 'pending_match') {
          foundIndex = i;
          foundRow = row;
          break;
        } else if (status === 'matched' || status === 'resolved') {
          hasMatched = true;
        } else if (status === 'cancelled' || status === 'void') {
          hasCancelled = true;
        }
      }
    }

    if (foundIndex === -1) {
      if (hasCancelled && !hasMatched) {
        return { error: 'CANCELLED', orderNumber: cleanTargetOrder };
      }
      if (hasMatched) {
        return { error: 'ALREADY_MATCHED', orderNumber: cleanTargetOrder };
      }
      return { error: 'NOT_FOUND', targetOrderNo: cleanTargetOrder };
    }

    const i = foundIndex;
    const row = foundRow;
    const orderNo = row[0].toString().trim();
    let playerLowId = row[1] ? row[1].toString().trim() : '';
    let playerLowName = row[2] ? row[2].toString().trim() : '';
    let playerHighId = row[3] ? row[3].toString().trim() : '';
    let playerHighName = row[4] ? row[4].toString().trim() : '';
    const totalAmount = Number(row[5]) || 0;
    const betType = row[6] || 'range';
    let rMin = row[7];
    let rMax = row[8];
    var activeRound = getActiveRocketRound();
    var curTMin = Number(activeRound.targetMin) || 330;
    var curTMax = Number(activeRound.targetMax) || 380;
    if (Number(rMin) >= 700 && curTMin < 600) {
      var offset = Number(rMin) - 810;
      if (offset >= -50 && offset <= 50) {
        rMin = curTMin + offset;
        rMax = curTMax + offset;
      } else {
        rMin = curTMin;
        rMax = curTMax;
      }
      sheet.getRange(i + 1, 8).setValue(rMin);
      sheet.getRange(i + 1, 9).setValue(rMax);
    }
    const targetGroupId = row[12] || '';
    
    const creatorId = playerLowId ? playerLowId : playerHighId;
    const creatorName = playerLowId ? playerLowName : playerHighName;
    const creatorSide = playerLowId ? 'low' : 'high';

    // 1. OWN_BET GUARD: Check clean ID, raw ID, and displayName
    if (creatorId === searchId || creatorId === cleanUserId(userId) || (creatorName && displayName && creatorName === displayName)) {
      return { error: 'OWN_BET', orderNumber: orderNo };
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

    // If partial match: create Child split order keeping original orderNo for the remaining amount
    if (isSplit && remainingAmount >= 100) {
      splitOrderNumber = orderNo;
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
  
  // 2. Search first open pending bet
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[9] === 'pending_match') {
      const orderNo = row[0].toString().trim();
      const totalAmount = Number(row[5]) || 0;
      const betType = row[6] || 'range';
      let rMin = row[7];
      let rMax = row[8];
      var activeRoundAuto = getActiveRocketRound();
      var curTMinAuto = Number(activeRoundAuto.targetMin) || 330;
      var curTMaxAuto = Number(activeRoundAuto.targetMax) || 380;
      if (Number(rMin) >= 700 && curTMinAuto < 600) {
        var offsetAuto = Number(rMin) - 810;
        if (offsetAuto >= -50 && offsetAuto <= 50) {
          rMin = curTMinAuto + offsetAuto;
          rMax = curTMaxAuto + offsetAuto;
        } else {
          rMin = curTMinAuto;
          rMax = curTMaxAuto;
        }
        sheet.getRange(i + 1, 8).setValue(rMin);
        sheet.getRange(i + 1, 9).setValue(rMax);
      }
      const targetGroupId = row[12] || '';
      
      let playerLowId = row[1] ? row[1].toString().trim() : '';
      let playerLowName = row[2];
      let playerHighId = row[3] ? row[3].toString().trim() : '';
      let playerHighName = row[4];
      
      const creatorId = playerLowId ? playerLowId : playerHighId;
      const creatorName = playerLowName ? playerLowName : playerHighName;
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
        splitOrderNumberAuto = orderNo;
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
  if (!userId) return null;
  var cacheKey = 'LINE_PROF_' + userId;
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch(_) {}

  const url = `https://api.line.me/v2/bot/profile/${userId}`;
  const options = {
    method: "get",
    headers: { "Authorization": "Bearer " + getLineToken_() },
    muteHttpExceptions: true
  };
  try {
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() === 200) {
      const text = res.getContentText();
      try { cache.put(cacheKey, text, 86400); } catch(_) {}
      return JSON.parse(text);
    }
    return null;
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
    headers: { 'Authorization': 'Bearer ' + getLineToken_() },
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
 * Uses CacheService for instant sub-50ms responses on repeated calls.
 */
function getDashboardData(forceFresh) {
  var cache = CacheService.getScriptCache();
  if (!forceFresh) {
    try {
      var cachedStr = cache.get('DASHBOARD_DATA_CACHE');
      if (cachedStr) {
        return JSON.parse(cachedStr);
      }
    } catch(_) {}
  }

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

  // 2. Transactions sheet (compacted to 80 most recent)
  const tData = ss.getSheetByName('Transactions').getDataRange().getValues();
  const transactions = [];
  for (let i = tData.length - 1; i >= 1 && transactions.length < 80; i--) { // Reverse order = newest first
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

  // 3. Bets sheet (compacted to 100 most recent)
  const bData = ss.getSheetByName('Bets').getDataRange().getValues();
  const bets = [];
  const startBetIdx = Math.max(1, bData.length - 100);
  for (let i = startBetIdx; i < bData.length; i++) {
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
    const startLogIdx = Math.max(1, cData.length - 50);
    for (let i = startLogIdx; i < cData.length; i++) {
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

  const result = {
    players: players,
    transactions: transactions,
    bets: bets,
    chatLogs: chatLogs,
    activeGroupId: getActiveGroupId(),
    lineGroups: getLineGroups(),
    activeRound: getActiveRocketRound(),
    roundStatus: PropertiesService.getScriptProperties().getProperty('ROUND_STATUS') || 'ACTIVE'
  };

  try {
    const serialized = JSON.stringify(result);
    if (serialized.length < 95000) {
      cache.put('DASHBOARD_DATA_CACHE', serialized, 8); // Cache for 8 seconds
    }
  } catch(_) {}

  return result;
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
      const currentStatus = (tData[i][6] || '').toString().toLowerCase();
      if (currentStatus === 'success') {
        // Idempotent: never credit twice
        return getDashboardData();
      }

      const userId = tData[i][1];
      const displayName = tData[i][2];
      const reqAmt = Number(tData[i][3]) || 0;
      let actualAmount = Number(tData[i][4]) || 0;
      if (actualAmount <= 0) {
        actualAmount = reqAmt;
      }
      
      const isWithdrawal = searchId.indexOf('WD') === 0 || (tData[i][5] && tData[i][5].toString().toUpperCase().indexOf('WD') !== -1) || (tData[i][7] && tData[i][7].toString().toLowerCase().indexOf('withdraw') !== -1);

      // Columns: E Actual, F Bank Ref, G Status, H Reason
      tSheet.getRange(i + 1, 5, 1, 4).setValues([[
        actualAmount,
        tData[i][5] || '',
        'success',
        'Manually approved by supervisor'
      ]]);

      if (isWithdrawal) {
        // Withdrawal: the balance was already deducted, we just record the actual payout in sheet
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
      
      // Single batched write to columns 7 and 8
      tSheet.getRange(i + 1, 7, 1, 2).setValues([['rejected', reason || 'Rejected by supervisor']]);
      
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
  const activeRound = getActiveRocketRound();
  let tMin = (targetMin && Number(targetMin) > 0) ? Number(targetMin) : Number(activeRound.targetMin || 330);
  let tMax = (targetMax && Number(targetMax) > 0) ? Number(targetMax) : Number(activeRound.targetMax || 380);
  const pushRequests = [];
  const pendingLogs = [];
  
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
      let rangeMin = row[7] ? Number(row[7]) : tMin;
      let rangeMax = row[8] ? Number(row[8]) : tMax;
      
      // Self-heal corrupt legacy ranges if stored as >= 700 while tMin < 600
      if (rangeMin >= 700 && tMin < 600) {
        var offset = rangeMin - 810;
        if (offset >= -50 && offset <= 50) {
          rangeMin = tMin + offset;
          rangeMax = tMax + offset;
        } else {
          rangeMin = tMin;
          rangeMax = tMax;
        }
        bSheet.getRange(i + 1, 8, 1, 2).setValues([[rangeMin, rangeMax]]);
      }
      
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
      
      // Settle row with a single batched 2-column write
      bSheet.getRange(i + 1, 10, 1, 2).setValues([['resolved', winnerName]]);
      
      // Prepare push notifications for parallel batch dispatch
      try {
        const winBal = getPlayerBalance(winnerId, winnerName);
        const winFlex = constructMatchResultFlex(true, orderNo, amount, finalTime, payout, winBal, winnings, commission, winnerId);
        const winReq = createLinePushRequest(winnerId, winFlex);
        if (winReq) pushRequests.push(winReq);
        pendingLogs.push({ userId: winnerId, displayName: winnerName, sender: 'bot', text: '[Flex Message: Win]', type: 'flex' });
      } catch (err) {
        Logger.log("Error preparing win message: " + err);
      }
      
      try {
        const loseBal = getPlayerBalance(loserId, loserName);
        const loseFlex = constructMatchResultFlex(false, orderNo, amount, finalTime, 0, loseBal, winnings, commission, loserId);
        const loseReq = createLinePushRequest(loserId, loseFlex);
        if (loseReq) pushRequests.push(loseReq);
        pendingLogs.push({ userId: loserId, displayName: loserName, sender: 'bot', text: '[Flex Message: Lose]', type: 'flex' });
      } catch (err) {
        Logger.log("Error preparing lose message: " + err);
      }
    }
  }

  // 🚀 HIGH-SPEED: Parallelize all player win/lose notifications in ONE concurrent roundtrip
  if (pushRequests.length > 0) {
    try {
      UrlFetchApp.fetchAll(pushRequests);
    } catch (pushErr) {
      Logger.log("Error in parallel UrlFetchApp.fetchAll for match results: " + pushErr.toString());
    }
  }
  if (pendingLogs.length > 0) {
    batchLogLineChatMessages(pendingLogs);
  }

  // 3. Broadcast Round Summary Flex to all active groups
  try {
    var ssInfo = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Rockets');
    var rocketName = (activeRound && activeRound.name) ? activeRound.name : 'ช่างบั้งไฟสด';
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
    const betType = (bData[i][6] || '').toString();
    const eligible =
      status === 'pending_match' ||
      status === 'matched' ||
      status === 'pending_cancel' ||
      status === 'pre_quote_matched' ||
      (betType === 'pre_quote' && (status === 'pending_match' || status === 'pre_quote_matched'));
    if (eligible) {
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

  // Invalidate in-memory cache and return fresh dashboard payload
  invalidateDashboardCache();
  return getDashboardData(true);
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
    headers: { 'Authorization': 'Bearer ' + getLineToken_() },
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
        headers: { 'Authorization': 'Bearer ' + getLineToken_() },
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
 * Construct an HTTP request object for LINE Messaging API push endpoint.
 * Suitable for single fetch or parallel UrlFetchApp.fetchAll.
 * @param {string} userId - Short passport-style ID or raw LINE userId
 * @param {Object|string} text - Message payload
 * @returns {Object|null} UrlFetchApp request object or null
 */
function createLinePushRequest(userId, text) {
  if (!userId || userId === 'user' || (typeof userId === 'string' && userId.startsWith('p') && !userId.startsWith('player_U'))) return null;

  var rawLineUserId = (typeof userId === 'string' && (userId.startsWith('U') || userId.startsWith('C') || userId.startsWith('R')))
    ? userId
    : getRawLineUserId(userId);
  if (!rawLineUserId) return null;
  
  var messageObj;
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
  
  return {
    url: 'https://api.line.me/v2/bot/message/push',
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + getLineToken_() },
    payload: JSON.stringify({
      to: rawLineUserId,
      messages: [messageObj]
    }),
    muteHttpExceptions: true
  };
}

/**
 * Push a message to a player's 1-on-1 LINE OA DM (resolves short ID → raw LINE userId).
 * @param {string} userId - Short passport-style ID or raw LINE userId
 * @param {Object|string} text - Message payload
 */
function pushToLine(userId, text) {
  var req = createLinePushRequest(userId, text);
  if (!req) return;
  
  try {
    var res = UrlFetchApp.fetch(req.url, req);
    var code = res.getResponseCode();
    var body = res.getContentText();
    Logger.log('[pushToLine to ' + userId + '] Status: ' + code + ' Body: ' + body);
    if (code !== 200 && typeof text === 'object') {
      var headerStr = (text.header && text.header.contents && text.header.contents[0] && text.header.contents[0].text) || '';
      var fbText = '🚀 ' + headerStr;
      var rawTo = JSON.parse(req.payload).to;
      UrlFetchApp.fetch(req.url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + getLineToken_() },
        payload: JSON.stringify({ to: rawTo, messages: [{ type: 'text', text: fbText }] }),
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

function constructCancelOrderMiniFlex(orderNo) {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#BE123C",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "⛔️ ยกเลิกสำเร็จ ⛔️",
          "weight": "bold",
          "color": "#FFFFFF",
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
      "paddingAll": "sm",
      "spacing": "xs",
      "contents": [
        {
          "type": "text",
          "text": "Order #" + orderNo,
          "weight": "bold",
          "color": "#9F1239",
          "size": "md",
          "align": "center",
          "wrap": true
        }
      ]
    }
  };
}

function constructUnsendAlertFlex(displayName, originalText, orderNo) {
  var contents = [
    {
      "type": "box",
      "layout": "horizontal",
      "contents": [
        { "type": "text", "text": "👤 ผู้ใช้:", "size": "xs", "color": "#64748B", "flex": 2 },
        { "type": "text", "text": "@" + displayName, "size": "xs", "color": "#1E293B", "weight": "bold", "flex": 5, "wrap": true }
      ]
    }
  ];

  if (orderNo) {
    contents.push({
      "type": "box",
      "layout": "horizontal",
      "contents": [
        { "type": "text", "text": "📝 รายการ:", "size": "xs", "color": "#64748B", "flex": 2 },
        { "type": "text", "text": "Order #" + orderNo, "size": "xs", "color": "#DC2626", "weight": "bold", "flex": 5 }
      ]
    });
  }

  if (originalText) {
    contents.push({
      "type": "box",
      "layout": "horizontal",
      "contents": [
        { "type": "text", "text": "💬 ข้อความ:", "size": "xs", "color": "#64748B", "flex": 2 },
        { "type": "text", "text": '"' + originalText + '"', "size": "xs", "color": "#334155", "weight": "bold", "flex": 5, "wrap": true }
      ]
    });
  }

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#DC2626",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "🚨 ตรวจพบการ Unsend ข้อความ",
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
      "backgroundColor": "#FEF2F2",
      "paddingAll": "md",
      "spacing": "xs",
      "contents": [
        {
          "type": "box",
          "layout": "vertical",
          "spacing": "xs",
          "contents": contents
        },
        { "type": "separator", "margin": "sm", "color": "#FECACA" },
        {
          "type": "box",
          "layout": "vertical",
          "margin": "sm",
          "spacing": "xxs",
          "contents": [
            {
              "type": "text",
              "text": "⛔ การ Unsend ไม่มีผลต่อข้อมูลหรือผลเดิมพันในระบบ!",
              "color": "#991B1B",
              "weight": "bold",
              "size": "xs",
              "wrap": true
            },
            {
              "type": "text",
              "text": "💡 ยกเลิกคำสั่งเดิมพันได้ผ่านปุ่ม [⛔ ยกเลิก] บนการ์ด Order เท่านั้น",
              "color": "#475569",
              "size": "xxs",
              "wrap": true
            }
          ]
        }
      ]
    }
  };
}

function constructEditAlertFlex(displayName, originalText, newText, orderNo) {
  var contents = [
    {
      "type": "box",
      "layout": "horizontal",
      "contents": [
        { "type": "text", "text": "👤 ผู้ใช้:", "size": "xs", "color": "#64748B", "flex": 2 },
        { "type": "text", "text": "@" + displayName, "size": "xs", "color": "#1E293B", "weight": "bold", "flex": 5, "wrap": true }
      ]
    }
  ];

  if (orderNo) {
    contents.push({
      "type": "box",
      "layout": "horizontal",
      "contents": [
        { "type": "text", "text": "📝 รายการ:", "size": "xs", "color": "#64748B", "flex": 2 },
        { "type": "text", "text": "Order #" + orderNo, "size": "xs", "color": "#D97706", "weight": "bold", "flex": 5 }
      ]
    });
  }

  if (originalText) {
    contents.push({
      "type": "box",
      "layout": "horizontal",
      "contents": [
        { "type": "text", "text": "❌ เดิม:", "size": "xs", "color": "#94A3B8", "flex": 2 },
        { "type": "text", "text": '"' + originalText + '"', "size": "xs", "color": "#64748B", "decoration": "line-through", "flex": 5, "wrap": true }
      ]
    });
  }

  if (newText) {
    contents.push({
      "type": "box",
      "layout": "horizontal",
      "contents": [
        { "type": "text", "text": "✏️ แก้เป็น:", "size": "xs", "color": "#D97706", "weight": "bold", "flex": 2 },
        { "type": "text", "text": '"' + newText + '"', "size": "xs", "color": "#B45309", "weight": "bold", "flex": 5, "wrap": true }
      ]
    });
  }

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#D97706",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "✏️ ตรวจพบการแก้ไขข้อความ (Edited)",
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
      "backgroundColor": "#FFFBEB",
      "paddingAll": "md",
      "spacing": "xs",
      "contents": [
        {
          "type": "box",
          "layout": "vertical",
          "spacing": "xs",
          "contents": contents
        },
        { "type": "separator", "margin": "sm", "color": "#FDE68A" },
        {
          "type": "box",
          "layout": "vertical",
          "margin": "sm",
          "spacing": "xxs",
          "contents": [
            {
              "type": "text",
              "text": "⛔ การแก้ไขข้อความไม่มีผลต่อข้อมูลหรือคำสั่งเดิมพันในระบบ!",
              "color": "#92400E",
              "weight": "bold",
              "size": "xs",
              "wrap": true
            },
            {
              "type": "text",
              "text": "💡 คำสั่งเดิมพันยึดตามข้อความเริ่มต้น ยกเลิกผ่านปุ่ม [⛔ ยกเลิก] บนการ์ด Order เท่านั้น",
              "color": "#475569",
              "size": "xxs",
              "wrap": true
            }
          ]
        }
      ]
    }
  };
}

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



function constructRuleGuideFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#0A3D34",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "🚀 ROCKET SCIENCE",
          "weight": "bold",
          "color": "#FDE047",
          "size": "xxs",
          "align": "center"
        },
        {
          "type": "text",
          "text": "📖 คู่มือคีย์เวิร์ดกติกาการเล่น",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "sm",
          "align": "center",
          "margin": "xs"
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
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#ECFDF5",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "📌 กฏที่ 1: เล่นราคาช่าง",
              "weight": "bold",
              "color": "#065F46",
              "size": "xs",
              "wrap": true
            },
            {
              "type": "text",
              "text": "🎉 ทายว่าชนะ (สูง):\n• ช่างไล่ / ชล / ไล่ / ลง\n• +5ชล / +5ล / +5ไล่\n• -5ชล / -5ล / -5ไล่\n💵 เช่น ชล100, ชล1000, +5ชล500\n\n👊 ทายว่าแพ้ (ต่ำ):\n• ช่างยั่ง / ช่างถอย / ชย\n• ชถ / ยั่ง / ย / ถอย / ถ\n• +5ชย / +5ชถ / +5ย / +5ถ\n• -5ชย / -5ชถ / -5ย / -5ถ\nเช่น ชถ100, ชถ1000, -5ชถ500",
              "color": "#047857",
              "size": "xxs",
              "wrap": true,
              "margin": "xs"
            }
          ]
        },
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#F0F9FF",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "📌 กฏที่ 2: การเปิดราคาเอง (ช่วงห่าง 50 วิพอดี)",
              "weight": "bold",
              "color": "#0369A1",
              "size": "xs",
              "wrap": true
            },
            {
              "type": "text",
              "text": "💰 เปิดราคาเอง (ช่วงห่าง 50 วิพอดี):\n• 300-350ล500 | 300-350ถ500\n• 350-400ล500 | 350-400ถ500\n\n⬆️ ช่างต่อยยกเลิก (ชตย):\nใส่ ชตย หลังจำนวนเงิน เช่น\n• 300-350ล500 ชตย | 350-400ถ500 ชตย",
              "color": "#0284C7",
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
          "color": "#0A3D34",
          "height": "sm"
        }
      ]
    }
  };
}

var RULE_GUIDE_TEXT = "📖 [คู่มือคีย์เวิร์ดกติกาการเล่น]\n\n" +
  "📌 กฏที่ 1: เล่นราคาช่าง\n\n" +
  "🎉 ทายว่าชนะ (สูง):\n" +
  "• ช่างไล่ / ชล / ไล่ / ลง\n" +
  "• +5ชล / +5ล / +5ไล่\n" +
  "• -5ชล / -5ล / -5ไล่\n" +
  "💵 พิมพ์คีย์เวิร์ดตามด้วยจำนวนเงิน (ตัวเลขเท่านั้น)\n" +
  "เช่น ชล100 , ชล1000 , ชล10000\n\n" +
  "👊 ทายว่าแพ้ (ต่ำ):\n" +
  "• ช่างยั่ง / ช่างถอย / ชย\n" +
  "• ชถ / ยั่ง / ย / ถอย / ถ\n" +
  "• +5ชย / +5ชถ / +5ย / +5ถ\n" +
  "• -5ชย / -5ชถ / -5ย / -5ถ\n" +
  "เช่น ชถ100 , ชถ1000\n\n" +
  "-----------------------------\n\n" +
  "📌 กฏที่ 2: การเปิดราคาเอง (กรณีช่างไม่ต่อย / ต้องมีเครดิตพอ)\n\n" +
  "💰 การเปิดราคาเอง (เปิดแผลสดใหม่):\n" +
  "⚠️ ช่วงราคาต้องห่างกัน 50 วิพอดี เช่น\n" +
  "• 300-350ล500 | 300-350ถ500\n" +
  "• 350-400ล500 | 350-400ถ500\n\n" +
  "⬆️ ช่างต่อยยกเลิก (ชตย)\n" +
  "ใส่ ชตย หลังจำนวนเงิน เช่น\n" +
  "• 300-350ล500 ชตย\n" +
  "• 350-400ถ500 ชตย";

function constructBetOpenFlex(orderNo, amount, side, creatorName, rangeInfo, isChotoy, userTypedCmd, isPreQuote) {
  var sideShort = side === 'low' ? 'ล' : 'ถ';
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
        { "type": "text", "text": item.label, "color": "#0369A1", "weight": "bold", "size": "xs", "align": "center", "wrap": true }
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
        { "type": "text", "text": amt100.toString(), "color": "#15803D", "weight": "bold", "size": "xs", "align": "center", "wrap": true }
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
        { "type": "text", "text": "⛔ ยกเลิก", "color": "#9F1239", "weight": "bold", "size": "xs", "align": "center", "wrap": true }
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
      "margin": "xs",
      "wrap": true
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
          "align": "center",
          "wrap": true
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
      "backgroundColor": "#059669",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "🚀 แมตช์สำเร็จ #" + orderNo,
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "sm",
          "align": "center",
          "wrap": true
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
          "align": "center",
          "wrap": true
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
            { "type": "text", "text": "🔻 ต่ำ (Low):", "color": "#DC2626", "size": "xs", "weight": "bold", "flex": 4, "wrap": true },
            { "type": "text", "text": "@" + lowText, "color": "#1E293B", "size": "xs", "weight": "bold", "flex": 6, "align": "end", "wrap": true }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "🔺 สูง (High):", "color": "#16A34A", "size": "xs", "weight": "bold", "flex": 4, "wrap": true },
            { "type": "text", "text": "@" + highText, "color": "#1E293B", "size": "xs", "weight": "bold", "flex": 6, "align": "end", "wrap": true }
          ]
        },
        ...(rangeInfo ? [{
          "type": "text",
          "text": "ช่วงราคา: " + rangeInfo,
          "color": "#64748B",
          "size": "xxs",
          "align": "center",
          "margin": "sm",
          "wrap": true
        }] : [])
      ]
    }
  };
}

function constructPendingBetsFlex(pendingList) {
  if (!pendingList || pendingList.length === 0) {
    return {
      "type": "bubble",
      "size": "kilo",
      "header": {
        "type": "box",
        "layout": "vertical",
        "backgroundColor": "#0F172A",
        "paddingAll": "md",
        "contents": [
          {
            "type": "box",
            "layout": "horizontal",
            "contents": [
              {
                "type": "text",
                "text": "📊 กระดานดวลสด",
                "weight": "bold",
                "color": "#FFFFFF",
                "size": "sm",
                "flex": 1
              },
              {
                "type": "box",
                "layout": "vertical",
                "backgroundColor": "#334155",
                "cornerRadius": "sm",
                "paddingStart": "6px",
                "paddingEnd": "6px",
                "paddingTop": "2px",
                "paddingBottom": "2px",
                "contents": [
                  { "type": "text", "text": "ว่าง 0 แผล", "color": "#94A3B8", "size": "xxs", "weight": "bold" }
                ]
              }
            ]
          }
        ]
      },
      "body": {
        "type": "box",
        "layout": "vertical",
        "paddingAll": "lg",
        "spacing": "sm",
        "contents": [
          {
            "type": "text",
            "text": "ไม่มีแผลดวลค้างในขณะนี้ 🚀",
            "weight": "bold",
            "color": "#334155",
            "size": "sm",
            "align": "center"
          },
          {
            "type": "text",
            "text": "ท่านสามารถพิมพ์ ชล หรือ ชถ เพื่อเปิดแผลดวลใหม่ได้ทันทีครับ",
            "color": "#64748B",
            "size": "xs",
            "align": "center",
            "wrap": true
          }
        ]
      },
      "footer": {
        "type": "box",
        "layout": "horizontal",
        "spacing": "xs",
        "paddingAll": "sm",
        "contents": [
          {
            "type": "button",
            "style": "secondary",
            "height": "sm",
            "color": "#F1F5F9",
            "action": {
              "type": "message",
              "label": "📖 ดูกติกา",
              "text": "กติกา"
            }
          },
          {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "color": "#0D9488",
            "action": {
              "type": "message",
              "label": "⚡ เปิดราคาช่าง",
              "text": "ชล500"
            }
          }
        ]
      }
    };
  }

  var displayItems = pendingList.slice(0, 8);
  var itemBoxes = displayItems.map(function(b) {
    var creatorName = b.playerLowName || b.playerHighName || 'ผู้เล่น';
    var isLow = Boolean(b.playerLowId);
    var sideText = isLow ? '🔻 ต่ำ' : '🔺 สูง';
    var sideColor = isLow ? '#DC2626' : '#16A34A';
    var sideBg = isLow ? '#FEF2F2' : '#F0FDF4';
    var sideBorder = isLow ? '#FECACA' : '#BBF7D0';
    
    var rangeText = (b.rangeMin && b.rangeMax) 
      ? (b.rangeMin + '-' + b.rangeMax + 's') 
      : (b.type === 'pre_quote' ? 'รอราคาช่าง' : '');
    var shortCode = b.orderNumber.toString().slice(-2);
    var amtStr = Number(b.amount || 0).toLocaleString('th-TH');

    return {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": sideBg,
      "borderColor": sideBorder,
      "borderWidth": "1px",
      "cornerRadius": "md",
      "paddingAll": "sm",
      "spacing": "xs",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": '#' + b.orderNumber + ' (' + shortCode + ')',
              "weight": "bold",
              "color": "#0F172A",
              "size": "xs",
              "flex": 5
            },
            {
              "type": "text",
              "text": '👤 @' + creatorName,
              "weight": "bold",
              "color": "#475569",
              "size": "xxs",
              "align": "end",
              "flex": 5,
              "wrap": true
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": sideText + ' ' + rangeText,
              "weight": "bold",
              "color": sideColor,
              "size": "xs",
              "flex": 6
            },
            {
              "type": "text",
              "text": amtStr + ' pt',
              "weight": "bold",
              "color": "#0284C7",
              "size": "xs",
              "align": "end",
              "flex": 4
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
              "type": "box",
              "layout": "vertical",
              "backgroundColor": isLow ? "#16A34A" : "#DC2626",
              "cornerRadius": "sm",
              "paddingTop": "4px",
              "paddingBottom": "4px",
              "flex": 1,
              "action": {
                "type": "message",
                "label": 'ต' + shortCode,
                "text": 'ต' + shortCode
              },
              "contents": [
                {
                  "type": "text",
                  "text": '⚡ รับดวล (ต' + shortCode + ')',
                  "color": "#FFFFFF",
                  "weight": "bold",
                  "size": "xxs",
                  "align": "center"
                }
              ]
            }
          ]
        }
      ]
    };
  });

  var overflowNotice = pendingList.length > 8 ? [
    {
      "type": "text",
      "text": '... และอีก ' + (pendingList.length - 8) + ' แผลดวล',
      "size": "xxs",
      "color": "#94A3B8",
      "align": "center",
      "margin": "xs"
    }
  ] : [];

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#0F172A",
      "paddingAll": "md",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "📊 กระดานดวลสด",
              "weight": "bold",
              "color": "#FFFFFF",
              "size": "sm",
              "flex": 1
            },
            {
              "type": "box",
              "layout": "vertical",
              "backgroundColor": "#059669",
              "cornerRadius": "sm",
              "paddingStart": "8px",
              "paddingEnd": "8px",
              "paddingTop": "2px",
              "paddingBottom": "2px",
              "contents": [
                { "type": "text", "text": 'รอคู่ ' + pendingList.length + ' แผล', "color": "#FFFFFF", "size": "xxs", "weight": "bold" }
              ]
            }
          ]
        },
        {
          "type": "text",
          "text": "แตะปุ่มเพื่อรับดวล หรือพิมพ์ ต[เลข] ได้ทันที 🚀",
          "color": "#94A3B8",
          "size": "xxs",
          "margin": "xs"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": itemBoxes.concat(overflowNotice)
    },
    "footer": {
      "type": "box",
      "layout": "horizontal",
      "spacing": "xs",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "color": "#F1F5F9",
          "action": {
            "type": "message",
            "label": "🔄 รีเฟรช",
            "text": "กระดานดวล"
          }
        },
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "color": "#F1F5F9",
          "action": {
            "type": "message",
            "label": "📖 กติกา",
            "text": "กติกา"
          }
        }
      ]
    }
  };
}

function constructRoundSummaryFlex(finalTime, targetMin, targetMax, rocketName) {
  var isLowWin = finalTime < targetMin;
  var isHighWin = finalTime > targetMax;
  var outcomeTitle = isLowWin ? "🔻 ฝั่งต่ำ (ชถ/ชย)" : (isHighWin ? "🔺 ฝั่งสูง (ชล/ไล่)" : "🎯 ในราคาช่าง (คืนแต้ม)");
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

function getChatLogSheet() {
  if (_memChatLogSheet) return _memChatLogSheet;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName('LineChatLogs');
    if (!sheet) {
      sheet = ss.insertSheet('LineChatLogs');
      sheet.appendRow(['Timestamp', 'User ID', 'Display Name', 'Sender', 'Message Text', 'Message Type']);
    }
    _memChatLogSheet = sheet;
    return _memChatLogSheet;
  } catch (err) {
    return null;
  }
}

function logLineChatMessage(userId, displayName, sender, messageText, messageType) {
  try {
    const sheet = getChatLogSheet();
    if (!sheet) return;
    
    let actualDisplayName = displayName;
    if (sender === 'admin' || sender === 'bot') {
      actualDisplayName = getPlayerNameFromDb(userId) || displayName;
    }
    
    sheet.appendRow([new Date(), userId, actualDisplayName, sender, messageText, messageType || 'text']);
  } catch (err) {
    console.error("Error logging LINE chat message: " + err.toString());
  }
}

function batchLogLineChatMessages(logs) {
  if (!logs || logs.length === 0) return;
  try {
    const sheet = getChatLogSheet();
    if (!sheet) return;
    const rows = [];
    const now = new Date();
    for (let i = 0; i < logs.length; i++) {
      const item = logs[i];
      let actualDisplayName = item.displayName;
      if (item.sender === 'admin' || item.sender === 'bot') {
        actualDisplayName = getPlayerNameFromDb(item.userId) || item.displayName;
      }
      rows.push([now, item.userId, actualDisplayName, item.sender, item.text, item.type || 'text']);
    }
    if (rows.length > 0) {
      const lastRow = sheet.getLastRow();
      sheet.getRange(lastRow + 1, 1, rows.length, 6).setValues(rows);
    }
  } catch (err) {
    console.error("Error batch logging LINE chat messages: " + err.toString());
  }
}

function getPlayerNameFromDb(userId) {
  if (!userId) return null;
  var cleanId = cleanUserId(userId);
  if (_memUserCache['NAME_' + cleanId]) {
    return _memUserCache['NAME_' + cleanId] === '__NONE__' ? null : _memUserCache['NAME_' + cleanId];
  }
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get('PLAYER_NAME_' + cleanId);
    if (cached) {
      _memUserCache['NAME_' + cleanId] = cached;
      return cached === '__NONE__' ? null : cached;
    }
  } catch(_) {}
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Players');
    if (!sheet) return null;
    const data = sheet.getDataRange().getValues();
    const searchId = cleanId;
    for (let i = 1; i < data.length; i++) {
      const rowId = data[i][0] ? data[i][0].toString().trim() : '';
      const rowLineId = data[i][7] ? data[i][7].toString().trim() : '';
      if (rowId === searchId || rowLineId === searchId) {
        var name = data[i][1] ? data[i][1].toString() : '';
        if (name) {
          _memUserCache['NAME_' + cleanId] = name;
          try { cache.put('PLAYER_NAME_' + cleanId, name, 21600); } catch(_) {}
        }
        return name;
      }
    }
  } catch (e) {
    console.error("Error in getPlayerNameFromDb: " + e.toString());
  }
  _memUserCache['NAME_' + cleanId] = '__NONE__';
  try { cache.put('PLAYER_NAME_' + cleanId, '__NONE__', 300); } catch(_) {}
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
  var numMin = Number(minVal) || 330;
  var numMax = Number(maxVal) || 380;
  var roundName = (name && name.trim()) ? name.trim() : 'ช่างบั้งไฟสด';
  var chotoyBool = (isChotoy === true || isChotoy === 'true');

  setActiveRocketRound(roundName, numMin, numMax, chotoyBool);
  adminOpenRound(roundName);

  var quoteFlex = {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#BAE6FD",
      "paddingAll": "md",
      "contents": [
        { "type": "text", "text": "\uD83D\uDE80 ราคาช่างเปิด \u27A1 " + roundName, "weight": "bold", "color": "#0369A1", "size": "sm", "align": "center", "wrap": true }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#F0F9FF",
      "spacing": "sm",
      "paddingAll": "md",
      "contents": [
        { "type": "text", "text": "\u23F1\uFE0F ช่วงราคา: " + numMin + "-" + numMax + " วิ" + (chotoyBool ? " (ชตย)" : ""), "weight": "bold", "color": "#0284C7", "size": "sm", "align": "center", "wrap": true },
        { "type": "text", "text": "\u26A1 พิมพ์ ชล / ชถ (\u00B15, \u00B110) ได้ทันที", "color": "#64748B", "size": "xs", "align": "center", "wrap": true }
      ]
    }
  };
  return sendAdminMessageToLine(targetId || 'ALL', quoteFlex);
}

function constructFinalCallFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#BE123C",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "⛔️ ปิดรับดวล ⛔️",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md",
          "align": "center",
          "wrap": true
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#FFF1F2",
      "spacing": "xs",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "ออเดอร์หลังจากนี้ไม่ติดทุกกรณี",
          "weight": "bold",
          "color": "#9F1239",
          "size": "sm",
          "align": "center",
          "wrap": true
        }
      ]
    }
  };
}

function adminBroadcastFinalCall(targetId) {
  setRocketRoundStatus('CLOSED');
  var closeFlex = constructFinalCallFlex();
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
  return sendAdminMessageToLine(targetId || 'ALL', RULE_GUIDE_TEXT);
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

    var messageObj;
    if (isObj) {
      var alt = (messageText.header && messageText.header.contents && messageText.header.contents[0] && messageText.header.contents[0].text)
        ? messageText.header.contents[0].text
        : 'ระบบบริการ Rocket Science 🚀';
      messageObj = { type: 'flex', altText: alt, contents: messageText };
    } else {
      messageObj = { type: 'text', text: String(messageText) };
    }

    // 🚀 HIGH-SPEED: Parallelize all group pushes using UrlFetchApp.fetchAll
    var requests = [];
    for (var k = 0; k < keys.length; k++) {
      requests.push({
        url: 'https://api.line.me/v2/bot/message/push',
        method: 'post',
        contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + getLineToken_() },
        payload: JSON.stringify({ to: keys[k], messages: [messageObj] }),
        muteHttpExceptions: true
      });
    }

    var responses = UrlFetchApp.fetchAll(requests);
    var sendResults = [];
    for (var k = 0; k < responses.length; k++) {
      var code = responses[k].getResponseCode();
      sendResults.push({ success: code === 200, code: code, groupId: keys[k] });
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
      "backgroundColor": "#BE123C",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "⛔️ ปิดรับดวล ⛔️",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md",
          "align": "center",
          "wrap": true
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#FFF1F2",
      "spacing": "xs",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "ออเดอร์หลังจากนี้ไม่ติดทุกกรณี",
          "weight": "bold",
          "color": "#9F1239",
          "size": "sm",
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
 * @returns {{ name: string, targetMin: number, targetMax: number, isChotoy: boolean, status: string }}
 */
function getActiveRocketRound() {
  var props = PropertiesService.getScriptProperties();
  var roundJson = props.getProperty('ACTIVE_ROUND_DATA');
  if (roundJson) {
    try {
      var parsed = JSON.parse(roundJson);
      if (parsed && parsed.name && parsed.targetMin && parsed.targetMax) {
        return parsed;
      }
    } catch(_) {}
  }
  var name = props.getProperty('ACTIVE_ROCKET_NAME') || props.getProperty('ROCKET_NAME') || 'ช่างบั้งไฟสด';
  var minVal = Number(props.getProperty('TARGET_MIN')) || 330;
  var maxVal = Number(props.getProperty('TARGET_MAX')) || 380;
  var isChotoy = props.getProperty('ACTIVE_IS_CHOTOY') === 'true';
  var status = props.getProperty('ROUND_STATUS') || 'ACTIVE';
  return {
    name: name,
    targetMin: minVal,
    targetMax: maxVal,
    isChotoy: isChotoy,
    status: status
  };
}

/**
 * Set the active round details and target min/max in script properties.
 * Overwrites any legacy keys (like ACTIVE_MIN/ACTIVE_MAX) so old centisecond 800/880 values can never persist.
 */
function setActiveRocketRound(name, minVal, maxVal, isChotoy) {
  var props = PropertiesService.getScriptProperties();
  var roundName = (name && name.trim()) ? name.trim() : 'ช่างบั้งไฟสด';
  var numMin = Number(minVal) || 330;
  var numMax = Number(maxVal) || 380;
  var chotoyBool = (isChotoy === true || isChotoy === 'true');

  var roundData = {
    name: roundName,
    targetMin: numMin,
    targetMax: numMax,
    isChotoy: chotoyBool,
    status: 'ACTIVE',
    openedAt: new Date().toISOString()
  };

  props.setProperties({
    'ACTIVE_ROUND_DATA': JSON.stringify(roundData),
    'ACTIVE_ROCKET_NAME': roundName,
    'ROCKET_NAME': roundName,
    'TARGET_MIN': String(numMin),
    'TARGET_MAX': String(numMax),
    'ACTIVE_MIN': String(numMin),
    'ACTIVE_MAX': String(numMax),
    'ACTIVE_IS_CHOTOY': String(chotoyBool),
    'ROUND_STATUS': 'ACTIVE'
  });

  Logger.log('[ROUND] Set active round: ' + roundName + ' (' + numMin + '-' + numMax + 's, chotoy=' + chotoyBool + ')');
  return roundData;
}

/**
 * Set the active target min/max range in script properties.
 */
function setTargetMinMax(minVal, maxVal) {
  var cur = getActiveRocketRound();
  return setActiveRocketRound(cur.name, minVal, maxVal, cur.isChotoy);
}

/**
 * Fetch real-time LINE OA message quota and monthly consumption status
 */
function adminGetLineQuota() {
  try {
    var headers = { 'Authorization': 'Bearer ' + getLineToken_() };
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
