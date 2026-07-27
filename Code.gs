// =========================================================================
// GOOGLE APPS SCRIPT WEBHOOK, TELEMETRY & DB CONTROLLER (Code.gs)
// Project: Rocket Science Billing & Telemetry System
// =========================================================================

// CONFIGURATION CONSTANTS (Update these in your GAS environment)
const LINE_CHANNEL_ACCESS_TOKEN = 'imrgIDDKJzCz68l399JwA9h7O0DGfHeJYEH4BychnR766i6GfWTTENcpm3MshP37uQMGIrV3GoGY9UsMC3li2Yxvq4BYIJjwND1u4GJgppSR0EJPfnGrY+56hzfW0bh0zNyCfQz5wUCABcIhaLGl9gdB04t89/1O/w1cDnyilFU=';
const SLIP_API_KEY = '697ef678-60df-4955-a13a-6ed4e26a38c0'; // SlipOk or EasySlip
const SLIP_API_URL = 'https://api.easyslip.com/v2/verify/bank'; // EasySlip bank verification endpoint
let SHEET_ID = '';
try {
  SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
} catch (err) {
  // If standalone script, sheet ID can be hardcoded here or set via settings
  console.warn("SpreadsheetApp.getActiveSpreadsheet() failed. Standalone mode assumed.");
}

