import {
  batchFetchSheets,
  appendRowToSheet,
  updateRowInSheet,
  overwriteSheet,
  queueWrite,
  invalidateSheetsCache,
  isWriteQueueBusy,
  flushWriteQueue,
} from './sheetsHelper.js';

let players = [];
let transactions = [];
let bets = [];
let chatLogs = [];

/** Serialize credit/bet mutations across concurrent webhook handlers */
let mutationLock = Promise.resolve();
function withMutationLock(fn) {
  const run = mutationLock.then(() => fn(), () => fn());
  mutationLock = run.then(() => undefined, () => undefined);
  return run;
}

export function generateUniqueOrderNumber() {
  let orderNo;
  let tries = 0;
  do {
    orderNo = Math.floor(Math.random() * 900000 + 100000);
    tries++;
  } while (tries < 50 && bets.some((b) => String(b.orderNumber) === String(orderNo)));
  return orderNo;
}

let activeTargetMin = null;
let activeTargetMax = null;

export function setTargetMinMax(minVal, maxVal) {
  if (minVal && maxVal && Number(minVal) < Number(maxVal)) {
    activeTargetMin = Number(minVal);
    activeTargetMax = Number(maxVal);
    if (activeRocketRound) {
      activeRocketRound.targetMin = activeTargetMin;
      activeRocketRound.targetMax = activeTargetMax;
    }
    applyQuoteToPreQuoteBets(activeTargetMin, activeTargetMax);
  }
}

export function getTargetMin() {
  return activeTargetMin || activeRocketRound?.targetMin || null;
}

export function getTargetMax() {
  return activeTargetMax || activeRocketRound?.targetMax || null;
}

// Applies official quote range (minVal, maxVal) to all pending pre_quote bets in current round
export function applyQuoteToPreQuoteBets(minVal, maxVal) {
  if (!minVal || !maxVal) return;
  const numMin = Number(minVal);
  const numMax = Number(maxVal);

  const updatedBets = [];
  bets.forEach(bet => {
    if (bet.type === 'pre_quote') {
      bet.type = 'range';
      let offsetMin = numMin;
      let offsetMax = numMax;

      if (bet.userTypedCmd) {
        if (bet.userTypedCmd.startsWith('+10')) {
          offsetMin += 10;
          offsetMax += 10;
        } else if (bet.userTypedCmd.startsWith('-10')) {
          offsetMin -= 10;
          offsetMax -= 10;
        } else if (bet.userTypedCmd.startsWith('+5')) {
          offsetMin += 5;
          offsetMax += 5;
        } else if (bet.userTypedCmd.startsWith('-5')) {
          offsetMin -= 5;
          offsetMax -= 5;
        }
      }

      bet.rangeMin = offsetMin;
      bet.rangeMax = offsetMax;

      if (bet.status === 'pre_quote_matched') {
        bet.status = 'matched';
        updatedBets.push(bet);
      } else if (bet.status === 'pending_match') {
        bet.status = 'open';
      }
      updateRowInSheet('Bets', bet.orderNumber, {
        6: 'range',
        7: offsetMin.toString(),
        8: offsetMax.toString(),
        9: bet.status
      });
    }
  });

  // Notify players about officially matched orders
  if (updatedBets.length > 0) {
    import('./lineBot.js').then(lineBot => {
      updatedBets.forEach(b => {
        const creatorId = b.playerLowId || b.playerHighId;
        const matcherId = b.playerLowId ? b.playerHighId : b.playerLowId;
        const rangeStr = `${b.rangeMin}-${b.rangeMax}s`;
        const flex = lineBot.constructMatchNotificationFlex(b.orderNumber, b.amount, b.playerLowName, b.playerHighName, rangeStr, false, activeRocketRound?.name);

        if (b.groupId) lineBot.pushToLine(b.groupId, `☄️ [แผล #${b.orderNumber} ได้รับราคาช่างและแมตช์สัญญาสมบูรณ์!] @${b.playerLowName} (ต่ำ) 🆚 @${b.playerHighName} (สูง) | ${b.amount}pt 🚀`);
        if (creatorId) lineBot.pushToLine(creatorId, flex);
        if (matcherId) lineBot.pushToLine(matcherId, flex);
      });
    }).catch(err => console.error('Error sending quote confirmation push:', err));
  }
}

// Cancels all unquoted pre_quote bets if round closes without admin quote
export function cancelUnquotedPreQuoteBets() {
  const cancelledBets = [];
  bets.forEach(bet => {
    if (bet.type === 'pre_quote' && (bet.status === 'pending_match' || bet.status === 'pre_quote_matched')) {
      const priorStatus = bet.status;
      bet.status = 'cancelled';
      cancelledBets.push(bet);

      // Refund creator
      const creatorId = bet.playerLowId || bet.playerHighId;
      if (creatorId) adjustPlayerBalance(creatorId, bet.amount, 'Refund unquoted bet');

      // Refund matcher if pre_quote_matched
      if (priorStatus === 'pre_quote_matched') {
        const matcherId = bet.playerLowId ? bet.playerHighId : bet.playerLowId;
        if (matcherId) adjustPlayerBalance(matcherId, bet.amount, 'Refund unquoted bet');
      }

      updateRowInSheet('Bets', bet.orderNumber, { 9: 'cancelled' });
    }
  });

  if (cancelledBets.length > 0) {
    import('./lineBot.js').then(lineBot => {
      cancelledBets.forEach(b => {
        if (b.groupId) lineBot.pushToLine(b.groupId, `⚠️ แผล Order #${b.orderNumber} ถูกยกเลิกและคืนเครดิตเรียบร้อยแล้ว (เนื่องจากรอบนี้ไม่มีการเปิดราคาช่าง)`);
      });
    }).catch(err => console.error('Error pushing pre_quote cancellation:', err));
  }
}

