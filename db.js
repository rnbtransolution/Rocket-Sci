import {
  batchFetchSheets,
  appendRowToSheet,
  updateRowInSheet,
  overwriteSheet,
  queueWrite,
} from './sheetsHelper.js';

let players = [];
let transactions = [];
let bets = [];
let chatLogs = [];

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
export async function init(isSilent = false) {
  try {
    const data = await batchFetchSheets();

    // 1. Players Sheet (Only update if valid data returned from Sheets)
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
    }

    // 3. Bets Sheet
    if (data.bets && data.bets.length > 1) {
      bets = data.bets.slice(1).map((row) => ({
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
        timestamp: row[11] ? formatTime(row[11]) : '',
      }));
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
    }

    if (!isSilent) {
      console.log(
        `[DB] Initialized: ${players.length} players, ${transactions.length} transactions, ${bets.length} bets, ${chatLogs.length} chat logs.`
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

export function recordGroupActivity(groupId, groupName, userId, displayName, text) {
  if (!groupId || typeof groupId !== 'string' || groupId.length <= 5) return;
  activeGroupId = groupId;
  let group = lineGroups.find(g => g.id === groupId);
  const nowStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  const existingIdx = lineGroups.findIndex(g => g.id === groupId);
  const groupNumber = existingIdx !== -1 ? (existingIdx + 1) : (lineGroups.length + 1);

  let cleanName = groupName;
  if (!cleanName || cleanName.startsWith('C') || cleanName.includes(groupId) || !isNaN(cleanName)) {
    cleanName = `🚀 กลุ่มดวลสด #${groupNumber}`;
  }

  if (!group) {
    group = {
      id: groupId,
      name: cleanName,
      lastMessage: text || 'มีการเคลื่อนไหวในกลุ่ม',
      timestamp: nowStr,
      msgCount: 1
    };
    lineGroups.push(group);
  } else {
    group.lastMessage = text || group.lastMessage;
    group.timestamp = nowStr;
    group.msgCount = (group.msgCount || 0) + 1;
    if (groupName && !groupName.startsWith('C') && !groupName.includes(groupId) && isNaN(groupName)) {
      group.name = groupName;
    }
  }
}

export function saveActiveGroupId(groupId) {
  if (groupId && typeof groupId === 'string' && groupId.length > 5) {
    activeGroupId = groupId;
    recordGroupActivity(groupId, null, null, null, 'เชื่อมต่อแล้ว');
  }
}

export function getActiveGroupId() {
  return activeGroupId;
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
export async function getOrCreateShortUserId(rawLineUserId, displayName) {
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
export async function getPlayerBalance(userId, displayName) {
  const shortUserId = await getOrCreateShortUserId(userId, displayName);
  const searchId = cleanUserId(shortUserId);
  if (!searchId) return 0;
  
  const player = players.find((p) => cleanUserId(p.id) === searchId);
  return player ? player.balance : 0;
}

// adjust a player's balance (adds or deducts credits with strict anti-overdraft protection)
export async function adjustPlayerBalance(userId, delta, displayName) {
  const shortUserId = await getOrCreateShortUserId(userId, displayName);
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
export function saveOpenBet(
  orderNo,
  userId,
  displayName,
  side,
  amount,
  type,
  rMin,
  rMax,
  targetGroupId = null,
  targetGroupName = null
) {
  const searchId = cleanUserId(userId);
  const betAmount = Number(amount) || 0;

  // Anti-Overdraft Guard: verify creator has sufficient balance
  const player = players.find((p) => cleanUserId(p.id) === searchId);
  const currentBalance = player ? player.balance : 0;
  if (betAmount > 0 && currentBalance < betAmount) {
    return { error: 'INSUFFICIENT_BALANCE', required: betAmount, current: currentBalance };
  }
  // Lock creator's credit
  if (betAmount > 0 && player) {
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

  const newBet = {
    id: 'bet_' + orderNo,
    orderNumber: orderNo.toString(),
    playerLowId: lowId,
    playerLowName: lowName,
    playerHighId: highId,
    playerHighName: highName,
    amount: betAmount,
    type: type,
    rangeMin: rMin ? Number(rMin) : null,
    rangeMax: rMax ? Number(rMax) : null,
    status: 'pending_match',
    winnerName: '',
    timestamp: formatTime(now),
    groupId: assignedGroupId,
    groupName: assignedGroupName
  };
  bets.unshift(newBet); // Add to beginning of memory list

  appendRowToSheet('Bets', [
    orderNo.toString(),
    lowId,
    lowName,
    highId,
    highName,
    betAmount.toString(),
    type,
    rMin ? rMin.toString() : '',
    rMax ? rMax.toString() : '',
    'pending_match',
    '',
    assignedGroupId,
    assignedGroupName
  ]);

  if (pushTargets.length > 0) {
    import('./lineBot.js').then(lineBot => {
      const rangeInfo = rMin && rMax ? `${rMin}-${rMax}s` : '';
      const betCard = lineBot.constructBetOpenFlex(orderNo, betAmount, side, displayName, rangeInfo);
      pushTargets.forEach(targetId => {
        lineBot.pushToLine(targetId, betCard);
      });
    }).catch(err => {
      console.error('Error pushing order flex to LINE groups:', err);
    });
  }

  return newBet;
}

// match against an existing open bet (supports optional specific target order number e.g. "12" or "123456")
export async function matchExistingOpenBet(userId, displayName, targetOrderNo = null) {
  const searchId = cleanUserId(userId);
  const matcherPlayer = players.find((p) => cleanUserId(p.id) === searchId);
  const matcherBal = matcherPlayer ? matcherPlayer.balance : 0;
  const cleanTargetOrder = targetOrderNo ? targetOrderNo.toString().trim().replace(/#/g, '') : null;

  // Search by target order first if specified
  let targetBet = null;
  if (cleanTargetOrder) {
    targetBet = bets.find((b) => {
      const orderStr = b.orderNumber.toString();
      return orderStr === cleanTargetOrder || orderStr.endsWith(cleanTargetOrder);
    });
  }

  if (cleanTargetOrder && !targetBet) {
    return { error: 'NOT_FOUND', targetOrderNo: cleanTargetOrder };
  }

  if (targetBet) {
    if (targetBet.status === 'matched' || targetBet.status === 'resolved' || targetBet.status === 'cancelled') {
      return { error: 'ALREADY_MATCHED', orderNumber: targetBet.orderNumber };
    }

    const creatorId = targetBet.playerLowId ? cleanUserId(targetBet.playerLowId) : cleanUserId(targetBet.playerHighId);
    if (creatorId === searchId) {
      return { error: 'OWN_BET', orderNumber: targetBet.orderNumber };
    }

    if (matcherBal < targetBet.amount) {
      return { error: 'INSUFFICIENT_BALANCE', required: targetBet.amount, current: matcherBal, orderNumber: targetBet.orderNumber };
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
export async function cancelOpenBet(userId, targetOrderNo = null, isAdmin = false) {
  const searchId = cleanUserId(userId);
  const cleanTargetOrder = targetOrderNo ? targetOrderNo.toString().trim().replace(/#/g, '') : null;

  for (const bet of bets) {
    if (bet.status === 'pending_match') {
      const creatorId = bet.playerLowId ? cleanUserId(bet.playerLowId) : cleanUserId(bet.playerHighId);
      const creatorName = bet.playerLowName || bet.playerHighName || 'ผู้เล่น';

      // If specific order requested, verify match
      if (cleanTargetOrder) {
        const orderStr = bet.orderNumber.toString();
        if (orderStr !== cleanTargetOrder && !orderStr.endsWith(cleanTargetOrder)) {
          continue;
        }
      }

      // Authorization Guard: Only bet creator or admin can cancel an open bet
      if (creatorId !== searchId && !isAdmin) {
        return { error: 'UNAUTHORIZED', creatorName: creatorName, orderNumber: bet.orderNumber };
      }

      // Mark status as cancelled
      bet.status = 'cancelled';

      // Update in Google Sheets
      updateRowInSheet('Bets', bet.orderNumber, {
        9: 'cancelled',
      });

      // Refund full credit back to creator
      await adjustPlayerBalance(creatorId, bet.amount, creatorName);

      return {
        success: true,
        orderNumber: bet.orderNumber,
        amount: bet.amount,
        creatorId: creatorId,
        creatorName: creatorName,
      };
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
  const now = new Date();
  const refStr = refCode ? refCode.toString().toUpperCase() : '';
  const reasonStr = reason ? reason.toString().toLowerCase() : '';
  const isWithdraw = refStr.includes('WD') || refStr.includes('WITHDRAW') || reasonStr.includes('withdraw');
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
    updateRowInSheet('Transactions', txId, { 5: amountToAdd, 6: 'success', 7: tx.reviewReason });

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
        logLineChatMessage(tx.playerId, tx.playerName || 'ผู้เล่น', 'bot', `💸 [อนุมัติการถอนเงิน] จำนวน ${tx.requestedAmount.toLocaleString()} THB โอนเข้าบัญชีสำเร็จแล้วครับ 🚀`, 'text');
      } else {
        const flex = lineBot.constructBankingFlex("deposit", amountToAdd, "เติมเงินสำเร็จ (แอดมินอนุมัติเรียบร้อย)", null, tx.playerId);
        await lineBot.pushToLine(tx.playerId, flex);
        logLineChatMessage(tx.playerId, tx.playerName || 'ผู้เล่น', 'bot', `🟢 [อนุมัติการเติมเงิน] จำนวน ${amountToAdd.toLocaleString()} pt เติมเข้าบัญชีสำเร็จเรียบร้อยครับ 🚀`, 'text');
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
        logLineChatMessage(tx.playerId, tx.playerName || 'ผู้เล่น', 'bot', `❌ [ปฏิเสธการถอนเงิน] ยอด ${tx.requestedAmount.toLocaleString()} THB (คืนแต้มเข้าบัญชีแล้ว | สาเหตุ: ${reason || 'ข้อมูลไม่ถูกต้อง'})`, 'text');
      } else {
        const flex = lineBot.constructRejectionFlex("DP", tx.requestedAmount, reason || 'สลิปไม่ผ่านเกณฑ์ตรวจสอบ', currentBalance, tx.playerId);
        await lineBot.pushToLine(tx.playerId, flex);
        logLineChatMessage(tx.playerId, tx.playerName || 'ผู้เล่น', 'bot', `❌ [ปฏิเสธสลิปฝากเงิน] ยอด ${tx.requestedAmount.toLocaleString()} THB (สาเหตุ: ${reason || 'สลิปไม่ผ่านเกณฑ์'})`, 'text');
      }
    } catch (err) {
      console.error("[DB] Error sending Line rejection notification:", err);
    }
  }
  return getDashboardData();
}

export async function adminResolveBets(finalTime, targetMinOrTime, targetMaxParam, sendPushCallback) {
  // Support both single target or range target (e.g. 330 - 380)
  let targetMin = Number(targetMinOrTime) || 350;
  let targetMax = targetMin;
  let callback = sendPushCallback;

  if (typeof targetMaxParam === 'number' || (typeof targetMaxParam === 'string' && targetMaxParam !== '' && !isNaN(Number(targetMaxParam)))) {
    targetMax = Number(targetMaxParam);
  } else if (typeof targetMaxParam === 'function') {
    callback = targetMaxParam;
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
        for (const g of targetGroups) {
          await lineBot.pushToLine(g.id, roundNotice);
        }
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
      const minSec = (type === 'range' && bet.rangeMin !== null && bet.rangeMax !== null) ? Number(bet.rangeMin) : Number(targetMin);
      const maxSec = (type === 'range' && bet.rangeMin !== null && bet.rangeMax !== null) ? Number(bet.rangeMax) : Number(targetMax);

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

      // Send push notifications to winner & loser
      if (sendPushCallback) {
        try {
          const winBal = players.find((p) => cleanUserId(p.id) === winnerId)?.balance || 0;
          const loseBal = players.find((p) => cleanUserId(p.id) === loserId)?.balance || 0;

          await sendPushCallback(winnerId, true, bet.orderNumber, amount, finalTime, payout, winBal, winnings, commission);
          await sendPushCallback(loserId, false, bet.orderNumber, amount, finalTime, 0, loseBal, winnings, commission);
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
      const outcomeText = finalTime < targetMin ? 'ต่ำ (ชล) 🔵' : finalTime > targetMax ? 'สูง (ชถ) 🔴' : 'ในราคาช่าง 🎯';
      const roundNotice = `🏆 [ประกาศผลสรุปดวล]: ${finalTime}s (ราคาช่าง ${targetMin}-${targetMax}s) | ฝั่งชนะ: ${outcomeText} 🚀`;
      for (const g of targetGroups) {
        await lineBot.pushToLine(g.id, roundNotice);
      }
      logLineChatMessage('SYSTEM', '🤖 Rocket Bot', 'bot', roundNotice, 'text');
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

  const targetGroups = lineGroups.length > 0 ? lineGroups : (activeGroupId ? [{ id: activeGroupId }] : []);
  if (targetGroups.length > 0) {
    try {
      const lineBot = await import('./lineBot.js');
      const roundNotice = `⛔ [โมฆะรอบ / ช่าง ⛔]: ยกเลิกแผลดวลค้างทั้งหมด และคืนแต้ม 100% เรียบร้อยครับ 🚀`;
      for (const g of targetGroups) {
        await lineBot.pushToLine(g.id, roundNotice);
      }
      logLineChatMessage('SYSTEM', '🤖 Rocket Bot', 'bot', roundNotice, 'text');
    } catch (e) {
      console.error("[DB] Error broadcasting void round to groups:", e);
    }
  }

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
  const orderStr = orderNo.toString().trim();
  const bet = bets.find((b) => b.orderNumber === orderStr);

  if (!bet) return `🚫 ไม่พบแผลดวล Order #${orderNo} ในระบบครับ`;

  if (
    cleanUserId(bet.playerLowId) !== searchId &&
    cleanUserId(bet.playerHighId) !== searchId
  ) {
    return '🚫 ขออภัยครับ แผลดวลนี้ไม่ใช่แผลของคุณ';
  }

  if (bet.status === 'resolved' || bet.status === 'cancelled') {
    return `⚠️ แผลดวล Order #${orderNo} จบหรือถูกยกเลิกแล้วครับ`;
  }

  if (bet.status === 'pending_match') {
    bet.status = 'cancelled';
    updateRowInSheet('Bets', orderStr, { 9: 'cancelled' });
    await adjustPlayerBalance(searchId, bet.amount);
    return `🚫 ยกเลิกแผล Order #${orderNo} สำเร็จ!\nคืนแต้ม ${bet.amount}pt เรียบร้อยครับ 🚀`;
  }

  if (bet.status === 'matched') {
    bet.status = 'pending_cancel';
    updateRowInSheet('Bets', orderStr, { 9: 'pending_cancel' });
    return `⛔ ร้องขอยกเลิก Order #${orderNo} (รอคู่ดวลกดยืนยันครับ 🚀)`;
  }

  return '🚫 ผิดพลาดในการปรับปรุงสถานะแผล';
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
let activeRocketRound = { name: 'ทั่วไป', status: 'ACTIVE', startTime: new Date() };
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

export function setActiveRocketRound(roundName) {
  activeRocketRound = {
    name: roundName,
    status: 'ACTIVE',
    startTime: new Date()
  };
  return activeRocketRound;
}

export function setRocketRoundStatus(status) {
  if (!activeRocketRound) {
    activeRocketRound = { name: 'ทั่วไป', status: status, startTime: new Date() };
  } else {
    activeRocketRound.status = status;
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