/**
 * HTTP GET: Serves the bundled React Admin & Simulator UI.
 * This runs when accessing the GAS Web App URL in a browser.
 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
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
        
        if (message.type === 'text') {
          const groupId = event.source.groupId || event.source.roomId || null;
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
function handleCancelBetRequest(userId, orderNo) {
  var searchId = cleanUserId(userId);
  if (!searchId || !orderNo) return "❌ ผิดพลาด: ไม่สามารถทำรายการได้";
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  const data = sheet.getDataRange().getValues();
  const searchOrder = orderNo.toString().trim();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0].toString().trim() === searchOrder) {
      const status = row[9];
      const playerLowId = row[1] ? row[1].toString().trim() : '';
      const playerHighId = row[3] ? row[3].toString().trim() : '';
      const amount = Number(row[5]) || 0;
      
      if (playerLowId !== searchId && playerHighId !== searchId) {
        return "❌ ขออภัยค่ะ แผลดวลนี้ไม่ใช่แผลของคุณ";
      }
      
      if (status === 'resolved' || status === 'cancelled') {
        return "⚠️ แผลดวลนี้จบหรือถูกยกเลิกไปแล้วเรียบร้อยค่ะ";
      }
      
      if (status === 'pending_match') {
        // Direct cancel
        sheet.getRange(i + 1, 10).setValue('cancelled');
        // Refund credit to the creator
        adjustPlayerBalance(userId, amount);
        return `❌ ยกเลิกแผล Order #${orderNo} สำเร็จ!\nระบบได้ทำการยกเลิกแผลและคืนแต้ม ${amount} เครดิตเข้าบัญชีคุณเรียบร้อยแล้วค่ะ`;
      }
      
      if (status === 'matched') {
        // Request cancel
        sheet.getRange(i + 1, 10).setValue('pending_cancel');
        return `⚠️ ร้องขอยกเลิกแผล Order #${orderNo} สำเร็จ\nเนื่องจากแผลถูกจับคู่แล้ว ต้องรอการยืนยันยกเลิกจากฝั่งคู่ดวลของคุณค่ะ`;
      }
    }
  }
  return `❌ ไม่พบเลขแผลดวล Order #${orderNo} ในระบบ`;
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
    const balance = getPlayerBalance(userId, displayName);
    const balanceFlex = constructBalanceFlex(displayName, balance);
    replyToLine(replyToken, balanceFlex, userId);
    return;
  }
  
  // B. LIST ACTIVE DEALS ("รายการจับคู่", "matched", "รายการดวล")
  if (clean === 'รายการจับคู่' || clean === 'matched' || clean === 'รายการดวล') {
    const matchedBets = getPlayerActiveBets(userId);
    if (matchedBets.length === 0) {
      replyToLine(replyToken, `📝 รายการดวลของคุณ:\n\n❌ ปัจจุบันไม่มีแผลดวลค้างหรือรอคู่ในระบบค่ะ`, userId);
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

  // C. CANCEL DEAL REQUEST ("ยกเลิก [orderNo]")
  const cancelRegex = /^(ยกเลิก|cancel)(?:order|#)?(\d+)$/;
  if (cancelRegex.test(clean)) {
    const match = clean.match(cancelRegex);
    const orderNo = match[2];
    const result = handleCancelBetRequest(userId, orderNo);
    replyToLine(replyToken, result, userId);
    return;
  }
  
  // D. INITIATE DEPOSIT ("ฝากเงิน", "เติมเงิน", "deposit", "เติมเครดิต")
  if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit' || clean === 'เติมเครดิต') {
    const depositFlex = constructDepositFlex();
    replyToLine(replyToken, depositFlex, userId);
    return;
  }

  // E. INITIATE WITHDRAWAL ("ถอนเงิน", "ถอนยอด", "withdraw")
  if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
    const bank = getPlayerBank(userId);
    if (!bank) {
      // Check if they have deposited at all (may have been approved manually without bank data captured)
      if (hasSuccessfulDeposit(userId)) {
        // They have a real deposit but no bank registered — prompt them to register
        const regFlex = constructBankRegistrationFlex();
        replyToLine(replyToken, regFlex, userId);
      } else {
        replyToLine(replyToken, `❌ ไม่พบประวัติการฝากเงินผ่านระบบ!\n\nเพื่อความปลอดภัยสูงสุด กรุณาฝากเงินเข้ามาก่อนค่ะ`, userId);
      }
    } else {
      const balance = getPlayerBalance(userId, displayName);
      const withdrawFlex = constructWithdrawalFlex(bank.bankName, bank.accountNumber, bank.accountName, balance);
      replyToLine(replyToken, withdrawFlex, userId);
    }
    return;
  }

  // F1. BANK ACCOUNT REGISTRATION - DISABLED FOR SECURITY
  // Players cannot self-register bank accounts. Admin must verify and set from the dashboard.
  // This prevents players from registering arbitrary/fake account numbers.
  const bankRegRegex = /^(บัญชี|ลงทะเบียนบัญชี|สมัครบัญชี)\s+(\S+)\s+([\d\-\.]+)\s+(.+)$/;
  if (bankRegRegex.test(normalized)) {
    // Player typed a bank registration command — redirect them to send passbook photo instead
    replyToLine(replyToken,
      `📋 การลงทะเบียนบัญชีธนาคารต้องผ่านการยืนยันจากทีมงานค่ะ\n\n` +
      `📸 กรุณาถ่ายรูปหน้าสมุดบัญชี หรือสกรีนช็อตแอปธนาคาร ที่แสดง\n` +
      `  • ชื่อ-นามสกุลเจ้าของบัญชี\n` +
      `  • เลขบัญชีที่ใช้โอนเงินเข้ามาครั้งแรก\n\n` +
      `แล้วส่งรูปมาในแชทนี้เลยค่ะ ทีมงานจะดำเนินการลงทะเบียนให้ภายใน 24 ชั่วโมง\n\n` +
      `📞 สอบถาม: 089-104-1992`,
      userId
    );
    return;
  }

  // F2. PROCESS WITHDRAWAL REQUEST ("ถอน [amount]")
  const withdrawRegex = /^(ถอน|withdraw)(\d+)$/;
  if (withdrawRegex.test(clean)) {
    const match = clean.match(withdrawRegex);
    const withdrawAmt = parseInt(match[2]);
    const bank = getPlayerBank(userId);
    if (!bank) {
      // Bank must be set by admin — ask player to submit their bank passbook photo
      replyToLine(replyToken,
        `🏦 ยังไม่มีข้อมูลบัญชีธนาคารในระบบของท่านค่ะ\n\n` +
        `📸 กรุณาส่งรูปถ่าย หรือสกรีนช็อต หน้าสมุดบัญชีธนาคารที่แสดง:\n` +
        `  • ชื่อ-นามสกุล เจ้าของบัญชี\n` +
        `  • เลขบัญชีที่ตรงกับบัญชีที่โอนเงินเข้ามาค่ะ\n\n` +
        `⚠️ ต้องเป็นบัญชีเดียวกับที่ใช้โอนเงินฝากเข้ามาเท่านั้น\n\n` +
        `ทีมงานจะตรวจสอบและลงทะเบียนให้ภายใน 24 ชั่วโมงค่ะ\n` +
        `📞 ติดต่อด่วน: 089-104-1992`,
        userId
      );
      return;
    }
    const balance = getPlayerBalance(userId, displayName);
    if (withdrawAmt <= 0) {
      replyToLine(replyToken, `❌ จำนวนเงินถอนต้องมากกว่า 0 แต้มค่ะ`, userId);
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
    
    replyToLine(replyToken, `📥 ได้รับคำขอถอนเงินจำนวน ${withdrawAmt} แต้ม เรียบร้อยแล้วค่ะ!\n\nระบบกำลังส่งต่อข้อมูลให้แอดมินพิจารณาอนุมัติโอนเงินแบบแมนนวลเข้าบัญชีธนาคาร ${bank.bankName} เลขบัญชี ${bank.accountNumber} ของคุณค่ะ\n\nยอดคงเหลือหลังทำรายการ: ${balance - withdrawAmt} แต้ม`, userId);
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
      replyToLine(replyToken, `⚠️ ขออภัยค่ะ ระบบรองรับการฝากยอดขั้นต่ำ 100 THB และสูงสุดไม่เกิน 10,000 THB ต่อครั้งค่ะ`, userId);
      return;
    }
    
    // Log pending deposit transaction
    logTransaction(userId, displayName, depositAmt, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
    
    const invoiceFlex = constructDepositInvoiceFlex(depositAmt);
    replyToLine(replyToken, invoiceFlex, userId);
    return;
  }

  // 1. MECHANIC STATUS QUERY / ANNOUNCEMENT
  if (['ช่างต่อย', 'ช่างมีราคา', 'ช่างตีราคา'].indexOf(clean) !== -1) {
    replyToLine(replyToken, `🔧 [สถานะราคาช่าง]\n\n✅ ช่างต่อย (ช่างมีราคา / ช่างตีราคาแล้ว)\nเปิดรับแทงราคาช่างเรียบร้อยค่ะ 🚀`, userId);
    return;
  }
  if (['ช่างไม่ต่อย', 'ช่างไม่มีราคา', 'ช่างไม่ตีราคา', 'ช่างไม่เปิดราคา'].indexOf(clean) !== -1) {
    replyToLine(replyToken, `🔧 [สถานะราคาช่าง]\n\n⚠️ ช่างไม่ต่อย (ช่างไม่มีราคา / ช่างไม่ตีราคา / ช่างไม่เปิดราคา)\nให้ผู้เล่นเจรจาเสนอเปิดราคาเป็นตัวเลขได้เลยค่ะ 🚀`, userId);
    return;
  }

  // 2. MATCH ACTION: ACCEPT / LOCK DEALS ("ต", "ติด", "ครับ", "เค", "จ้า", "ยอมรับ", "ดีล", "รับแผล", "รับ")
  if (['ต', 'ติด', 'ครับ', 'เค', 'จ้า', 'ยอมรับ', 'ดีล', 'รับแผล', 'รับ'].indexOf(clean) !== -1) {
    const matchedBet = matchExistingOpenBet(userId, displayName);
    if (matchedBet) {
      replyToLine(replyToken, `✅ จับคู่สำเร็จ! (Order #${matchedBet.orderNumber})\nยอดดวล: ${matchedBet.amount} แต้ม\nฝั่งต่ำ (Low): ${matchedBet.playerLowName}\nฝั่งสูง (High): ${matchedBet.playerHighName}\n\nระบบล็อกเครดิตทั้งคู่แล้ว รอการสรุปผลจรวดครับ 🚀`, userId);
    } else {
      replyToLine(replyToken, `❌ ไม่มีแผลดวลเปิดรับอยู่ในขณะนี้`, userId);
    }
    return;
  }
  
  // 3. PARSE BET FORMULAS (ชล100, ชถ500, 300-340ล100, ก+5ล200, ก-5ถ400, ม+5ล100, +5ล300, -5ถ400, 300-330ถ300ชตย, etc.)
  const isChotoy = clean.indexOf('ชตย') !== -1;
  const cleanBetText = clean.replace(/ชตย/g, '').trim();

  const keywordsLowBase = ['ชล', 'ล', 'ไล่', 'ช่างไล่'];
  const keywordsHighBase = ['ชย', 'ชถ', 'ย', 'ถ', 'ยั่ง', 'ถอย', 'ช่างยั่ง', 'ช่างถอย'];

  const fullBetRegex = /^(?:(\d+)-(\d+))?\s*(?:(ก|เกิบ|ม|หมวก)?([+-]\d+))?\s*(ชล|ล|ไล่|ช่างไล่|ชย|ชถ|ย|ถ|ยั่ง|ถอย|ช่างยั่ง|ช่างถอย)\s*(\d+)?$/;

  let betType = '';
  let rangeMin = null;
  let rangeMax = null;
  let side = '';
  let amount = 0;

  if (fullBetRegex.test(cleanBetText)) {
    const match = cleanBetText.match(fullBetRegex);
    const rawMin = match[1];
    const rawMax = match[2];
    const modifierTarget = match[3];
    const modifierVal = match[4];
    const sideKeyword = match[5];
    const rawAmount = match[6];

    if (keywordsLowBase.indexOf(sideKeyword) !== -1) side = 'low';
    else if (keywordsHighBase.indexOf(sideKeyword) !== -1) side = 'high';

    if (side) {
      amount = rawAmount ? parseInt(rawAmount) : 500;
      rangeMin = rawMin ? parseInt(rawMin) : null;
      rangeMax = rawMax ? parseInt(rawMax) : null;

      if (modifierVal) {
        const offset = parseInt(modifierVal);
        if (rangeMin === null || rangeMax === null) {
          rangeMin = 330;
          rangeMax = 370;
        }
        const target = (modifierTarget || '').toLowerCase();
        if (target === 'ก' || target === 'เกิบ') {
          rangeMin += offset;
        } else if (target === 'ม' || target === 'หมวก') {
          rangeMax += offset;
        } else {
          rangeMin += offset;
          rangeMax += offset;
        }
      }

      betType = (rangeMin !== null && rangeMax !== null) ? 'range' : 'high_low';
    }
  }

  if (!side || amount < 10) {
    // Check if the user is typing "เมนู" or "menu" or "สวัสดี" or if it is an unrecognized private message
    const isPrivateChat = !groupId;
    if (isPrivateChat || clean === 'เมนู' || clean === 'menu' || clean === 'สวัสดี' || clean === 'help' || clean === 'เริ่ม' || clean === 'start') {
      const mainMenuFlex = constructMainMenuFlex();
      replyToLine(replyToken, mainMenuFlex, userId);
    }
    return;
  }
  
  // Check user credit balance
  const balance = getPlayerBalance(userId, displayName);
  if (balance < amount) {
    replyToLine(replyToken, `❌ เครดิตคงเหลือไม่เพียงพอ!\nยอดปัจจุบันของคุณ: ${balance} แต้ม\nต้องการใช้: ${amount} แต้ม\n\nกรุณาเติมแต้มด้วยการแจ้งเติมเงินและส่งรูปภาพสลิปที่ห้องหลังบ้านครับ`, userId);
    return;
  }
  
  // Lock credits from player balance
  adjustPlayerBalance(userId, -amount);
  
  // Write to Sheets database as open bet
  const orderNumber = Math.floor(Math.random() * 89999 + 10000).toString();
  saveOpenBet(orderNumber, userId, displayName, side, amount, betType, rangeMin, rangeMax);
  
  let rangeInfo = '';
  if (betType === 'range') {
    rangeInfo = `${rangeMin}-${rangeMax}${isChotoy ? ' (ชตย: ช่างต่อยยุติ)' : ''}`;
  } else if (isChotoy) {
    rangeInfo = '(ชตย: ช่างต่อยยุติ)';
  }
  
  const betOpenFlex = constructBetOpenFlex(orderNumber, amount, side, displayName, rangeInfo);
  replyToLine(replyToken, betOpenFlex, userId);
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
  
  // Match check against requested buy-in credit session
  var requestedAmount = findPendingRequestedAmount(userId);
  if (requestedAmount === null) {
    // If player did not select an amount beforehand and sent the slip directly,
    // we bypass the mismatch verification and accept the slip amount directly.
    requestedAmount = actualAmount;
  }
  
  if (requestedAmount !== actualAmount) {
    logTransaction(userId, displayName, requestedAmount, actualAmount, refCode, 'escalated', `Amount Mismatch (Requested ${requestedAmount} vs Slip ${actualAmount})`);
    replyToLine(replyToken, `⚠️ ยอดสลิปไม่ตรงบิล!\nแจ้งซื้อ ${requestedAmount} แต้ม แต่โอนจริง ${actualAmount} บาท ส่งให้แอดมินรีวิวยอดแมนนวลครับ`);
    return;
  }
 
  
  // SUCCESS: Credit player balance 1:1, log transaction as success
  adjustPlayerBalance(userId, actualAmount, displayName);
  
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

  logTransaction(userId, displayName, requestedAmount, actualAmount, refCode, 'success', 'Auto credited via slip API 1:1');
  const details = "เติมเงินสำเร็จผ่านระบบสแกนสลิปอัตโนมัติ เลขอ้างอิง: " + refCode;
  const slipFlex = constructBankingFlex("Income", actualAmount, details, null, userId);
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
  if (!searchId) return;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  const numericDelta = Number(delta) || 0;
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      const cell = sheet.getRange(i + 1, 3);
      const currentBalance = Number(data[i][2]) || 0;
      cell.setValue(currentBalance + numericDelta);
      return;
    }
  }
}


function saveOpenBet(orderNo, userId, displayName, side, amount, type, rMin, rMax) {
  var searchId = cleanUserId(userId);
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
    new Date()
  ]);
}

function matchExistingOpenBet(userId, displayName) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[9] === 'pending_match') {
      const orderNo = row[0];
      const amount = row[5];
      
      let playerLowId = row[1];
      let playerLowName = row[2];
      let playerHighId = row[3];
      let playerHighName = row[4];
      
      if (playerLowId === userId || playerHighId === userId) continue; // No self match
      
      const creatorId = playerLowId ? playerLowId : playerHighId;
      
      if (!playerLowId) {
        playerLowId = userId;
        playerLowName = displayName;
      } else {
        playerHighId = userId;
        playerHighName = displayName;
      }
      
      // Update matched records
      sheet.getRange(i + 1, 2).setValue(playerLowId);
      sheet.getRange(i + 1, 3).setValue(playerLowName);
      sheet.getRange(i + 1, 4).setValue(playerHighId);
      sheet.getRange(i + 1, 5).setValue(playerHighName);
      sheet.getRange(i + 1, 10).setValue('matched');
      
      // Deduct opponent credit too
      adjustPlayerBalance(userId, -amount);
      
      return {
        orderNumber: orderNo,
        amount: amount,
        playerLowName: playerLowName,
        playerHighName: playerHighName,
        creatorId: creatorId,
        matcherId: userId
      };
    }
  }
  return null;
}

function logTransaction(userId, displayName, reqAmt, actAmt, refCode, status, reason) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Transactions');
  const isWithdraw = (refCode && refCode.toString().indexOf('WD') === 0) || (reason && reason.toString().toLowerCase().indexOf('withdraw') !== -1);
  const prefix = isWithdraw ? 'WD' : 'TX';
  const txId = prefix + Date.now().toString().slice(-6);
  sheet.appendRow([txId, userId, displayName, reqAmt, actAmt, refCode, status, reason, new Date()]);
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
    messageObj = {
      type: 'flex',
      altText: 'ระบบบริการ Rocket Science 🚀',
      contents: text
    };
  } else {
    messageObj = { type: 'text', text: text };
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
  const msg = `🏦 แอดมินได้ลงทะเบียนบัญชีธนาคารสำหรับการถอนเงินของคุณแล้วค่ะ

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
  const msg = `🎉 ยินดีต้อนรับสู่ระบบ Rocket Science Billing ค่ะ!\n\nบัญชีของคุณถูกสร้างโดยแอดมินเรียบร้อยแล้ว\n💰 เครดิตเริ่มต้น: ${balance} แต้ม\n\nหากมีข้อสงสัยติดต่อฝ่ายสนับสนุน: 089-104-1992`;
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
      joinDate: row[3] ? Utilities.formatDate(new Date(row[3]), 'GMT+7', 'dd/MM/yy') : '-',
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
      slipRef: row[5].toString(),
      status: row[6].toString(),
      reviewReason: row[7].toString(),
      timestamp: row[8] ? Utilities.formatDate(new Date(row[8]), "GMT+7", "HH:mm:ss") : '',
      logs: [`Verified in Sheets Database`, `Status: ${row[6]}`]
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
      type: row[6].toString(),
      rangeMin: row[7] ? Number(row[7]) : null,
      rangeMax: row[8] ? Number(row[8]) : null,
      status: row[9].toString(),
      winnerName: row[10] ? row[10].toString() : '',
      timestamp: row[11] ? Utilities.formatDate(new Date(row[11]), "GMT+7", "HH:mm:ss") : ''
    });
  }

  // 4. LineChatLogs sheet (inline — reuses same ss, no extra openById call)
  const chatLogs = [];
  try {
    const cData = ss.getSheetByName('LineChatLogs').getDataRange().getValues();
    for (let i = 1; i < cData.length; i++) {
      const row = cData[i];
      chatLogs.push({
        timestamp: row[0] ? Utilities.formatDate(new Date(row[0]), "GMT+7", "HH:mm:ss") : '',
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
    chatLogs: chatLogs
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
      const actualAmount = Number(tData[i][4]) || 0;
      
      tSheet.getRange(i + 1, 7).setValue('success');
      tSheet.getRange(i + 1, 8).setValue('Manually approved by supervisor');
      
      if (searchId.indexOf('WD') === 0) {
        // Withdrawal: the balance was already deducted, we just record the actual payout in sheet
        tSheet.getRange(i + 1, 5).setValue(reqAmt);
        let details = "ถอนเงินคืนเข้าบัญชีของคุณ";
        const bank = getPlayerBank(userId);
        if (bank) {
          details = "โอนเข้าบัญชี " + bank.bankName + " " + bank.accountNumber + " (" + bank.accountName + ")";
        }
        const wdFlex = constructBankingFlex("Expense", reqAmt, details, null, userId);
        pushToLine(userId, wdFlex);
      } else {
        // Deposit: credit player balance
        adjustPlayerBalance(userId, actualAmount, displayName);
        // If the player still has no registered bank, try to extract from the transaction's reason field
        const existingBank = getPlayerBank(userId);
        if (!existingBank) {
          // reason field (col index 7) may contain "Withdrawal request to BANK ACCNO NAME" or similar
          // For deposits, we cannot reconstruct the sender bank from this row, so we
          // leave a flag so the player is prompted to register when they try to withdraw.
          // No-op here: bank registration is handled gracefully during withdrawal flow.
        }
        const dpFlex = constructBankingFlex("Income", actualAmount, "เติมเงินสำเร็จ (แอดมินอนุมัติแมนนวล)", null, userId);
        pushToLine(userId, dpFlex);
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
      
      if (searchId.indexOf('WD') === 0) {
        // Withdrawal rejected: refund the locked balance back to player
        adjustPlayerBalance(userId, reqAmt, displayName);
        const currentBalance = getPlayerBalance(userId, displayName);
        const rejFlex = constructRejectionFlex("WD", reqAmt, reason || 'ข้อมูลไม่ถูกต้อง', currentBalance, userId);
        pushToLine(userId, rejFlex);
      } else {
        const currentBalance = getPlayerBalance(userId, displayName);
        const rejFlex = constructRejectionFlex("DP", reqAmt, reason || 'สลิปไม่ผ่านเกณฑ์ตรวจสอบ', currentBalance, userId);
        pushToLine(userId, rejFlex);
      }
      return true;
    }
  }
  return false;
}


/**
 * Resolve matched bets in spreadsheet database based on final rocket time
 */