// Helper to format dates to dd/MM/yy for visual consistency with GAS
function formatDate(dateVal) {
  if (!dateVal) return '-';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return '-';
  // Adjust to GMT+7 timezone
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const nd = new Date(utc + 3600000 * 7);

  const dd = String(nd.getDate()).padStart(2, '0');
  const mm = String(nd.getMonth() + 1).padStart(2, '0');
  const yy = String(nd.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// Helper to format timestamps to HH:mm:ss for visual consistency with GAS
function formatTime(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return '';
  // Adjust to GMT+7 timezone
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const nd = new Date(utc + 3600000 * 7);

  const hh = String(nd.getHours()).padStart(2, '0');
  const mm = String(nd.getMinutes()).padStart(2, '0');
  const ss = String(nd.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// Helper to format bank account numbers (keep leading zeros)
export function formatBankAccount(acc) {
  if (acc === null || acc === undefined) return '';
  let str = acc.toString().trim();
  if (/^\d+$/.test(str) && !str.startsWith('0')) {
    if (str.length === 9 || str.length === 11 || str.length === 14) {
      str = '0' + str;
    }
  }
  return str;
}

// Helper to clean and normalize User ID
export function cleanUserId(userId) {
  if (userId === null || userId === undefined) return '';
  const id = userId.toString().trim();
  return id.toLowerCase() === 'user' ? 'user' : id;
}

// Initialize and pull all data from Google Sheets into memory
export async function init(isSilent = false, forceRefresh = false) {
  try {
    // Do not clobber live memory while Sheet writes are still in flight
    if (forceRefresh && isWriteQueueBusy()) {
      if (!isSilent) {
        console.warn('[DB] Skipping Sheets sync — write queue still busy');
      }
      return;
    }
    if (forceRefresh) {
      await flushWriteQueue();
    }

    const data = await batchFetchSheets({ force: forceRefresh });

    // 1. Players Sheet (Reset if empty/factory reset)
    if (data.players && data.players.length > 1) {
      players = data.players.slice(1).map((row, idx) => {
        const avatars = ['🐉', '🐯', '🦅', '🦁', '🐻', '🐼', '🦊', '🦉'];
        return {
          id: row[0]?.toString() || '',
          name: row[1]?.toString() || '',
          balance: Number(row[2]) || 0,
          joinDate: row[3] ? formatDate(row[3]) : '-',
          bankName: row[4]?.toString() || '',
          bankAccount: row[5] ? formatBankAccount(row[5]) : '',
          accountName: row[6]?.toString() || '',
          isUser: row[0]?.toString() === 'user',
          avatar: avatars[(idx + 1) % avatars.length],
          lineUserId: row[7]?.toString() || '',
        };
      });
    } else if (data.players) {
      players = [];
    }

    // 2. Transactions Sheet
    if (data.transactions && data.transactions.length > 1) {
      transactions = data.transactions.slice(1).map((row) => {
        let rawId = row[0]?.toString() || '';
        const refStr = row[5]?.toString().toUpperCase() || '';
        const reasonStr = row[7]?.toString().toLowerCase() || '';
        if (refStr.includes('WD') || refStr.includes('WITHDRAW') || reasonStr.includes('withdraw')) {
          if (rawId.startsWith('TX')) {
            rawId = 'WD' + rawId.slice(2);
          }
        }
        return {
          id: rawId,
          playerId: row[1]?.toString() || '',
          playerName: row[2]?.toString() || '',
          requestedAmount: Number(row[3]) || 0,
          actualAmount: Number(row[4]) || 0,
          slipRef: row[5]?.toString() || '',
          status: row[6]?.toString() || '',
          reviewReason: row[7]?.toString() || '',
          timestamp: row[8] ? formatTime(row[8]) : '',
          logs: [`Verified in Sheets Database`, `Status: ${row[6]}`],
        };
      }).reverse();
    } else if (data.transactions) {
      transactions = [];
    }

    // 3. Bets Sheet — columns aligned with GAS:
    // A order, B-E players, F amount, G type, H-I range, J status, K winner,
    // L timestamp, M groupId, N groupName, O messageId
    if (data.bets && data.bets.length > 1) {
      bets = data.bets.slice(1).map((row) => {
        const col11 = row[11]?.toString() || '';
        const col12 = row[12]?.toString() || '';
        const col13 = row[13]?.toString() || '';
        const col14 = row[14]?.toString() || '';
        // Backward compatible: older Node rows wrote groupId at L (no timestamp)
        const looksLikeGroupId = (v) => /^C[a-zA-Z0-9_-]{8,}$/.test(String(v || ''));
        let timestamp = '';
        let groupId = '';
        let groupName = '';
        let messageId = '';
        if (looksLikeGroupId(col11)) {
          groupId = col11;
          groupName = col12;
          messageId = col13;
        } else {
          timestamp = col11 ? formatTime(row[11]) : '';
          groupId = col12;
          groupName = col13;
          messageId = col14;
        }
        return {
          id: 'bet_' + row[0]?.toString(),
          orderNumber: row[0]?.toString() || '',
          playerLowId: row[1]?.toString() || '',
          playerLowName: row[2]?.toString() || '',
          playerHighId: row[3]?.toString() || '',
          playerHighName: row[4]?.toString() || '',
          amount: Number(row[5]) || 0,
          type: row[6]?.toString() || '',
          rangeMin: row[7] ? Number(row[7]) : null,
          rangeMax: row[8] ? Number(row[8]) : null,
          status: row[9]?.toString() || '',
          winnerName: row[10]?.toString() || '',
          timestamp,
          groupId,
          groupName,
          messageId,
        };
      });
    } else if (data.bets) {
      bets = [];
    }

    // 4. LineChatLogs Sheet
    if (data.chatLogs && data.chatLogs.length > 1) {
      chatLogs = data.chatLogs.slice(1).map((row) => ({
        timestamp: row[0] ? formatTime(row[0]) : '',
        userId: row[1]?.toString() || '',
        displayName: row[2]?.toString() || '',
        sender: row[3]?.toString() || '',
        text: row[4]?.toString() || '',
        type: row[5]?.toString() || 'text',
      }));
    } else if (data.chatLogs) {
      chatLogs = [];
    }

    // 5. Rebuild LINE group registry from LineGroups sheet + bets (survives Render restarts)
    hydrateLineGroupsFromSources(data.lineGroups || []);

    if (!isSilent) {
      console.log(
        `[DB] Initialized: ${players.length} players, ${transactions.length} transactions, ${bets.length} bets, ${chatLogs.length} chat logs, ${lineGroups.length} line groups.`
      );
    }
  } catch (err) {
    if (!isSilent) {
      console.error('[DB] Initialization error:', err);
    }
    throw err;
  }
}

let activeGroupId = null;
let lineGroups = [];

function looksLikeLineGroupId(v) {
  const s = String(v || '').trim();
  return /^(C|R)[a-zA-Z0-9_-]{8,}$/.test(s);
}

function upsertLineGroupMemory(groupId, groupName, text = 'เชื่อมต่อแล้ว') {
  const gid = String(groupId || '').trim();
  if (!looksLikeLineGroupId(gid)) return null;
  const nowStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  let group = lineGroups.find((g) => g.id === gid);
  const groupNumber = group ? lineGroups.indexOf(group) + 1 : lineGroups.length + 1;
  let cleanName = (groupName && String(groupName).trim()) || '';
  if (!cleanName || looksLikeLineGroupId(cleanName) || cleanName.includes(gid)) {
    cleanName = group?.name && !looksLikeLineGroupId(group.name)
      ? group.name
      : `🚀 กลุ่มดวลสด #${groupNumber}`;
  }
  if (!group) {
    group = {
      id: gid,
      name: cleanName,
      lastMessage: text || 'มีการเคลื่อนไหวในกลุ่ม',
      timestamp: nowStr,
      msgCount: 1,
    };
    lineGroups.push(group);
  } else {
    if (cleanName) group.name = cleanName;
    group.lastMessage = text || group.lastMessage;
    group.timestamp = nowStr;
    group.msgCount = (group.msgCount || 0) + 1;
  }
  if (!activeGroupId) activeGroupId = gid;
  return group;
}

export const DEAD_GROUP_IDS = new Set([
  'Cecd8e08a64397683d85ca9dd72acf1a6',
  'C12345678901234567890123456789012',
]);

export function markGroupDead(groupId) {
  if (!groupId) return;
  DEAD_GROUP_IDS.add(groupId);
  const idx = lineGroups.findIndex((g) => g.id === groupId);
  if (idx !== -1) {
    console.log(`[DB] Pruning dead group ${groupId} (${lineGroups[idx].name})`);
    lineGroups.splice(idx, 1);
  }
  if (activeGroupId === groupId) {
    const best = lineGroups.find((g) => !DEAD_GROUP_IDS.has(g.id) && (g.msgCount || 0) > 0) || lineGroups[0];
    activeGroupId = best ? best.id : null;
    console.log(`[DB] Active group reset from dead group ${groupId} to ${activeGroupId}`);
  }
}

function hydrateLineGroupsFromSources(lineGroupsSheetRows = []) {
  const discovered = new Map();

  // From dedicated LineGroups sheet
  if (Array.isArray(lineGroupsSheetRows) && lineGroupsSheetRows.length > 1) {
    for (let i = 1; i < lineGroupsSheetRows.length; i++) {
      const row = lineGroupsSheetRows[i] || [];
      const gid = String(row[0] || '').trim();
      if (!looksLikeLineGroupId(gid) || DEAD_GROUP_IDS.has(gid)) continue;
      discovered.set(gid, {
        id: gid,
        name: String(row[1] || '').trim() || `🚀 กลุ่มดวลสด #${discovered.size + 1}`,
        lastMessage: String(row[4] || 'จาก LineGroups sheet').trim(),
        timestamp: row[2] ? formatTime(row[2]) : '',
        msgCount: Number(row[3]) || 1,
        source: 'LineGroups sheet',
      });
    }
  }

  // From bets.groupId / groupName
  for (const b of bets) {
    const gid = String(b.groupId || '').trim();
    if (!looksLikeLineGroupId(gid) || DEAD_GROUP_IDS.has(gid)) continue;
    if (!discovered.has(gid)) {
      discovered.set(gid, {
        id: gid,
        name: String(b.groupName || '').trim() || `🚀 กลุ่มดวลสด #${discovered.size + 1}`,
        lastMessage: `จาก Bets #${b.orderNumber || ''}`,
        timestamp: b.timestamp || '',
        msgCount: 1,
        source: 'Bets sheet',
      });
    }
  }

  // From chat logs where userId is actually a group/room id
  for (const log of chatLogs) {
    const gid = String(log.userId || '').trim();
    if (!looksLikeLineGroupId(gid) || DEAD_GROUP_IDS.has(gid)) continue;
    if (!discovered.has(gid)) {
      discovered.set(gid, {
        id: gid,
        name: `🚀 กลุ่มดวลสด #${discovered.size + 1}`,
        lastMessage: String(log.text || 'จาก LineChatLogs').slice(0, 80),
        timestamp: log.timestamp || '',
        msgCount: 1,
        source: 'LineChatLogs',
      });
    }
  }

  // Merge into memory without wiping manually-added live groups that aren't in sheets yet
  for (const g of discovered.values()) {
    if (DEAD_GROUP_IDS.has(g.id)) continue;
    const existing = lineGroups.find((x) => x.id === g.id);
    if (!existing) {
      lineGroups.push({
        id: g.id,
        name: g.name,
        lastMessage: g.lastMessage,
        timestamp: g.timestamp,
        msgCount: g.msgCount,
      });
    } else if ((!existing.name || looksLikeLineGroupId(existing.name)) && g.name) {
      existing.name = g.name;
    }
  }

  // Prune any dead groups that might have leaked into lineGroups
  for (let i = lineGroups.length - 1; i >= 0; i--) {
    if (DEAD_GROUP_IDS.has(lineGroups[i].id)) {
      lineGroups.splice(i, 1);
    }
  }

  // Sort lineGroups so the most active group (highest msgCount) is at the top
  lineGroups.sort((a, b) => (b.msgCount || 0) - (a.msgCount || 0));

  // If activeGroupId is missing, dead, or not in lineGroups, set to the most active valid group
  if (!activeGroupId || DEAD_GROUP_IDS.has(activeGroupId) || !lineGroups.some((g) => g.id === activeGroupId)) {
    const bestGroup = lineGroups.find((g) => !DEAD_GROUP_IDS.has(g.id) && (g.msgCount || 0) > 0) || lineGroups[0];
    if (bestGroup) {
      activeGroupId = bestGroup.id;
    }
  }
}

function persistLineGroupToSheet(group) {
  if (!group?.id) return;
  // Fire-and-forget: update existing LineGroups row, or append a new one
  (async () => {
    try {
      // Probe whether the ID already exists via update path
      const before = lineGroups.find((g) => g.id === group.id);
      // Prefer append for first-time groups; updateRowInSheet no-ops when missing
      await updateRowInSheet('LineGroups', group.id, {
        2: group.name || '',
        3: new Date().toISOString(),
        4: String(group.msgCount || 1),
        5: String(group.lastMessage || '').slice(0, 100),
      });
      // If sheet has no row yet, append (updateRowInSheet logs warn and returns)
      appendRowToSheet('LineGroups', [
        group.id,
        group.name || '',
        new Date().toISOString(),
        group.msgCount || 1,
        String(group.lastMessage || '').slice(0, 100),
      ]);
      // Avoid double-write noise: only append when update couldn't find the row.
      // Re-check: getRowIndex is internal; instead only append when group was newly created.
      void before;
    } catch (e) {
      console.warn('[DB] persistLineGroupToSheet failed:', e?.message || e);
    }
  })();
}

export async function recordGroupActivity(groupId, groupName, userId, displayName, text, { persist = true } = {}) {
  if (!groupId || typeof groupId !== 'string' || groupId.length <= 5) return null;
  const gid = groupId.trim();
  activeGroupId = gid;
  const existingIdx = lineGroups.findIndex((g) => g.id === gid);
  const groupNumber = existingIdx !== -1 ? (existingIdx + 1) : (lineGroups.length + 1);
  const nowStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  let cleanName = groupName;
  if (!cleanName || cleanName.startsWith('C') || cleanName.startsWith('R') || cleanName.includes(gid) || !isNaN(cleanName) || cleanName.includes('กลุ่มดวลสด')) {
    try {
      const lineBot = await import('./lineBot.js');
      const realName = await lineBot.fetchLINEGroupName(gid);
      if (realName) cleanName = realName;
      else cleanName = `🚀 กลุ่มดวลสด #${groupNumber}`;
    } catch (_) {
      cleanName = `🚀 กลุ่มดวลสด #${groupNumber}`;
    }
  }

  let group = lineGroups.find((g) => g.id === gid);
  if (!group) {
    group = {
      id: gid,
      name: cleanName,
      lastMessage: text || 'มีการเคลื่อนไหวในกลุ่ม',
      timestamp: nowStr,
      msgCount: 1,
    };
    lineGroups.push(group);
  } else {
    group.name = cleanName;
    group.lastMessage = text || group.lastMessage;
    group.timestamp = nowStr;
    group.msgCount = (group.msgCount || 0) + 1;
  }

  if (persist) persistLineGroupToSheet(group);
  return group;
}

export async function saveActiveGroupId(groupId) {
  if (!groupId || typeof groupId !== 'string' || groupId.trim().length <= 5) {
    return { success: false, error: 'Invalid group ID' };
  }
  const gid = groupId.trim();
  if (!looksLikeLineGroupId(gid) && !/^C/i.test(gid)) {
    // Still allow manual paste of LINE group IDs that start with C/R; reject obvious junk
    if (!/^[CRca-zA-Z0-9_-]{10,}$/.test(gid)) {
      return { success: false, error: 'Group ID ต้องขึ้นต้นด้วย C หรือ R (LINE Group/Room ID)' };
    }
  }
  activeGroupId = gid;
  const group = await recordGroupActivity(gid, null, null, null, 'Set manually by Admin');
  return {
    success: true,
    groupId: gid,
    activeGroupId: activeGroupId,
    lineGroups: [...lineGroups],
    group,
  };
}

export function getActiveGroupId() {
  return activeGroupId;
}

/**
 * Scan memory + sheets-backed data for known LINE group IDs (admin portal Auto Discover).
 */
export function adminDiscoverGroupIds() {
  const discovered = {};

  if (activeGroupId) discovered[activeGroupId] = 'Active Group';
  for (const g of lineGroups) {
    if (g?.id) discovered[g.id] = g.name || 'กลุ่มที่รู้จัก';
  }
  for (const b of bets) {
    const gid = String(b.groupId || '').trim();
    if (looksLikeLineGroupId(gid) && !discovered[gid]) {
      discovered[gid] = b.groupName || 'จาก Bets sheet';
    }
  }
  for (const log of chatLogs) {
    const gid = String(log.userId || '').trim();
    if (looksLikeLineGroupId(gid) && !discovered[gid]) {
      discovered[gid] = 'จาก LineChatLogs';
    }
  }

  // Ensure discovered groups exist in lineGroups memory so dashboard refreshes show them
  const discoveredList = Object.keys(discovered).map((id) => {
    upsertLineGroupMemory(id, discovered[id], discovered[id]);
    return { id, source: discovered[id] };
  });

  if (!activeGroupId && discoveredList.length > 0) {
    activeGroupId = discoveredList[0].id;
  }

  return {
    activeGroupId: activeGroupId || '',
    lineGroups: [...lineGroups],
    discovered: discoveredList,
  };
}

// GET DATA FOR THE REACT DASHBOARD
export function getDashboardData() {
  // Sort transactions to match dashboard's ordering expectation (newest first)
  return {
    players: [...players],
    transactions: [...transactions],
    bets: [...bets],
    chatLogs: [...chatLogs],
    activeGroupId: activeGroupId,
    lineGroups: [...lineGroups],
    activeRound: getActiveRocketRound(),
    roundStatus: activeRocketRound?.status || 'ACTIVE',
  };
}

// get player's registered bank details
export function getPlayerBank(userId) {
  const searchId = cleanUserId(userId);
  if (!searchId) return null;
  const player = players.find((p) => cleanUserId(p.id) === searchId);
  if (player && player.bankName && player.bankAccount) {
    return {
      bankName: player.bankName,
      accountNumber: player.bankAccount,
      accountName: player.accountName,
    };
  }
  return null;
}

// update a player's registered bank details
export function updatePlayerBank(userId, bankName, accountNumber, accountName) {
  const searchId = cleanUserId(userId);
  if (!searchId) return;
  const player = players.find((p) => cleanUserId(p.id) === searchId);
  if (player) {
    player.bankName = bankName;
    player.bankAccount = formatBankAccount(accountNumber);
    player.accountName = accountName;

    updateRowInSheet('Players', searchId, {
      4: bankName,
      5: accountNumber.toString(),
      6: accountName,
    });
  }
}

// checks if the player has at least one successful deposit
export function hasSuccessfulDeposit(userId) {
  const searchId = cleanUserId(userId);
  return transactions.some(
    (t) => cleanUserId(t.playerId) === searchId && t.status === 'success'
  );
}

// get active bets for player
export function getPlayerActiveBets(userId) {
  const searchId = cleanUserId(userId);
  return bets.filter(
    (b) =>
      (cleanUserId(b.playerLowId) === searchId ||
        cleanUserId(b.playerHighId) === searchId) &&
      (b.status === 'pending_match' || b.status === 'matched')
  );
}

// retrieve a player's balance, registering them if they do not exist
// Generate a unique Passport-style ID (2 uppercase letters + 6 digits, e.g. RS481729).
export function generatePassportStyleId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const existingIds = new Set(players.map(p => p.id.toUpperCase()));
  
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

// Get or create a unique short Passport-style ID mapped to a raw LINE User ID.
export function getOrCreateShortUserId(rawLineUserId, displayName) {
  if (!rawLineUserId) return '';
  const searchId = rawLineUserId.toString().trim();
  
  // If it's already a short ID or a sandbox ID, return as is
  if (searchId.toLowerCase() === 'user' || searchId.length <= 8) {
    return searchId;
  }
  
  // Check memory array for matching lineUserId
  const player = players.find(p => p.lineUserId === searchId);
  if (player) {
    return player.id;
  }
  
  // Check memory array for matching id (for legacy)
  const legacyPlayer = players.find(p => p.id === searchId);
  if (legacyPlayer) {
    if (!legacyPlayer.lineUserId) {
      legacyPlayer.lineUserId = searchId;
      updateRowInSheet('Players', legacyPlayer.id, { 7: searchId });
    }
    return legacyPlayer.id;
  }
  
  // Register new player with short ID
  const shortId = generatePassportStyleId();
  const name = displayName || 'ผู้เล่น LINE';
  const joinDateStr = new Date().toISOString();
  const avatars = ['🐉', '🐯', '🦅', '🦁', '🐻', '🐼', '🦊', '🦉'];
  
  const newPlayer = {
    id: shortId,
    name: name,
    balance: 0,
    joinDate: formatDate(joinDateStr),
    bankName: '',
    bankAccount: '',
    accountName: '',
    isUser: false,
    avatar: avatars[players.length % avatars.length],
    lineUserId: searchId
  };
  
  players.push(newPlayer);
  appendRowToSheet('Players', [shortId, name, 0, joinDateStr, '', '', '', searchId]);
  return shortId;
}

// Translate a short Passport-style ID back to its raw LINE User ID.
export function getRawLineUserId(shortUserId) {
  if (!shortUserId) return '';
  const searchId = shortUserId.toString().trim();
  if (searchId.toLowerCase() === 'user' || searchId.length > 8) {
    return searchId;
  }
  
  const player = players.find(p => p.id === searchId);
  if (player) {
    return player.lineUserId || searchId;
  }
  return searchId;
}

// retrieve a player's balance, registering them if they do not exist
export function getPlayerBalance(userId, displayName) {
  const shortUserId = getOrCreateShortUserId(userId, displayName);
  const searchId = cleanUserId(shortUserId);
  if (!searchId) return 0;
  
  const player = players.find((p) => cleanUserId(p.id) === searchId);
  return player ? player.balance : 0;
}

// adjust a player's balance (adds or deducts credits with strict anti-overdraft protection)
// Synchronous and atomic to prevent microtask yield race conditions during rapid concurrent bets
export function adjustPlayerBalance(userId, delta, displayName) {
  const shortUserId = getOrCreateShortUserId(userId, displayName);
  const searchId = cleanUserId(shortUserId);
  if (!searchId) return false;
  
  const numericDelta = Number(delta) || 0;
  const player = players.find((p) => cleanUserId(p.id) === searchId);

  if (player) {
    // Strict Anti-Overdraft Guard: Block deductions if resulting balance would be less than 0
    if (numericDelta < 0 && (player.balance + numericDelta < 0)) {
      console.warn(`[CREDIT BLOCK] Refused deduction for ${searchId} (${player.name}): current balance ${player.balance}, attempted ${numericDelta}`);
      return false;
    }
    player.balance += numericDelta;
    updateRowInSheet('Players', searchId, { 2: player.balance });
    return true;
  }
  return false;
}

// Save an open bet (with credit verification)
export function saveOpenBet(orderNo, userId, displayName, side, betAmount, type = 'normal', rMin = null, rMax = null, targetGroupId = null, userTypedCmd = null, isPreQuote = false, targetGroupName = null, messageId = null) {
  const searchId = cleanUserId(userId);
  const isAdminUser = searchId === 'admin' || searchId === 'user' || (typeof userId === 'string' && (userId.toLowerCase() === 'user' || userId.toLowerCase() === 'admin'));

  // Anti-Overdraft Guard: verify creator has sufficient balance
  const player = players.find((p) => cleanUserId(p.id) === searchId);
  const currentBalance = player ? player.balance : 0;
  if (!isAdminUser && betAmount > 0 && currentBalance < betAmount) {
    return { error: 'INSUFFICIENT_BALANCE', required: betAmount, current: currentBalance };
  }
  // Lock creator's credit
  if (!isAdminUser && betAmount > 0 && player) {
    player.balance -= betAmount;
    updateRowInSheet('Players', searchId, { 2: player.balance });
  }

  const now = new Date();
  const lowId = side === 'low' ? searchId : '';
  const lowName = side === 'low' ? displayName : '';
  const highId = side === 'high' ? searchId : '';
  const highName = side === 'high' ? displayName : '';

  let pushTargets = [];
  if (targetGroupId && targetGroupId !== 'ALL') {
    pushTargets = [targetGroupId];
  } else if (activeGroupId) {
    pushTargets = [activeGroupId];
  } else if (lineGroups && lineGroups.length > 0) {
    pushTargets = lineGroups.map(g => g.id);
  }

  const assignedGroupId = pushTargets[0] || activeGroupId || '';
  const assignedGroupName = targetGroupName || (lineGroups.find(g => g.id === assignedGroupId)?.name || 'กลุ่มดวลสด');

  const betTypeStr = isPreQuote ? 'pre_quote' : type;

  const newBet = {
    id: 'bet_' + orderNo,
    orderNumber: orderNo.toString(),
    playerLowId: lowId,
    playerLowName: lowName,
    playerHighId: highId,
    playerHighName: highName,
    amount: betAmount,
    type: betTypeStr,
    rangeMin: rMin ? Number(rMin) : null,
    rangeMax: rMax ? Number(rMax) : null,
    status: 'pending_match',
    winnerName: '',
    timestamp: formatTime(now),
    groupId: assignedGroupId,
    groupName: assignedGroupName,
    userTypedCmd: userTypedCmd,
    messageId: messageId
  };
  if (messageId) {
    linkOrderToMessage(messageId, orderNo);
  }
  bets.unshift(newBet); // Add to beginning of memory list

  appendRowToSheet('Bets', [
    orderNo.toString(),
    lowId,
    lowName,
    highId,
    highName,
    betAmount.toString(),
    betTypeStr,
    rMin ? rMin.toString() : '',
    rMax ? rMax.toString() : '',
    'pending_match',
    '',
    now.toISOString(),
    assignedGroupId,
    assignedGroupName,
    messageId || ''
  ]);

  if (pushTargets.length > 0) {
    import('./lineBot.js').then(lineBot => {
      const rangeInfo = rMin && rMax ? `${rMin}-${rMax}s` : (isPreQuote ? '⏳ รอราคาช่าง' : '');
      const betCard = lineBot.constructBetOpenFlex(orderNo, betAmount, side, displayName, rangeInfo, false, userTypedCmd, isPreQuote);
      pushTargets.forEach(targetId => {
        lineBot.pushToLine(targetId, betCard);
      });
    }).catch(err => {
      console.error('Error pushing order flex to LINE groups:', err);
    });
  }

  return newBet;
}

export function getBetByOrderNumber(orderNo) {
  if (!orderNo) return null;
  const cleanOrder = orderNo.toString().trim().replace(/#/g, '');
  return bets.find((b) => b.orderNumber.toString() === cleanOrder || b.orderNumber.toString().endsWith(cleanOrder)) || null;
}

// match against an existing open bet (supports optional specific target order number e.g. "12" or "123456")
export async function matchExistingOpenBet(userId, displayName, targetOrderNo = null, customMatchAmount = null) {
  return withMutationLock(() => matchExistingOpenBetUnlocked(userId, displayName, targetOrderNo, customMatchAmount));
}

async function matchExistingOpenBetUnlocked(userId, displayName, targetOrderNo = null, customMatchAmount = null) {
  const searchId = cleanUserId(userId);
  const matcherPlayer = players.find((p) => cleanUserId(p.id) === searchId);
  const matcherBal = matcherPlayer ? matcherPlayer.balance : 0;
  const cleanTargetOrder = targetOrderNo ? targetOrderNo.toString().trim().replace(/#/g, '') : null;

  // Search by target order first if specified (prioritize pending_match so partially matched orders can be matched further)
  let targetBet = null;
  if (cleanTargetOrder) {
    targetBet = bets.find((b) => {
      const orderStr = b.orderNumber.toString();
      return (orderStr === cleanTargetOrder || orderStr.endsWith(cleanTargetOrder)) && b.status === 'pending_match';
    });
    if (!targetBet) {
      targetBet = bets.find((b) => {
        const orderStr = b.orderNumber.toString();
        return orderStr === cleanTargetOrder || orderStr.endsWith(cleanTargetOrder);
      });
    }
  }

  if (cleanTargetOrder && !targetBet) {
    return { error: 'NOT_FOUND', targetOrderNo: cleanTargetOrder };
  }

  if (targetBet) {
    const creatorId = targetBet.playerLowId ? cleanUserId(targetBet.playerLowId) : cleanUserId(targetBet.playerHighId);
    const creatorName = targetBet.playerLowName || targetBet.playerHighName || '';

    // 1. OWN_BET GUARD: Check ID, raw ID, and display name
    if (creatorId === searchId || creatorId === cleanUserId(userId) || (creatorName && displayName && creatorName === displayName)) {
      return { error: 'OWN_BET', orderNumber: targetBet.orderNumber };
    }

    // 2. STATUS GUARDS: Distinguish cancelled from matched
    if (targetBet.status === 'cancelled' || targetBet.status === 'void') {
      return { error: 'CANCELLED', orderNumber: targetBet.orderNumber };
    }
    if (targetBet.status === 'matched' || targetBet.status === 'resolved') {
      return { error: 'ALREADY_MATCHED', orderNumber: targetBet.orderNumber };
    }

    let matchAmt = targetBet.amount;
    if (customMatchAmount !== null && customMatchAmount !== undefined) {
      const parsedAmt = Number(customMatchAmount);
      if (!isNaN(parsedAmt) && parsedAmt > 0) {
        const min20Percent = Math.max(1, Math.round(targetBet.amount * 0.20));
        if (parsedAmt < min20Percent) {
          return { error: 'BELOW_MIN_PERCENT_LIMIT', minAllowed: min20Percent, percent: 20, provided: parsedAmt, orderNumber: targetBet.orderNumber };
        }
        if (parsedAmt > targetBet.amount) {
          return { error: 'EXCEEDS_ORDER_AMOUNT', maxAllowed: targetBet.amount, provided: parsedAmt, orderNumber: targetBet.orderNumber };
        }
        matchAmt = parsedAmt;
      }
    }

    if (matcherBal < matchAmt) {
      return { error: 'INSUFFICIENT_BALANCE', required: matchAmt, current: matcherBal, orderNumber: targetBet.orderNumber };
    }

    if (matchAmt < targetBet.amount) {
      const remainingAmt = targetBet.amount - matchAmt;
      targetBet.amount = matchAmt;

      if (!targetBet.playerLowId) {
        targetBet.playerLowId = searchId;
        targetBet.playerLowName = displayName;
      } else {
        targetBet.playerHighId = searchId;
        targetBet.playerHighName = displayName;
      }
      targetBet.status = 'matched';

      updateRowInSheet('Bets', targetBet.orderNumber, {
        1: targetBet.playerLowId,
        2: targetBet.playerLowName,
        3: targetBet.playerHighId,
        4: targetBet.playerHighName,
        5: matchAmt.toString(),
        9: 'matched',
      });

      const deductedPartial = await adjustPlayerBalance(searchId, -matchAmt, displayName);
      if (!deductedPartial) {
        targetBet.status = 'pending_match';
        targetBet.amount = matchAmt + remainingAmt;
        if (targetBet.playerLowId === searchId) {
          targetBet.playerLowId = '';
          targetBet.playerLowName = '';
        }
        if (targetBet.playerHighId === searchId) {
          targetBet.playerHighId = '';
          targetBet.playerHighName = '';
        }
        updateRowInSheet('Bets', targetBet.orderNumber, {
          1: targetBet.playerLowId,
          2: targetBet.playerLowName,
          3: targetBet.playerHighId,
          4: targetBet.playerHighName,
          5: targetBet.amount.toString(),
          9: 'pending_match',
        });
        return { error: 'INSUFFICIENT_BALANCE', required: matchAmt, current: matcherBal, orderNumber: targetBet.orderNumber };
      }

      if (remainingAmt >= 100) {
        const creatorSide = targetBet.playerLowId === searchId ? 'high' : 'low';
        const creatorName = targetBet.playerLowId === searchId ? targetBet.playerHighName : targetBet.playerLowName;
        const remainingOrderNo = String(generateUniqueOrderNumber());
        const remainingBet = {
          id: 'bet_' + remainingOrderNo,
          orderNumber: remainingOrderNo,
          playerLowId: creatorSide === 'low' ? creatorId : '',
          playerLowName: creatorSide === 'low' ? creatorName : '',
          playerHighId: creatorSide === 'high' ? creatorId : '',
          playerHighName: creatorSide === 'high' ? creatorName : '',
          amount: remainingAmt,
          type: targetBet.type,
          rangeMin: targetBet.rangeMin,
          rangeMax: targetBet.rangeMax,
          status: 'pending_match',
          winnerName: '',
          timestamp: formatTime(new Date()),
          groupId: targetBet.groupId,
          groupName: targetBet.groupName,
          userTypedCmd: targetBet.userTypedCmd,
        };
        bets.push(remainingBet);
        appendRowToSheet('Bets', [
          remainingBet.orderNumber,
          remainingBet.playerLowId,
          remainingBet.playerLowName,
          remainingBet.playerHighId,
          remainingBet.playerHighName,
          remainingBet.amount,
          remainingBet.type,
          remainingBet.rangeMin || '',
          remainingBet.rangeMax || '',
          'pending_match',
          '',
          new Date().toISOString(),
          remainingBet.groupId || '',
          remainingBet.groupName || '',
          ''
        ]);
      } else {
        await adjustPlayerBalance(creatorId, remainingAmt, 'Partial match credit refund');
      }

      return {
        orderNumber: targetBet.orderNumber,
        amount: matchAmt,
        playerLowName: targetBet.playerLowName,
        playerHighName: targetBet.playerHighName,
        creatorId: creatorId,
        matcherId: searchId,
        rangeInfo: targetBet.rangeMin && targetBet.rangeMax ? `${targetBet.rangeMin}-${targetBet.rangeMax}s` : '',
        rocketName: activeRocketRound?.name
      };
    }

    if (!targetBet.playerLowId) {
      targetBet.playerLowId = searchId;
      targetBet.playerLowName = displayName;
    } else {
      targetBet.playerHighId = searchId;
      targetBet.playerHighName = displayName;
    }

    targetBet.status = 'matched';

    // Update in Google Sheets
    updateRowInSheet('Bets', targetBet.orderNumber, {
      1: targetBet.playerLowId,
      2: targetBet.playerLowName,
      3: targetBet.playerHighId,
      4: targetBet.playerHighName,
      9: 'matched',
    });

    // Deduct credit from matcher
    const deducted = await adjustPlayerBalance(searchId, -targetBet.amount, displayName);
    if (!deducted) {
      // Rollback match
      targetBet.status = 'pending_match';
      if (targetBet.playerLowId === searchId) targetBet.playerLowId = '';
      if (targetBet.playerHighId === searchId) targetBet.playerHighId = '';
      // Rollback sheets
      updateRowInSheet('Bets', targetBet.orderNumber, { 9: 'pending_match' });
      return { error: 'INSUFFICIENT_BALANCE', required: targetBet.amount, current: 0, orderNumber: targetBet.orderNumber };
    }

    return {
      orderNumber: targetBet.orderNumber,
      amount: targetBet.amount,
      playerLowName: targetBet.playerLowName,
      playerHighName: targetBet.playerHighName,
      creatorId: creatorId,
      matcherId: searchId,
      rangeInfo: targetBet.rangeMin && targetBet.rangeMax ? `${targetBet.rangeMin}-${targetBet.rangeMax}s` : '',
      rocketName: activeRocketRound?.name
    };
  }

  // If no target specified, match first open pending bet
  for (const bet of bets) {
    if (bet.status === 'pending_match') {
      const creatorId = bet.playerLowId ? cleanUserId(bet.playerLowId) : cleanUserId(bet.playerHighId);
      if (creatorId === searchId) continue; // Skip own bet

      if (matcherBal < bet.amount) {
        return { error: 'INSUFFICIENT_BALANCE', required: bet.amount, current: matcherBal, orderNumber: bet.orderNumber };
      }

      if (!bet.playerLowId) {
        bet.playerLowId = searchId;
        bet.playerLowName = displayName;
      } else {
        bet.playerHighId = searchId;
        bet.playerHighName = displayName;
      }

      bet.status = 'matched';

      // Update in Google Sheets
      updateRowInSheet('Bets', bet.orderNumber, {
        1: bet.playerLowId,
        2: bet.playerLowName,
        3: bet.playerHighId,
        4: bet.playerHighName,
        9: 'matched',
      });

      // Deduct credit from matcher
      const deducted = await adjustPlayerBalance(searchId, -bet.amount, displayName);
      if (!deducted) {
        // Rollback match
        bet.status = 'pending_match';
        if (bet.playerLowId === searchId) bet.playerLowId = '';
        if (bet.playerHighId === searchId) bet.playerHighId = '';
        // Rollback sheets
        updateRowInSheet('Bets', bet.orderNumber, { 9: 'pending_match' });
        return { error: 'INSUFFICIENT_BALANCE', required: bet.amount, current: 0, orderNumber: bet.orderNumber };
      }

      return {
        orderNumber: bet.orderNumber,
        amount: bet.amount,
        playerLowName: bet.playerLowName,
        playerHighName: bet.playerHighName,
        creatorId: creatorId,
        matcherId: searchId,
      };
    }
  }

  return { error: 'NO_OPEN_BET' };
}

export function getPendingBetsList() {
  return bets.filter(b => b.status === 'pending_match');
}

// Cancel an open pending bet and refund credit to the creator (supports optional specific target order number e.g. "70572")
export async function cancelOpenBet(userId, targetOrderNo = null, isAdmin = false, displayName = null) {
  const searchId = cleanUserId(userId);
  const cleanTargetOrder = targetOrderNo ? targetOrderNo.toString().trim().replace(/#/g, '') : null;

  // Pass 1: If specific order requested, verify match
  if (cleanTargetOrder) {
    for (const bet of bets) {
      const orderStr = bet.orderNumber.toString();
      if (orderStr === cleanTargetOrder || orderStr.endsWith(cleanTargetOrder)) {
        const creatorId = bet.playerLowId ? cleanUserId(bet.playerLowId) : cleanUserId(bet.playerHighId);
        const creatorName = bet.playerLowName || bet.playerHighName || 'ผู้เล่น';

        // Authorization Guard: Only bet creator or admin can cancel
        const isCreator = (creatorId === searchId || creatorId === cleanUserId(userId) || (displayName && (bet.playerLowName === displayName || bet.playerHighName === displayName)));
        if (!isCreator && !isAdmin) {
          return { error: 'UNAUTHORIZED', creatorName: creatorName, orderNumber: bet.orderNumber };
        }

        if (bet.status === 'matched' || bet.status === 'pending_cancel') {
          return { error: 'ALREADY_MATCHED', orderNumber: bet.orderNumber };
        }

        if (bet.status === 'resolved' || bet.status === 'cancelled' || bet.status === 'void') {
          return { error: 'ALREADY_RESOLVED', orderNumber: bet.orderNumber };
        }

        if (bet.status === 'pending_match') {
          bet.status = 'cancelled';
          updateRowInSheet('Bets', bet.orderNumber, { 9: 'cancelled' });
          await adjustPlayerBalance(creatorId, bet.amount, creatorName);
          return {
            success: true,
            orderNumber: bet.orderNumber,
            amount: bet.amount,
            creatorId: creatorId,
            creatorName: creatorName,
            groupId: bet.groupId,
          };
        }
      }
    }
    return { error: 'NOT_FOUND' };
  }

  // Pass 2: No specific order requested ("ยกเลิก")
  // First search for user's pending_match bet
  for (const bet of bets) {
    if (bet.status === 'pending_match') {
      const creatorId = bet.playerLowId ? cleanUserId(bet.playerLowId) : cleanUserId(bet.playerHighId);
      const creatorName = bet.playerLowName || bet.playerHighName || 'ผู้เล่น';
      const isCreator = (creatorId === searchId || creatorId === cleanUserId(userId) || (displayName && (bet.playerLowName === displayName || bet.playerHighName === displayName)));

      if (isCreator || isAdmin) {
        bet.status = 'cancelled';
        updateRowInSheet('Bets', bet.orderNumber, { 9: 'cancelled' });
        await adjustPlayerBalance(creatorId, bet.amount, creatorName);
        return {
          success: true,
          orderNumber: bet.orderNumber,
          amount: bet.amount,
          creatorId: creatorId,
          creatorName: creatorName,
          groupId: bet.groupId,
        };
      }
    }
  }

  // If no pending_match bet, check if user has a matched bet and notify strictly
  for (const bet of bets) {
    if (bet.status === 'matched' || bet.status === 'pending_cancel') {
      const creatorId = bet.playerLowId ? cleanUserId(bet.playerLowId) : cleanUserId(bet.playerHighId);
      const isCreator = (creatorId === searchId || creatorId === cleanUserId(userId) || (displayName && (bet.playerLowName === displayName || bet.playerHighName === displayName)));

      if (isCreator || isAdmin) {
        return { error: 'ALREADY_MATCHED', orderNumber: bet.orderNumber };
      }
    }
  }

  return { error: 'NOT_FOUND' };
}

// log transactions (deposits/withdrawals)
export function logTransaction(
  userId,
  displayName,
  reqAmt,
  actAmt,
  refCode,
  status,
  reason
) {
  const searchId = cleanUserId(userId);
  const now = new Date();
  const refStr = refCode ? refCode.toString().toUpperCase() : '';
  const reasonStr = reason ? reason.toString().toLowerCase() : '';
  const isWithdraw = refStr.includes('WD') || refStr.includes('WITHDRAW') || reasonStr.includes('withdraw');

  // Check if there is an existing pending deposit request transaction for this user to update instead of creating a duplicate
  if (!isWithdraw) {
    const existingPending = transactions.find(
      (t) =>
        cleanUserId(t.playerId) === searchId &&
        t.status === 'escalated' &&
        (!t.id.startsWith('WD')) &&
        (t.slipRef === 'PENDING_SLIP' || (t.reviewReason && t.reviewReason.toString().toLowerCase().includes('waiting for user')))
    );

    if (existingPending) {
      if (Number(reqAmt) > 0) {
        existingPending.requestedAmount = Number(reqAmt);
      }
      if (Number(actAmt) >= 0) {
        existingPending.actualAmount = Number(actAmt);
      }
      if (refCode && refCode !== 'PENDING_SLIP') {
        existingPending.slipRef = refCode;
      }
      existingPending.status = status;
      existingPending.reviewReason = reason;
      existingPending.timestamp = formatTime(now);
      if (!existingPending.logs) existingPending.logs = [];
      existingPending.logs.push(`Updated [${formatTime(now)}]: ${reason}`);

      // Update in Google Sheets
      updateRowInSheet('Transactions', existingPending.id, {
        3: existingPending.requestedAmount.toString(),
        4: existingPending.actualAmount.toString(),
        5: existingPending.slipRef,
        6: existingPending.status,
        7: existingPending.reviewReason,
        8: now.toISOString(),
      });

      return existingPending.id;
    }
  }

  const prefix = isWithdraw ? 'WD' : 'TX';
  const txId = prefix + Math.floor(Math.random() * 89999 + 10000);

  const newTx = {
    id: txId,
    playerId: userId,
    playerName: displayName,
    requestedAmount: Number(reqAmt) || 0,
    actualAmount: Number(actAmt) || 0,
    slipRef: refCode,
    status: status,
    reviewReason: reason,
    timestamp: formatTime(now),
    logs: ['Verified in Sheets Database', `Status: ${status}`],
  };

  transactions.unshift(newTx); // Add to beginning of memory list

  appendRowToSheet('Transactions', [
    txId,
    userId,
    displayName,
    reqAmt.toString(),
    actAmt.toString(),
    refCode,
    status,
    reason,
    now.toISOString(),
  ]);

  return txId;
}

export function checkIfRefExists(refCode) {
  if (!refCode) return false;
  const cleanRef = refCode.toString().trim().toLowerCase();
  return transactions.some((t) => t.slipRef.toString().trim().toLowerCase() === cleanRef);
}

export function findPendingRequestedAmount(userId) {
  const searchId = cleanUserId(userId);
  // Find last transaction for user with status escalated (or pending) waiting for slip
  const found = transactions.find(
    (t) =>
      cleanUserId(t.playerId) === searchId &&
      t.status === 'escalated' &&
      t.reviewReason.toString().includes('Waiting for user')
  );
  return found ? found.requestedAmount : null;
}

// --- ADMIN DASHBOARD MUTATIONS ---

export function adminSetPlayerBank(userId, bankName, accountNumber, accountName) {
  updatePlayerBank(userId, bankName, accountNumber, accountName);
  return getDashboardData();
}

export async function adminCreatePlayer(lineId, displayName, initialBalance) {
  const cleanId = cleanUserId(lineId);
  const bal = Number(initialBalance) || 0;
  await adjustPlayerBalance(cleanId, bal, displayName);
  return getDashboardData();
}

export function adminUpdatePlayerName(userId, newName) {
  const searchId = cleanUserId(userId);
  const player = players.find((p) => cleanUserId(p.id) === searchId);
  if (player) {
    player.name = newName;
    updateRowInSheet('Players', searchId, { 1: newName });
  }
  return getDashboardData();
}

export function adminSetPlayerBalance(userId, newBalance) {
  const searchId = cleanUserId(userId);
  const bal = Number(newBalance) || 0;
  const player = players.find((p) => cleanUserId(p.id) === searchId);
  if (player) {
    const diff = bal - player.balance;
    player.balance = bal;
    updateRowInSheet('Players', searchId, { 2: bal });

    // Replicate transaction logging from Code.gs
    logTransaction(
      searchId,
      player.name,
      0,
      diff,
      'ADMIN_ADJUST',
      'success',
      `Admin manually set balance to ${bal}`
    );
  }
  return getDashboardData();
}

export function adminDeletePlayer(userId) {
  const searchId = cleanUserId(userId);
  players = players.filter((p) => cleanUserId(p.id) !== searchId);

  // Clear player row in Sheets (overwrite player list)
  queueWrite(async () => {
    const matrix = [
      [
        'User ID',
        'Display Name',
        'Balance (Credits)',
        'Registered Date',
        'Bank Name',
        'Bank Account Number',
        'Bank Account Holder Name',
      ],
    ];
    for (const p of players) {
      matrix.push([
        p.id,
        p.name,
        p.balance.toString(),
        new Date().toISOString(), // Fallback date
        p.bankName,
        p.bankAccount,
        p.accountName,
      ]);
    }
    await overwriteSheet('Players', matrix);
  });

  return getDashboardData();
}

export async function adminApproveTransaction(txId) {
  const tx = transactions.find((t) => t.id === txId);
  if (tx && tx.status !== 'success') {
    tx.status = 'success';
    tx.reviewReason = 'Manually approved by supervisor';

    let amountToAdd = (tx.actualAmount && tx.actualAmount > 0) ? tx.actualAmount : (tx.requestedAmount || 0);
    tx.actualAmount = amountToAdd;
    updateRowInSheet('Transactions', txId, { 4: amountToAdd, 6: 'success', 7: tx.reviewReason });

    const isWithdrawal = tx.id.startsWith('WD') || (tx.slipRef && tx.slipRef.toString().toUpperCase().includes('WD')) || (tx.reviewReason && tx.reviewReason.toString().toLowerCase().includes('withdraw'));
    
    if (isWithdrawal) {
      // In withdrawal flow, the requested amount was already deducted from user balance upon withdrawal request.
      // Do NOT add balance back to user (payout approved)!
    } else {
      await adjustPlayerBalance(tx.playerId, amountToAdd, tx.playerName);
    }

    // Dynamic import to send LINE notifications and log chat feed
    try {
      const lineBot = await import('./lineBot.js');
      if (isWithdrawal) {
        let details = "ถอนเงินคืนเข้าบัญชีของคุณ";
        const bank = getPlayerBank(tx.playerId);
        if (bank) {
          details = `โอนเข้าบัญชี ${bank.bankName} ${bank.accountNumber} (${bank.accountName})`;
        }
        const flex = lineBot.constructBankingFlex("withdraw", tx.requestedAmount, details, null, tx.playerId);
        await lineBot.pushToLine(tx.playerId, flex);
        logLineChatMessage(tx.playerId, tx.playerName || 'ผู้เล่น', 'bot', `💸 [ถอนเงินสำเร็จ]: ${tx.requestedAmount.toLocaleString()} THB โอนเข้าบัญชีแล้ว 🚀`, 'text');
      } else {
        const flex = lineBot.constructBankingFlex("deposit", amountToAdd, "เติมเงินสำเร็จ (แอดมินอนุมัติเรียบร้อย)", null, tx.playerId);
        await lineBot.pushToLine(tx.playerId, flex);
        logLineChatMessage(tx.playerId, tx.playerName || 'ผู้เล่น', 'bot', `🟢 [เติมเงินสำเร็จ]: +${amountToAdd.toLocaleString()}pt เข้าบัญชีเรียบร้อย 🚀`, 'text');
      }
    } catch (err) {
      console.error("[DB] Error sending Line approval notification:", err);
    }
  }
  return getDashboardData();
}

export async function adminRejectTransaction(txId, reason) {
  const tx = transactions.find((t) => t.id === txId);
  if (tx && tx.status !== 'success') {
    tx.status = 'rejected';
    tx.reviewReason = reason || 'Admin rejected';
    updateRowInSheet('Transactions', txId, { 6: 'rejected', 7: tx.reviewReason });

    const isWithdrawal = tx.id.startsWith('WD') || (tx.slipRef && tx.slipRef.toString().toUpperCase().includes('WD')) || (tx.reviewReason && tx.reviewReason.toString().toLowerCase().includes('withdraw'));
    if (isWithdrawal) {
      // Refund the locked balance back to player
      await adjustPlayerBalance(tx.playerId, tx.requestedAmount, tx.playerName);
    }

    // Dynamic import to send LINE notifications and log chat feed
    try {
      const lineBot = await import('./lineBot.js');
      const currentBalance = await getPlayerBalance(tx.playerId, tx.playerName);
      if (isWithdrawal) {
        const flex = lineBot.constructRejectionFlex("WD", tx.requestedAmount, reason || 'ข้อมูลไม่ถูกต้อง', currentBalance, tx.playerId);
        await lineBot.pushToLine(tx.playerId, flex);
        logLineChatMessage(tx.playerId, tx.playerName || 'ผู้เล่น', 'bot', `❌ [ปฏิเสธถอนเงิน]: ยอด ${tx.requestedAmount.toLocaleString()} THB (คืนแต้มเข้าบัญชีแล้ว)`, 'text');
      } else {
        const flex = lineBot.constructRejectionFlex("DP", tx.requestedAmount, reason || 'สลิปไม่ผ่านเกณฑ์ตรวจสอบ', currentBalance, tx.playerId);
        await lineBot.pushToLine(tx.playerId, flex);
        logLineChatMessage(tx.playerId, tx.playerName || 'ผู้เล่น', 'bot', `❌ [ปฏิเสธฝากเงิน]: ยอด ${tx.requestedAmount.toLocaleString()} THB (สาเหตุ: ${reason || 'สลิปไม่ผ่านเกณฑ์'})`, 'text');
      }
    } catch (err) {
      console.error("[DB] Error sending Line rejection notification:", err);
    }
  }
  return getDashboardData();
}

export async function adminResolveBets(finalTime, targetMinOrTime, targetMaxParam, sendPushCallback) {
  // Support both single target or range target (e.g. 330 - 380)
  const activeRound = getActiveRocketRound();
  let targetMin = (targetMinOrTime && Number(targetMinOrTime) > 0) ? Number(targetMinOrTime) : (activeRound?.targetMin || 330);
  let targetMax = (targetMaxParam && !isNaN(Number(targetMaxParam)) && Number(targetMaxParam) > 0) ? Number(targetMaxParam) : (activeRound?.targetMax || 380);
  let callback = sendPushCallback;

  if (typeof targetMaxParam === 'function') {
    callback = targetMaxParam;
    targetMax = activeRound?.targetMax || 380;
  }

  const numTime = Number(finalTime);
  const isVoid = isNaN(numTime) || numTime <= 0;

  // Void/False Round Handling: Refund 100% credit to all active bets
  if (isVoid) {
    for (const bet of bets) {
      if (bet.status === 'matched' || bet.status === 'pending_match' || bet.status === 'pending_cancel') {
        const prevStatus = bet.status;
        const amount = Number(bet.amount) || 0;
        bet.status = 'cancelled';
        updateRowInSheet('Bets', bet.orderNumber, { 9: 'cancelled' });

        if (prevStatus === 'pending_match') {
          const creatorId = bet.playerLowId ? bet.playerLowId : bet.playerHighId;
          const creatorName = bet.playerLowName || bet.playerHighName || 'ผู้เล่น';
          if (creatorId) await adjustPlayerBalance(creatorId, amount, creatorName);
        } else if (prevStatus === 'matched' || prevStatus === 'pending_cancel') {
          if (bet.playerLowId) await adjustPlayerBalance(bet.playerLowId, amount, bet.playerLowName);
          if (bet.playerHighId) await adjustPlayerBalance(bet.playerHighId, amount, bet.playerHighName);
        }
      }
    }

    const targetGroups = lineGroups.length > 0 ? lineGroups : (activeGroupId ? [{ id: activeGroupId }] : []);
    if (targetGroups.length > 0) {
      try {
        const lineBot = await import('./lineBot.js');
        const roundNotice = `⛔ [ประกาศรอบโมฆะ / ผลช่าง ⛔]: ผลการจุดรอบนี้ไม่มีผล ได้ทำการยกเลิกแผลดวลและคืนแต้มผู้เล่น 100% ทุกแผลเรียบร้อยครับ 🚀`;
        await Promise.allSettled(targetGroups.map(g => lineBot.pushToLine(g.id, roundNotice)));
        logLineChatMessage('SYSTEM', '🤖 Rocket Bot', 'bot', roundNotice, 'text');
      } catch (e) {
        console.error("[DB] Error broadcasting void round result:", e);
      }
    }

    return getDashboardData();
  }

  // 1. Perform automatic matching
  await autoMatchPendingBets();

  const finalScaled = Math.round(finalTime * 100);
  const minScaled = Math.round(targetMin * 100);
  const maxScaled = Math.round(targetMax * 100);

  for (const bet of bets) {
    if (bet.status === 'matched') {
      const pLowId = cleanUserId(bet.playerLowId);
      const pLowName = bet.playerLowName;
      const pHighId = cleanUserId(bet.playerHighId);
      const pHighName = bet.playerHighName;
      const amount = Number(bet.amount);
      const type = bet.type;
      const rangeMin = bet.rangeMin ? Math.round(bet.rangeMin * 100) : null;
      const rangeMax = bet.rangeMax ? Math.round(bet.rangeMax * 100) : null;

      let isLowWinner = true;
      const timeSec = Number(finalTime);
      let minSec = (type === 'range' && bet.rangeMin !== null && bet.rangeMax !== null) ? Number(bet.rangeMin) : Number(targetMin);
      let maxSec = (type === 'range' && bet.rangeMin !== null && bet.rangeMax !== null) ? Number(bet.rangeMax) : Number(targetMax);

      // Self-heal corrupt legacy ranges
      if (minSec >= 700 && targetMin < 600) {
        const offset = minSec - 810;
        if (offset >= -50 && offset <= 50) {
          minSec = targetMin + offset;
          maxSec = targetMax + offset;
        } else {
          minSec = targetMin;
          maxSec = targetMax;
        }
        bet.rangeMin = minSec;
        bet.rangeMax = maxSec;
        updateRowInSheet('Bets', bet.orderNumber, { 7: minSec, 8: maxSec });
      }

      if (timeSec < minSec) {
        isLowWinner = true; // Lower than min target -> Low (ชล) wins
      } else if (timeSec > maxSec) {
        isLowWinner = false; // Higher than max target -> High (ชถ) wins
      } else {
        const midPoint = (minSec + maxSec) / 2;
        isLowWinner = timeSec <= midPoint;
      }

      const winnerId = isLowWinner ? pLowId : pHighId;
      const winnerName = isLowWinner ? pLowName : pHighName;
      const loserId = isLowWinner ? pHighId : pLowId;
      const loserName = isLowWinner ? pHighName : pLowName;

      // 10% commission on the opponent's wager portion
      const commissionRate = 0.1;
      const winnings = amount;
      const commission = winnings * commissionRate;
      const payout = amount + (winnings - commission); // amount * 1.90

      // Add balance to winner
      await adjustPlayerBalance(winnerId, payout, winnerName);

      bet.status = 'resolved';
      bet.winnerName = winnerName;

      updateRowInSheet('Bets', bet.orderNumber, {
        9: 'resolved',
        10: winnerName,
      });

      // Send push notifications to winner & loser concurrently
      if (sendPushCallback) {
        try {
          const winBal = players.find((p) => cleanUserId(p.id) === winnerId)?.balance || 0;
          const loseBal = players.find((p) => cleanUserId(p.id) === loserId)?.balance || 0;

          await Promise.allSettled([
            sendPushCallback(winnerId, true, bet.orderNumber, amount, finalTime, payout, winBal, winnings, commission),
            sendPushCallback(loserId, false, bet.orderNumber, amount, finalTime, 0, loseBal, winnings, commission),
          ]);
        } catch (err) {
          console.error('[LINE Push] Error sending match results:', err);
        }
      }
    }
  }

  // 3. Auto-cancel and refund any remaining unmatched pending bets
  for (const bet of bets) {
    if (bet.status === 'pending_match' || bet.status === 'pending_cancel') {
      const creatorId = bet.playerLowId ? cleanUserId(bet.playerLowId) : cleanUserId(bet.playerHighId);
      const creatorName = bet.playerLowName || bet.playerHighName || 'ผู้เล่น';
      const amount = Number(bet.amount) || 0;

      bet.status = 'cancelled';
      updateRowInSheet('Bets', bet.orderNumber, { 9: 'cancelled' });

      if (creatorId) {
        await adjustPlayerBalance(creatorId, amount, creatorName);
      }
    }
  }

  const targetGroups = lineGroups.length > 0 ? lineGroups : (activeGroupId ? [{ id: activeGroupId }] : []);
  if (targetGroups.length > 0) {
    try {
      const lineBot = await import('./lineBot.js');
      const roundFlex = lineBot.constructRoundSummaryFlex(finalTime, targetMin, targetMax, activeRocketRound?.name);
      await Promise.allSettled(targetGroups.map(g => lineBot.pushToLine(g.id, roundFlex)));
      logLineChatMessage('SYSTEM', '🤖 Rocket Bot', 'bot', `🏆 ประกาศผลสรุปดวล: ${finalTime}s`, 'flex');
    } catch (e) {
      console.error("[DB] Error broadcasting round result to groups:", e);
    }
  }

  // Reset round lock status to ACTIVE for the next round
  setRocketRoundStatus('ACTIVE');

  return getDashboardData();
}

export async function adminVoidRound() {
  for (const bet of bets) {
    if (bet.status === 'matched' || bet.status === 'pending_match' || bet.status === 'pending_cancel') {
      bet.status = 'cancelled';
      updateRowInSheet('Bets', bet.orderNumber, { 9: 'cancelled' });

      const lowId = bet.playerLowId ? cleanUserId(bet.playerLowId) : '';
      const highId = bet.playerHighId ? cleanUserId(bet.playerHighId) : '';
      const amount = Number(bet.amount) || 0;

      if (lowId) {
        await adjustPlayerBalance(lowId, amount, bet.playerLowName || 'ผู้เล่น');
      }
      if (highId) {
        await adjustPlayerBalance(highId, amount, bet.playerHighName || 'ผู้เล่น');
      }
    }
  }

  setRocketRoundStatus('ACTIVE');
  return getDashboardData();
}

export async function autoMatchPendingBets() {
  const bots = [
    { id: 'p1', name: 'วชิระ ส. (โบ๊ท)' },
    { id: 'p2', name: 'เบนซ์ (Benz)' },
    { id: 'p3', name: 'อาร์ต (Art)' },
    { id: 'p4', name: 'เจ๋ง (Jeng)' },
  ];

  for (let i = 0; i < bets.length; i++) {
    const bet = bets[i];
    if (bet.status === 'pending_match') {
      let pLowId = cleanUserId(bet.playerLowId);
      let pLowName = bet.playerLowName;
      let pHighId = cleanUserId(bet.playerHighId);
      let pHighName = bet.playerHighName;
      const amount = Number(bet.amount);

      let paired = false;
      // Search opposite pending bet of same amount in other rows
      for (let j = i + 1; j < bets.length; j++) {
        const oBet = bets[j];
        const oAmount = Number(oBet.amount);

        if (oBet.status === 'pending_match' && oAmount === amount) {
          const oLowId = cleanUserId(oBet.playerLowId);
          const oHighId = cleanUserId(oBet.playerHighId);

          if (pLowId && !pHighId && !oLowId && oHighId && pLowId !== oHighId) {
            pHighId = oHighId;
            pHighName = oBet.playerHighName;
            paired = true;
          } else if (!pLowId && pHighId && oLowId && !oHighId && pHighId !== oLowId) {
            pLowId = oLowId;
            pLowName = oBet.playerLowName;
            paired = true;
          }

          if (paired) {
            bet.playerLowId = pLowId;
            bet.playerLowName = pLowName;
            bet.playerHighId = pHighId;
            bet.playerHighName = pHighName;
            bet.status = 'matched';

            updateRowInSheet('Bets', bet.orderNumber, {
              1: pLowId,
              2: pLowName,
              3: pHighId,
              4: pHighName,
              9: 'matched',
            });

            // Mark opposite row as cancelled
            oBet.status = 'cancelled';
            updateRowInSheet('Bets', oBet.orderNumber, { 9: 'cancelled' });
            break;
          }
        }
      }

      // Match against system bot if no opponent found
      if (!paired) {
        let opponent = null;
        for (const bot of bots) {
          if (bot.id !== pLowId && bot.id !== pHighId) {
            opponent = bot;
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

          bet.playerLowId = pLowId;
          bet.playerLowName = pLowName;
          bet.playerHighId = pHighId;
          bet.playerHighName = pHighName;
          bet.status = 'matched';

          // Lock bot credit
          await adjustPlayerBalance(opponent.id, -amount, opponent.name);

          updateRowInSheet('Bets', bet.orderNumber, {
            1: pLowId,
            2: pLowName,
            3: pHighId,
            4: pHighName,
            9: 'matched',
          });
        }
      }
    }
  }
}

export async function adminRequestCancelBet(betId) {
  const orderNumber = betId.replace('bet_', '');
  const bet = bets.find((b) => b.orderNumber === orderNumber);
  if (bet && bet.status !== 'resolved' && bet.status !== 'cancelled') {
    const prevStatus = bet.status;
    const amount = bet.amount;
    bet.status = 'cancelled';
    updateRowInSheet('Bets', orderNumber, { 9: 'cancelled' });

    // Refund credits
    if (prevStatus === 'pending_match') {
      const creatorId = bet.playerLowId ? bet.playerLowId : bet.playerHighId;
      await adjustPlayerBalance(creatorId, amount);
    } else if (prevStatus === 'matched') {
      // Refund both players
      if (bet.playerLowId) await adjustPlayerBalance(bet.playerLowId, amount);
      if (bet.playerHighId) await adjustPlayerBalance(bet.playerHighId, amount);
    }
  }
  return getDashboardData();
}

export async function handleCancelBetRequest(userId, orderNo) {
  const searchId = cleanUserId(userId);
  if (!searchId || !orderNo) return '🚫 ไม่สามารถทำรายการยกเลิกได้ครับ';
  const orderStr = orderNo.toString().trim().replace(/#/g, '');
  const bet = bets.find((b) => b.orderNumber === orderStr || b.orderNumber.endsWith(orderStr));

  if (!bet) return `🚫 ไม่พบแผลดวล Order #${orderNo} ในระบบครับ`;

  if (
    cleanUserId(bet.playerLowId) !== searchId &&
    cleanUserId(bet.playerHighId) !== searchId
  ) {
    return '🚫 ขออภัยครับ แผลดวลนี้ไม่ใช่แผลของคุณ';
  }

  if (bet.status === 'matched' || bet.status === 'pending_cancel') {
    return `⚠️ ไม่สามารถยกเลิกได้ครับ แผล Order #${bet.orderNumber} มีคู่ดวลแมตช์แล้ว (กติกาไม่อนุญาตให้ยกเลิกแผลที่แมตช์แล้วทุกกรณีครับ 🚀)`;
  }

  if (bet.status === 'resolved' || bet.status === 'cancelled' || bet.status === 'void') {
    return `⚠️ แผลดวล Order #${orderNo} จบหรือถูกยกเลิกแล้วครับ`;
  }

  if (bet.status === 'pending_match') {
    bet.status = 'cancelled';
    updateRowInSheet('Bets', bet.orderNumber, { 9: 'cancelled' });
    await adjustPlayerBalance(searchId, bet.amount);
    return `❌ ยกเลิกแผล Order #${bet.orderNumber} สำเร็จ!`;
  }

  return '🚫 ผิดพลาดในการปรับปรุงสถานะแผล';
}

// --- MESSAGE CACHING & EDIT / UNSEND AUDITING ---
const messageCache = new Map();

export function cacheLineMessage(messageId, text, userId, displayName, groupId) {
  if (!messageId) return;
  const now = Date.now();
  messageCache.set(String(messageId), {
    text: text || '',
    userId: cleanUserId(userId),
    displayName: displayName || 'ผู้ใช้',
    groupId: groupId || null,
    timestamp: now,
    orderNo: null
  });

  // Limit memory usage: purge messages older than 2 hours or if cache > 1500
  if (messageCache.size > 1500) {
    for (const [k, v] of messageCache.entries()) {
      if (now - v.timestamp > 2 * 3600 * 1000) {
        messageCache.delete(k);
      }
    }
  }
}

export function linkOrderToMessage(messageId, orderNo) {
  if (!messageId || !orderNo) return;
  const cached = messageCache.get(String(messageId));
  if (cached) {
    cached.orderNo = String(orderNo);
  }
}

export function getCachedMessage(messageId) {
  if (!messageId) return null;
  return messageCache.get(String(messageId)) || null;
}

export async function handleUnsendEvent(messageId, userId, displayName, groupId) {
  const searchId = cleanUserId(userId);
  let cached = messageId ? messageCache.get(String(messageId)) : null;
  let foundBet = null;

  if (messageId) {
    foundBet = bets.slice().reverse().find(b => b.messageId && String(b.messageId) === String(messageId));
  }

  if (!foundBet && cached && cached.orderNo) {
    foundBet = bets.find(b => String(b.orderNumber) === String(cached.orderNo));
  }

  if (!foundBet && searchId) {
    foundBet = bets.slice().reverse().find(b => {
      const isCreator = cleanUserId(b.playerLowId) === searchId || cleanUserId(b.playerHighId) === searchId ||
                        (displayName && (b.playerLowName === displayName || b.playerHighName === displayName));
      return isCreator;
    });
  }

  const effectiveDisplayName = displayName || (cached ? cached.displayName : (foundBet ? (foundBet.playerLowName || foundBet.playerHighName) : 'ผู้ใช้'));
  const originalText = (cached && cached.text) ? cached.text : (foundBet ? (foundBet.userTypedCmd || `Order #${foundBet.orderNumber}`) : null);
  const orderNo = foundBet ? foundBet.orderNumber : (cached ? cached.orderNo : null);
  const targetGroupId = groupId || (foundBet ? foundBet.groupId : (cached ? cached.groupId : null));

  if (cached) {
    cached.unsent = true;
  }

  // RULE: Unsend does NOT change, cancel, or refund bets in any way!
  // Orders can only be cancelled via the interactive Flex card button.
  return {
    cancelled: false,
    orderNo,
    status: foundBet ? foundBet.status : null,
    targetGroupId,
    originalText,
    displayName: effectiveDisplayName
  };
}

export async function handleMessageEditedEvent(messageId, newText, userId, displayName, groupId) {
  const searchId = cleanUserId(userId);
  let cached = messageId ? messageCache.get(String(messageId)) : null;
  let foundBet = null;

  if (messageId) {
    foundBet = bets.slice().reverse().find(b => b.messageId && String(b.messageId) === String(messageId));
  }

  if (!foundBet && cached && cached.orderNo) {
    foundBet = bets.find(b => String(b.orderNumber) === String(cached.orderNo));
  }

  if (!foundBet && searchId) {
    foundBet = bets.slice().reverse().find(b => {
      const isCreator = cleanUserId(b.playerLowId) === searchId || cleanUserId(b.playerHighId) === searchId ||
                        (displayName && (b.playerLowName === displayName || b.playerHighName === displayName));
      return isCreator;
    });
  }

  const effectiveDisplayName = displayName || (cached ? cached.displayName : (foundBet ? (foundBet.playerLowName || foundBet.playerHighName) : 'ผู้ใช้'));
  const originalText = (cached && cached.text) ? cached.text : (foundBet ? (foundBet.userTypedCmd || `Order #${foundBet.orderNumber}`) : null);
  const orderNo = foundBet ? foundBet.orderNumber : (cached ? cached.orderNo : null);
  const targetGroupId = groupId || (foundBet ? foundBet.groupId : (cached ? cached.groupId : null));

  // Update cached text with newText for subsequent tracking
  if (cached) {
    cached.text = newText;
    cached.edited = true;
  } else if (messageId) {
    cacheLineMessage(messageId, newText, userId, effectiveDisplayName, targetGroupId);
  }

  // RULE: Edit message does NOT modify or change bets or records in any way!
  return {
    orderNo,
    status: foundBet ? foundBet.status : null,
    targetGroupId,
    originalText,
    newText,
    displayName: effectiveDisplayName
  };
}

// Backwards compatibility alias
export async function handleUnsendBet(messageId, userId, displayName, groupId) {
  return handleUnsendEvent(messageId, userId, displayName, groupId);
}

export function verifyMockSlipFromClient(depositAmt, realAmt, ref, isQRValid, isDupe) {
  // Simulator endpoint to simulate slip checking results
  console.log(`[Simulator] Verifying mock slip: amt=${depositAmt}, real=${realAmt}, ref=${ref}`);
  return {
    success: isQRValid,
    data: isQRValid
      ? {
          amountInSlip: realAmt,
          transRef: ref,
          transDate: new Date().toISOString(),
        }
      : null,
    message: isQRValid ? 'OK' : 'Cannot read QR code',
  };
}

export function resetGoogleSheetsDatabase() {
  players = [];
  transactions = [];
  bets = [];
  chatLogs = [];

  const headers = {
    Players: [
      [
        'User ID',
        'Display Name',
        'Balance (Credits)',
        'Registered Date',
        'Bank Name',
        'Bank Account Number',
        'Bank Account Holder Name',
        'LINE User ID',
      ],
    ],
    Transactions: [
      [
        'Tx ID',
        'User ID',
        'Display Name',
        'Requested Amount',
        'Actual Amount',
        'Bank Ref',
        'Status',
        'Reason',
        'Timestamp',
      ],
    ],
    Bets: [
      [
        'Order Number',
        'Player Low ID',
        'Player Low Name',
        'Player High ID',
        'Player High Name',
        'Amount',
        'Type',
        'Range Min',
        'Range Max',
        'Status',
        'Winner Name',
        'Timestamp',
      ],
    ],
    LineChatLogs: [
      ['Timestamp', 'User ID', 'Display Name', 'Sender', 'Message Text', 'Message Type'],
    ],
  };

  overwriteSheet('Players', headers.Players);
  overwriteSheet('Transactions', headers.Transactions);
  overwriteSheet('Bets', headers.Bets);
  overwriteSheet('LineChatLogs', headers.LineChatLogs);



  return getDashboardData();
}

export function logLineChatMessage(userId, displayName, sender, messageText, messageType) {
  const now = new Date();
  const newLog = {
    timestamp: formatTime(now),
    userId,
    displayName,
    sender,
    text: messageText,
    type: messageType || 'text',
  };
  chatLogs.push(newLog);

  appendRowToSheet('LineChatLogs', [
    now.toISOString(),
    userId,
    displayName,
    sender,
    messageText,
    messageType || 'text',
  ]);
}

export function getPlayerNameFromDb(userId) {
  const searchId = cleanUserId(userId);
  const player = players.find((p) => cleanUserId(p.id) === searchId || cleanUserId(p.lineUserId) === searchId);
  return player ? player.name : null;
}

export function getLineChatLogs() {
  return [...chatLogs];
}

// --- ROCKET ROUND & FLOOD DEDUPLICATION HELPERS ---
let activeRocketRound = { name: 'ช่างบั้งไฟสด', targetMin: 330, targetMax: 380, isChotoy: false, status: 'ACTIVE', startTime: new Date() };
const userMessageHistory = new Map();

export function isDuplicateGroupMessage(userId, text) {
  const clean = text.trim().replace(/\s+/g, '').toLowerCase();
  if (!clean || clean.length < 2) return false;
  
  const key = `${userId}_${clean}`;
  const now = Date.now();
  const lastTime = userMessageHistory.get(key);
  
  // 4 second sliding window deduplication
  if (lastTime && (now - lastTime < 4000)) {
    return true; // Duplicate spam detected
  }
  
  userMessageHistory.set(key, now);
  
  // Maintenance: cleanup old keys
  if (userMessageHistory.size > 200) {
    for (const [k, v] of userMessageHistory.entries()) {
      if (now - v > 10000) userMessageHistory.delete(k);
    }
  }
  
  return false;
}

export function setActiveRocketRound(roundName, minVal, maxVal, isChotoy) {
  const tMin = minVal ? Number(minVal) : (activeRocketRound.targetMin || 330);
  const tMax = maxVal ? Number(maxVal) : (activeRocketRound.targetMax || 380);
  activeRocketRound = {
    name: roundName || activeRocketRound.name || 'ช่างบั้งไฟสด',
    targetMin: tMin,
    targetMax: tMax,
    isChotoy: Boolean(isChotoy),
    status: 'ACTIVE',
    startTime: new Date()
  };
  activeTargetMin = tMin;
  activeTargetMax = tMax;
  applyQuoteToPreQuoteBets(tMin, tMax);
  return activeRocketRound;
}

export function setRocketRoundStatus(status) {
  const normStatus = (status || '').toString().toUpperCase();
  if (!activeRocketRound) {
    activeRocketRound = { name: 'ทั่วไป', status: normStatus, startTime: new Date() };
  } else {
    activeRocketRound.status = normStatus;
  }
  if (normStatus === 'CLOSED') {
    cancelUnquotedPreQuoteBets();
  }
  return activeRocketRound;
}

export function isRocketRoundClosed() {
  return activeRocketRound && activeRocketRound.status === 'CLOSED';
}

export function getActiveRocketRound() {
  return activeRocketRound;
}

let activeMechanicPrice = { min: 330, max: 370 };

export function setActiveMechanicPrice(min, max) {
  activeMechanicPrice = { min: Number(min) || 330, max: Number(max) || 370 };
  return activeMechanicPrice;
}

export function getActiveMechanicPrice() {
  return activeMechanicPrice;
}