function adminResolveBets(finalTime, targetTime) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const bSheet = ss.getSheetByName('Bets');
  
  // 1. Perform automatic matching of any unmatched pending bets
  autoMatchPendingBets(ss, bSheet);
  
  // 2. Read sheet values again to resolve matched bets
  const bData = bSheet.getDataRange().getValues();
  const finalScaled = Math.round(finalTime * 100);
  const targetScaled = Math.round(targetTime * 100);
  
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
      const rangeMin = row[7] ? Number(row[7]) : null;
      const rangeMax = row[8] ? Number(row[8]) : null;
      
      let isLowWinner = true;
      if (type === 'range') {
        const midPoint = (rangeMin + rangeMax) / 2;
        if (finalScaled < rangeMin) {
          isLowWinner = true;
        } else if (finalScaled > rangeMax) {
          isLowWinner = false;
        } else {
          isLowWinner = finalScaled <= midPoint;
        }
      } else {
        isLowWinner = finalScaled < targetScaled;
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
function simulateTextMessageFromDashboard(text, userId, displayName) {
  handleTextMessage(text, userId, displayName, 'MOCK_REPLY_TOKEN');
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

function pushToLine(userId, text) {
  if (!userId || userId === 'user' || userId.startsWith('p')) return; // Simulator bypass
  
  const rawLineUserId = getRawLineUserId(userId);
  if (!rawLineUserId) return;
  
  const url = 'https://api.line.me/v2/bot/message/push';
  let messageObj;
  
  if (typeof text === 'object' && text !== null) {
    messageObj = {
      type: 'flex',
      altText: 'ระบบบริการ Rocket Science 🚀',
      contents: text
    };
  } else {
    messageObj = { type: 'text', text: text };
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
  UrlFetchApp.fetch(url, options);
  
  // Log the push message
  const logText = typeof text === 'object' ? '[Flex Message]' : text;
  logLineChatMessage(userId, 'ผู้ใช้', 'bot', logText, typeof text === 'object' ? 'flex' : 'text');
}

// =========================================================================
// LINE FLEX MESSAGE CREATOR HELPERS
// =========================================================================

function constructMainMenuFlex() {
  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "🚀 Rocket Science Billing",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "ยินดีต้อนรับสู่ระบบเติมทุนหลังบ้าน Rocket Science\nกรุณาเลือกบริการที่คุณต้องการทำรายการด้านล่างค่ะ",
          "size": "sm",
          "color": "#555555",
          "wrap": true
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "sm",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "ตรวจสอบยอด",
                "text": "เช็คยอด"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "ฝากเงิน",
                "text": "ฝากเงิน"
              }
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "sm",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "ถอนเงิน",
                "text": "ถอนเงิน"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "รายการดวล",
                "text": "รายการดวล"
              }
            }
          ]
        }
      ],
      "paddingAll": "16px"
    }
  };
}

function constructBalanceFlex(displayName, balance) {
  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💳 ยอดเครดิตคงเหลือของคุณ",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "👤 ผู้เล่น:",
              "color": "#888888",
              "size": "sm",
              "flex": 3
            },
            {
              "type": "text",
              "text": displayName,
              "weight": "bold",
              "color": "#333333",
              "size": "sm",
              "flex": 7,
              "align": "end"
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "md",
          "contents": [
            {
              "type": "text",
              "text": "💰 คงเหลือ:",
              "color": "#888888",
              "size": "sm",
              "flex": 3
            },
            {
              "type": "text",
              "text": balance.toFixed(2) + " แต้ม",
              "weight": "bold",
              "color": "#2E7D32",
              "size": "lg",
              "flex": 7,
              "align": "end"
            }
          ]
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "sm",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "ฝากเงิน",
                "text": "ฝากเงิน"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "ถอนเงิน",
                "text": "ถอนเงิน"
              }
            }
          ]
        },
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "action": {
            "type": "message",
            "label": "🏠 เมนูหลัก",
            "text": "เมนู"
          }
        }
      ],
      "paddingAll": "16px"
    }
  };
}

function constructDepositFlex() {
  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💰 ฝากเครดิตเข้าระบบ",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "กรุณาเลือกยอดเงินที่ต้องการฝากเพื่อรับใบแจ้งยอดโอนเงิน หรือพิมพ์ระบุจำนวนเงินที่ต้องการฝากอื่นๆ ได้เลยค่ะ",
          "size": "sm",
          "color": "#555555",
          "wrap": true
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "sm",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
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
              "color": "#00796B",
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
          "spacing": "sm",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
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
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "1,000 บาท",
                "text": "1000"
              }
            }
          ]
        },
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "action": {
            "type": "message",
            "label": "🏠 เมนูหลัก",
            "text": "เมนู"
          }
        }
      ],
      "paddingAll": "16px"
    }
  };
}

function constructDepositInvoiceFlex(depositAmt) {
  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "🧾 ใบแจ้งยอดโอนเงิน",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "md",
      "contents": [
        {
          "type": "text",
          "text": "กรุณาโอนเงินตามยอดด้านล่างนี้ และส่งรูปภาพสลิปที่ได้ลงในแชทนี้ ระบบจะสแกนและอัพเครดิตทันทีค่ะ",
          "size": "sm",
          "color": "#555555",
          "wrap": true
        },
        {
          "type": "separator"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "🏦 ธนาคาร:",
              "color": "#888888",
              "size": "sm",
              "flex": 4
            },
            {
              "type": "text",
              "text": "ไทยพาณิชย์ (SCB)",
              "weight": "bold",
              "color": "#333333",
              "size": "sm",
              "flex": 6,
              "align": "end"
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "🔢 เลขบัญชี:",
              "color": "#888888",
              "size": "sm",
              "flex": 4
            },
            {
              "type": "text",
              "text": "064-2-35656-6",
              "weight": "bold",
              "color": "#333333",
              "size": "sm",
              "flex": 6,
              "align": "end"
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "👤 ชื่อบัญชี:",
              "color": "#888888",
              "size": "sm",
              "flex": 4
            },
            {
              "type": "text",
              "text": "อิทธิรัตน์ แนวหล่า",
              "weight": "bold",
              "color": "#333333",
              "size": "sm",
              "flex": 6,
              "align": "end",
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
              "text": "💵 ยอดโอนตรง:",
              "color": "#888888",
              "size": "sm",
              "flex": 4
            },
            {
              "type": "text",
              "text": depositAmt + ".00 บาท",
              "weight": "bold",
              "color": "#2E7D32",
              "size": "md",
              "flex": 6,
              "align": "end"
            }
          ]
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "action": {
            "type": "message",
            "label": "🏠 เมนูหลัก",
            "text": "เมนู"
          }
        }
      ],
      "paddingAll": "16px"
    }
  };
}

/**
 * Flex message to prompt the player to register their bank account for withdrawal.
 * Shown when they have a successful deposit but no bank account on file.
 */
function constructBankRegistrationFlex() {
  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "📋 ยืนยันบัญชีธนาคาร",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md"
        },
        {
          "type": "text",
          "text": "เพื่อรับเงินโอนคืนอย่างปลอดภัย",
          "color": "#B2DFDB",
          "size": "sm"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "md",
      "contents": [
        {
          "type": "text",
          "text": "ระบบพบว่าคุณมียอดเงินในระบบแล้ว แต่ยังไม่ได้ลงทะเบียนบัญชีสำหรับรับเงินโอนคืน",
          "size": "sm",
          "color": "#555555",
          "wrap": true
        },
        {
          "type": "separator"
        },
        {
          "type": "text",
          "text": "📸 วิธีลงทะเบียนบัญชี:",
          "weight": "bold",
          "size": "sm",
          "color": "#00695C"
        },
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#E0F2F1",
          "cornerRadius": "8px",
          "paddingAll": "12px",
          "spacing": "sm",
          "contents": [
            {
              "type": "text",
              "text": "📷 ถ่ายรูปหน้าสมุดบัญชี หรือ สกรีนช็อตแอปธนาคาร ที่แสดง:",
              "size": "sm",
              "color": "#004D40",
              "wrap": true
            },
            {
              "type": "text",
              "text": "• ชื่อ-นามสกุล เจ้าของบัญชี",
              "size": "sm",
              "color": "#00695C",
              "wrap": true
            },
            {
              "type": "text",
              "text": "• เลขบัญชีที่ใช้โอนเงินฝากเข้ามาเท่านั้น",
              "size": "sm",
              "color": "#00695C",
              "wrap": true
            },
            {
              "type": "text",
              "text": "แล้วส่งรูปในแชทนี้ได้เลยค่ะ",
              "size": "sm",
              "color": "#004D40",
              "weight": "bold",
              "wrap": true
            }
          ]
        },
        {
          "type": "text",
          "text": "⚠️ ต้องเป็นบัญชีเดียวกับที่โอนเงินเข้ามาเท่านั้น ทีมงานจะยืนยันและลงทะเบียนให้ภายใน 24 ชั่วโมงค่ะ",
          "size": "xs",
          "color": "#E65100",
          "wrap": true
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": "#00796B",
          "action": {
            "type": "uri",
            "label": "📞 โทรติดต่อทีมงาน 089-104-1992",
            "uri": "tel:0891041992"
          }
        }
      ],
      "paddingAll": "12px"
    }
  };
}

function constructWithdrawalFlex(bankName, accountNumber, accountName, balance) {
  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💸 ถอนเงินคืนเข้าบัญชี",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md"
        }
      ],
      "backgroundColor": "#455A64",
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "md",
      "contents": [
        {
          "type": "text",
          "text": "บัญชีรับเงินโอนคืนของคุณ (บัญชีเดียวกับที่เคยใช้ฝากเงิน):",
          "size": "sm",
          "color": "#555555",
          "wrap": true
        },
        {
          "type": "box",
          "layout": "vertical",
          "spacing": "xs",
          "contents": [
            {
              "type": "text",
              "text": "🏦 ธนาคาร: " + bankName,
              "size": "sm",
              "color": "#333333",
              "weight": "bold"
            },
            {
              "type": "text",
              "text": "🔢 เลขบัญชี: " + accountNumber,
              "size": "sm",
              "color": "#333333",
              "weight": "bold"
            },
            {
              "type": "text",
              "text": "👤 ชื่อบัญชี: " + accountName,
              "size": "sm",
              "color": "#333333",
              "weight": "bold"
            }
          ]
        },
        {
          "type": "separator"
        },
        {
          "type": "text",
          "text": "💰 เครดิตคงเหลือ: " + balance.toFixed(2) + " แต้ม",
          "size": "sm",
          "color": "#2E7D32",
          "weight": "bold"
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "sm",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#455A64",
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
              "color": "#455A64",
              "action": {
                "type": "message",
                "label": "ถอน 300",
                "text": "ถอน 300"
              }
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "sm",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#455A64",
              "action": {
                "type": "message",
                "label": "ถอน 500",
                "text": "ถอน 500"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#455A64",
              "action": {
                "type": "message",
                "label": "ถอน 1,000",
                "text": "ถอน 1000"
              }
            }
          ]
        },
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "action": {
            "type": "message",
            "label": "🏠 เมนูหลัก",
            "text": "เมนู"
          }
        }
      ],
      "paddingAll": "16px"
    }
  };
}

function constructBetOpenFlex(orderNo, amount, side, creatorName, rangeInfo) {
  var sideText = side === 'low' ? 'ต่ำ (Low)' : 'สูง (High)';
  var sideColor = side === 'low' ? '#1E88E5' : '#E53935';
  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "🚀 เปิดดีลดวล!",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md"
        }
      ],
      "backgroundColor": "#1E1B4B",
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "md",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "เลขที่ดีล:",
              "color": "#888888",
              "size": "sm",
              "flex": 4
            },
            {
              "type": "text",
              "text": "#" + orderNo,
              "weight": "bold",
              "color": "#333333",
              "size": "sm",
              "flex": 6,
              "align": "end"
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "ผู้ท้าดวล:",
              "color": "#888888",
              "size": "sm",
              "flex": 4
            },
            {
              "type": "text",
              "text": creatorName,
              "weight": "bold",
              "color": "#333333",
              "size": "sm",
              "flex": 6,
              "align": "end"
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "ฝั่งที่เลือก:",
              "color": "#888888",
              "size": "sm",
              "flex": 4
            },
            {
              "type": "text",
              "text": sideText + (rangeInfo ? " (" + rangeInfo + ")" : ""),
              "weight": "bold",
              "color": sideColor,
              "size": "sm",
              "flex": 6,
              "align": "end"
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "ยอดท้าดวล:",
              "color": "#888888",
              "size": "sm",
              "flex": 4
            },
            {
              "type": "text",
              "text": amount + " แต้ม",
              "weight": "bold",
              "color": "#E65100",
              "size": "sm",
              "flex": 6,
              "align": "end"
            }
          ]
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": "#1E88E5",
          "action": {
            "type": "message",
            "label": "(ยอมรับดีลดวลนี้)",
            "text": "ต"
          }
        }
      ],
      "paddingAll": "16px"
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
  // Ocean Green (#00796B) for Income/Deposit, Slate Grey (#455A64) for Expense/Withdrawal
  var headerBgColor = isIncome ? "#00796B" : "#455A64"; 
  var badgeText = isIncome ? "เงินเข้า" : "เงินออก";
  var badgeBgColor = isIncome ? "#E0F2F1" : "#ECEFF1";
  var badgeTextColor = isIncome ? "#00796B" : "#455A64";
  
  var amountText = (isIncome ? "+" : "-") + formattedAmount + " บาท";
  var amountTextColor = isIncome ? "#00796B" : "#455A64";
  
  var transactionLabel = isIncome ? "โอนเงินเข้าบัญชี" : "ถอน/โอนเงินออกจากบัญชี";
  var buttonColor = isIncome ? "#00796B" : "#455A64";
  
  var finalUrl = targetUrl || "";
  if (!finalUrl) {
    try {
      finalUrl = ScriptApp.getService().getUrl();
      if (userId) {
        finalUrl += "?userId=" + userId;
      }
    } catch (e) {
      finalUrl = "https://example.com/statement";
    }
  }

  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": "ธุรกรรม",
              "weight": "bold",
              "color": "#FFFFFF",
              "size": "sm",
              "flex": 1,
              "align": "start"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": badgeText,
                  "weight": "bold",
                  "color": badgeTextColor,
                  "size": "xxs",
                  "align": "center"
                }
              ],
              "backgroundColor": badgeBgColor,
              "cornerRadius": "md",
              "paddingStart": "8px",
              "paddingEnd": "8px",
              "paddingTop": "2px",
              "paddingBottom": "2px",
              "flex": 0
            }
          ]
        }
      ],
      "backgroundColor": headerBgColor,
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": amountText,
          "weight": "bold",
          "size": "xxl",
          "color": amountTextColor,
          "align": "center",
          "margin": "md"
        },
        {
          "type": "separator",
          "margin": "lg",
          "color": "#EAEAEA"
        },
        {
          "type": "box",
          "layout": "vertical",
          "margin": "lg",
          "spacing": "md",
          "contents": [
            {
              "type": "box",
              "layout": "horizontal",
              "contents": [
                {
                  "type": "text",
                  "text": "รายการ",
                  "color": "#999999",
                  "size": "sm",
                  "flex": 3
                },
                {
                  "type": "text",
                  "text": transactionLabel,
                  "weight": "bold",
                  "color": "#333333",
                  "size": "sm",
                  "flex": 7,
                  "align": "end"
                }
              ]
            },
            {
              "type": "box",
              "layout": "horizontal",
              "contents": [
                {
                  "type": "text",
                  "text": "รายละเอียด",
                  "color": "#999999",
                  "size": "sm",
                  "flex": 3
                },
                {
                  "type": "text",
                  "text": accountDetails,
                  "weight": "regular",
                  "color": "#333333",
                  "size": "sm",
                  "flex": 7,
                  "align": "end",
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
                  "text": "วัน-เวลา",
                  "color": "#999999",
                  "size": "sm",
                  "flex": 3
                },
                {
                  "type": "text",
                  "text": dateStr + " น.",
                  "weight": "regular",
                  "color": "#333333",
                  "size": "sm",
                  "flex": 7,
                  "align": "end"
                }
              ]
            }
          ]
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": buttonColor,
          "action": {
            "type": "message",
            "label": "กลับสู่เมนูหลัก 📋",
            "text": "เมนู"
          }
        }
      ],
      "flex": 0,
      "paddingAll": "16px"
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

function sendAdminMessageToLine(userId, messageText) {
  const clean = messageText.replace(/\s+/g, '').toLowerCase();
  let payload = messageText;
  
  if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
    const name = getPlayerNameFromDb(userId) || "ผู้เล่น";
    const balance = getPlayerBalance(userId, name);
    payload = constructBalanceFlex(name, balance);
  } else if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit') {
    payload = constructDepositFlex();
  } else if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
    const bank = getPlayerBank(userId);
    if (bank) {
      const balance = getPlayerBalance(userId, bank.accountName || "ผู้เล่น");
      payload = constructWithdrawalFlex(bank.bankName, bank.accountNumber, bank.accountName, balance);
    } else {
      payload = "❌ ผู้เล่นรายนี้ยังไม่ได้ลงทะเบียนบัญชีธนาคาร (กรุณาทำรายการฝากเงินเข้ามาก่อน)";
    }
  } else if (clean === 'เมนู' || clean === 'menu' || clean === 'เริ่ม' || clean === 'start') {
    payload = constructMainMenuFlex();
  }
  
  // Push the message to LINE OA
  pushToLine(userId, payload);
  // Log it to the database
  const logText = typeof payload === 'object' ? `[Flex Message: ${messageText}]` : messageText;
  logLineChatMessage(userId, 'ผู้เล่น', 'admin', logText, typeof payload === 'object' ? 'flex' : 'text');
  return true;
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

  var now = new Date();
  var dateStr = Utilities.formatDate(now, "GMT+7", "dd/MM/yyyy HH:mm:ss");

  var isWithdrawal = (type === "WD" || type === "withdraw" || type === "ถอนเงิน");
  var title = isWithdrawal ? "คำขอถอนเงินถูกปฏิเสธ" : "บิลฝากเงินถูกปฏิเสธ";
  var headerBgColor = "#E07A5F"; // Coral/Terracotta (not resembling Thai bank)
  var badgeText = "ปฏิเสธ";
  var badgeBgColor = "#FDF0ED";
  var badgeTextColor = "#E07A5F";
  
  var amountText = formattedAmount + " บาท";
  var amountTextColor = "#E07A5F";
  
  var transactionLabel = isWithdrawal ? "ถอนเครดิต (คืนแต้ม)" : "แจ้งฝากเงิน";
  var balanceLabel = isWithdrawal ? "ยอดคงเหลือปัจจุบัน" : "ยอดคงเหลือ";
  var balanceText = currentBalance !== undefined ? currentBalance.toLocaleString('th-TH') + " แต้ม" : "-";

  var contents = [
    {
      "type": "box",
      "layout": "horizontal",
      "contents": [
        {
          "type": "text",
          "text": "รายการ",
          "color": "#999999",
          "size": "sm",
          "flex": 3
        },
        {
          "type": "text",
          "text": transactionLabel,
          "weight": "bold",
          "color": "#333333",
          "size": "sm",
          "flex": 7,
          "align": "end"
        }
      ]
    },
    {
      "type": "box",
      "layout": "horizontal",
      "contents": [
        {
          "type": "text",
          "text": "เหตุผล",
          "color": "#999999",
          "size": "sm",
          "flex": 3
        },
        {
          "type": "text",
          "text": reason || "ข้อมูลไม่ถูกต้อง/สลิปไม่ผ่าน",
          "weight": "bold",
          "color": "#E07A5F",
          "size": "sm",
          "flex": 7,
          "align": "end",
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
          "text": "วัน-เวลา",
          "color": "#999999",
          "size": "sm",
          "flex": 3
        },
        {
          "type": "text",
          "text": dateStr + " น.",
          "weight": "regular",
          "color": "#333333",
          "size": "sm",
          "flex": 7,
          "align": "end"
        }
      ]
    }
  ];

  if (isWithdrawal && currentBalance !== undefined) {
    contents.push({
      "type": "box",
      "layout": "horizontal",
      "contents": [
        {
          "type": "text",
          "text": balanceLabel,
          "color": "#999999",
          "size": "sm",
          "flex": 4
        },
        {
          "type": "text",
          "text": balanceText,
          "weight": "bold",
          "color": "#2E7D32",
          "size": "sm",
          "flex": 6,
          "align": "end"
        }
      ]
    });
  }

  var finalUrl = "";
  try {
    finalUrl = ScriptApp.getService().getUrl();
    if (userId) {
      finalUrl += "?userId=" + userId;
    }
  } catch (e) {
    finalUrl = "https://example.com";
  }

  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": title,
              "weight": "bold",
              "color": "#FFFFFF",
              "size": "sm",
              "flex": 1,
              "align": "start"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": badgeText,
                  "weight": "bold",
                  "color": badgeTextColor,
                  "size": "xxs",
                  "align": "center"
                }
              ],
              "backgroundColor": badgeBgColor,
              "cornerRadius": "md",
              "paddingStart": "8px",
              "paddingEnd": "8px",
              "paddingTop": "2px",
              "paddingBottom": "2px",
              "flex": 0
            }
          ]
        }
      ],
      "backgroundColor": headerBgColor,
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": amountText,
          "weight": "bold",
          "size": "xxl",
          "color": amountTextColor,
          "align": "center",
          "margin": "md"
        },
        {
          "type": "separator",
          "margin": "lg",
          "color": "#EAEAEA"
        },
        {
          "type": "box",
          "layout": "vertical",
          "margin": "lg",
          "spacing": "md",
          "contents": contents
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": "#E07A5F",
          "action": {
            "type": "uri",
            "label": "ติดต่อฝ่ายสนับสนุน",
            "uri": "tel:089-104-1992"
          }
        }
      ],
      "flex": 0,
      "paddingAll": "16px"
    }
  };
}

function constructMatchResultFlex(isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission, userId) {
  var headerBgColor = isWinner ? "#00796B" : "#455A64"; // Ocean Green or Slate Grey
  var title = isWinner ? "🏆 สรุปผลดวล - คุณชนะ!" : "☄️ สรุปผลดวล - คุณแพ้";
  var badgeText = isWinner ? "ชนะ" : "แพ้";
  var badgeBgColor = isWinner ? "#E8F5E9" : "#ECEFF1";
  var badgeTextColor = isWinner ? "#00796B" : "#455A64";
  
  var amountText = isWinner ? "+" + payout.toLocaleString('th-TH') + " แต้ม" : "-" + amount.toLocaleString('th-TH') + " แต้ม";
  var amountTextColor = isWinner ? "#00796B" : "#E07A5F";
  
  var details = isWinner 
    ? "คืนทุน " + amount + " + กำไรหลังหักคอมมิชชั่น 10% (" + (winnings - commission) + " แต้ม)"
    : "หักเครดิตตามจำนวนเดิมพัน";

  var contents = [
    {
      "type": "box",
      "layout": "horizontal",
      "contents": [
        {
          "type": "text",
          "text": "แผลดวล",
          "color": "#999999",
          "size": "sm",
          "flex": 3
        },
        {
          "type": "text",
          "text": "Order #" + orderNo,
          "weight": "bold",
          "color": "#333333",
          "size": "sm",
          "flex": 7,
          "align": "end"
        }
      ]
    },
    {
      "type": "box",
      "layout": "horizontal",
      "contents": [
        {
          "type": "text",
          "text": "เวลาบินจริง",
          "color": "#999999",
          "size": "sm",
          "flex": 3
        },
        {
          "type": "text",
          "text": finalTime + " วินาที 🚀",
          "weight": "bold",
          "color": "#333333",
          "size": "sm",
          "flex": 7,
          "align": "end"
        }
      ]
    },
    {
      "type": "box",
      "layout": "horizontal",
      "contents": [
        {
          "type": "text",
          "text": "รายละเอียด",
          "color": "#999999",
          "size": "sm",
          "flex": 3
        },
        {
          "type": "text",
          "text": details,
          "weight": "regular",
          "color": "#666666",
          "size": "xs",
          "flex": 7,
          "align": "end",
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
          "text": "ยอดเครดิตปัจจุบัน",
          "color": "#999999",
          "size": "sm",
          "flex": 4
        },
        {
          "type": "text",
          "text": currentBalance.toLocaleString('th-TH') + " แต้ม 💳",
          "weight": "bold",
          "color": "#2E7D32",
          "size": "sm",
          "flex": 6,
          "align": "end"
        }
      ]
    }
  ];

  var finalUrl = "";
  try {
    finalUrl = ScriptApp.getService().getUrl();
    if (userId) {
      finalUrl += "?userId=" + userId;
    }
  } catch (e) {
    finalUrl = "https://example.com";
  }

  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            {
              "type": "text",
              "text": title,
              "weight": "bold",
              "color": "#FFFFFF",
              "size": "sm",
              "flex": 1,
              "align": "start"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": badgeText,
                  "weight": "bold",
                  "color": badgeTextColor,
                  "size": "xxs",
                  "align": "center"
                }
              ],
              "backgroundColor": badgeBgColor,
              "cornerRadius": "md",
              "paddingStart": "8px",
              "paddingEnd": "8px",
              "paddingTop": "2px",
              "paddingBottom": "2px",
              "flex": 0
            }
          ]
        }
      ],
      "backgroundColor": headerBgColor,
      "paddingAll": "16px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": amountText,
          "weight": "bold",
          "size": "xxl",
          "color": amountTextColor,
          "align": "center",
          "margin": "md"
        },
        {
          "type": "separator",
          "margin": "lg",
          "color": "#EAEAEA"
        },
        {
          "type": "box",
          "layout": "vertical",
          "margin": "lg",
          "spacing": "md",
          "contents": contents
        }
      ],
      "paddingAll": "20px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": headerBgColor,
          "action": {
            "type": "uri",
            "label": "ร่วมดวลต่อรอบใหม่ 🚀",
            "uri": finalUrl
          }
        }
      ],
      "flex": 0,
      "paddingAll": "16px"
    }
  };
}
