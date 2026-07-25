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
      
      // Get Player profile display name
      const profile = getLineUserProfile(userId);
      const displayName = profile ? profile.displayName : "ผู้เล่นนิรนาม";
      
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
 * Helper to update a player's registered bank details.
 */
function updatePlayerBank(userId, bankName, accountNumber, accountName) {
  if (userId === null || userId === undefined) return;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      sheet.getRange(i + 1, 5).setValue(bankName);
      sheet.getRange(i + 1, 6).setValue(accountNumber);
      sheet.getRange(i + 1, 7).setValue(accountName);
      return;
    }
  }
}

/**
 * Helper to retrieve a player's registered bank details.
 */
function getPlayerBank(userId) {
  if (userId === null || userId === undefined) return null;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      const bankName = data[i][4] ? data[i][4].toString() : '';
      const bankAccount = data[i][5] ? data[i][5].toString() : '';
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
 * Helper to get active bets for a player.
 */
function getPlayerActiveBets(userId) {
  if (userId === null || userId === undefined) return [];
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
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
  if (userId === null || userId === undefined || !orderNo) return "❌ ผิดพลาด: ไม่สามารถทำรายการได้";
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
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
function handleTextMessage(text, userId, displayName, replyToken) {
  const clean = text.replace(/\s+/g, '').toLowerCase();
  
  // A. CHECK BALANCE ("เช็คยอด", "คงเหลือ", "balance")
  if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
    const balance = getPlayerBalance(userId, displayName);
    replyToLine(replyToken, `💳 ยอดเครดิตคงเหลือของคุณ:\n\n👤 ผู้เล่น: ${displayName}\n💰 คงเหลือ: ${balance.toFixed(2)} แต้ม`);
    return;
  }
  
  // B. LIST ACTIVE DEALS ("รายการจับคู่", "matched", "รายการดวล")
  if (clean === 'รายการจับคู่' || clean === 'matched' || clean === 'รายการดวล') {
    const matchedBets = getPlayerActiveBets(userId);
    if (matchedBets.length === 0) {
      replyToLine(replyToken, `📝 รายการดวลของคุณ:\n\n❌ ปัจจุบันไม่มีแผลดวลค้างหรือรอคู่ในระบบค่ะ`);
    } else {
      let replyMsg = `📝 รายการดวลของคุณ (${matchedBets.length} รายการ):\n`;
      matchedBets.forEach(b => {
        const side = b.playerLowId === userId ? 'ต่ำ (Low)' : 'สูง (High)';
        const statusText = b.status === 'matched' ? 'ดวลกันอยู่ ☄️' : 'รอคู่ดวล ⏳';
        replyMsg += `\n-----------------------\nOrder: #${b.orderNumber}\nยอดดวล: ${b.amount} แต้ม\nฝั่งของคุณ: ${side}\nคู่ดวล: ${b.opponentName || 'รอคู่...'}\nสถานะ: ${statusText}\n${b.status === 'pending_match' ? `💡 พิมพ์ "ยกเลิก ${b.orderNumber}" เพื่อถอนแผลและรับแต้มคืน` : ''}`;
      });
      replyToLine(replyToken, replyMsg);
    }
    return;
  }

  // C. CANCEL DEAL REQUEST ("ยกเลิก [orderNo]")
  const cancelRegex = /^(ยกเลิก|cancel)(?:order|#)?(\d+)$/;
  if (cancelRegex.test(clean)) {
    const match = clean.match(cancelRegex);
    const orderNo = match[2];
    const result = handleCancelBetRequest(userId, orderNo);
    replyToLine(replyToken, result);
    return;
  }
  
  // D. INITIATE DEPOSIT ("ฝากเงิน", "เติมเงิน", "deposit", "เติมเครดิต")
  if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit' || clean === 'เติมเครดิต') {
    replyToLine(replyToken, `💰 ขั้นตอนการฝากเครดิต (สเกล 1:1)\n\nกรุณาพิมพ์เลือกยอดที่ต้องการฝากเพื่อรับใบแจ้งยอดโอน:\n👉 พิมพ์ 100\n👉 พิมพ์ 300\n👉 พิมพ์ 500\n👉 พิมพ์ 1000\n\nหรือพิมพ์ตัวเลขระบุจำนวนเงินที่ต้องการฝากอื่นๆ ได้เลยค่ะ`);
    return;
  }

  // E. INITIATE WITHDRAWAL ("ถอนเงิน", "ถอนยอด", "withdraw")
  if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
    const bank = getPlayerBank(userId);
    if (!bank) {
      replyToLine(replyToken, `❌ ไม่พบประวัติการฝากเงินผ่านระบบ!\n\nเพื่อความปลอดภัยสูงสุด ระบบกำหนดให้บัญชีถอนเงินต้องตรงกับบัญชีที่ฝากเงินเข้ามาครั้งแรกเท่านั้น\n\nกรุณาทำรายการฝากเงินเข้ามาก่อนเพื่อลงทะเบียนบัญชีธนาคารค่ะ`);
    } else {
      const balance = getPlayerBalance(userId, displayName);
      replyToLine(replyToken, `💸 บัญชีธนาคารสำหรับโอนเงินคืนของคุณคือ:\n\n🏦 ธนาคาร: ${bank.bankName}\n🔢 เลขบัญชี: ${bank.accountNumber}\n👤 ชื่อบัญชี: ${bank.accountName}\n\n💰 เครดิตคงเหลือ: ${balance} แต้ม\n\n💡 กรุณาพิมพ์จำนวนแต้มที่ต้องการถอนตามรูปแบบด้านล่าง:\n👉 เช่น พิมพ์ "ถอน 500" หรือ "ถอน ${Math.min(balance, 1000)}"`);
    }
    return;
  }

  // F. PROCESS WITHDRAWAL REQUEST ("ถอน [amount]")
  const withdrawRegex = /^(ถอน|withdraw)(\d+)$/;
  if (withdrawRegex.test(clean)) {
    const match = clean.match(withdrawRegex);
    const withdrawAmt = parseInt(match[2]);
    const bank = getPlayerBank(userId);
    if (!bank) {
      replyToLine(replyToken, `❌ ขออภัยค่ะ ไม่พบข้อมูลบัญชีธนาคารสำหรับถอนเงิน (ต้องใช้บัญชีเดียวกับที่ฝากเงินเข้ามาในครั้งแรก)`);
      return;
    }
    const balance = getPlayerBalance(userId, displayName);
    if (withdrawAmt <= 0) {
      replyToLine(replyToken, `❌ จำนวนเงินถอนต้องมากกว่า 0 แต้มค่ะ`);
      return;
    }
    if (balance < withdrawAmt) {
      replyToLine(replyToken, `❌ เครดิตไม่เพียงพอสำหรับการถอนเงินจำนวนนี้!\nยอดเงินของท่าน: ${balance} แต้ม\nยอดที่ต้องการถอน: ${withdrawAmt} แต้ม`);
      return;
    }
    
    // Process withdrawal: lock balance by deducting
    adjustPlayerBalance(userId, -withdrawAmt);
    
    // Log withdrawal transaction with WD prefix
    logTransaction(userId, displayName, withdrawAmt, 0, 'PENDING_WITHDRAW', 'escalated', `Withdrawal request to ${bank.bankName} ${bank.accountNumber} ${bank.accountName}`);
    
    replyToLine(replyToken, `📥 ได้รับคำขอถอนเงินจำนวน ${withdrawAmt} แต้ม เรียบร้อยแล้วค่ะ!\n\nระบบกำลังส่งต่อข้อมูลให้แอดมินพิจารณาอนุมัติโอนเงินแบบแมนนวลเข้าบัญชีธนาคาร ${bank.bankName} เลขบัญชี ${bank.accountNumber} ของคุณค่ะ\n\nยอดคงเหลือหลังทำรายการ: ${balance - withdrawAmt} แต้ม`);
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
      replyToLine(replyToken, `⚠️ ขออภัยค่ะ ระบบรองรับการฝากยอดขั้นต่ำ 100 THB และสูงสุดไม่เกิน 10,000 THB ต่อครั้งค่ะ`);
      return;
    }
    
    // Log pending deposit transaction
    logTransaction(userId, displayName, depositAmt, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
    
    replyToLine(replyToken, `🧾 ใบแจ้งยอดโอนเงินจำนวน ${depositAmt}.00 บาท\n\n🏦 ธนาคารกสิกรไทย (KBANK)\n🔢 เลขบัญชี: 987-6-54321-0\n👤 ชื่อบัญชี: บจก. เมฆจินดา ร็อคเก็ต บิลลิ่ง\n\n💵 ยอดโอนตรง: ${depositAmt}.00 บาท\n\n💡 โอนเสร็จแล้วกรุณาส่งภาพสลิปที่มี QR Code มาในห้องแชทนี้ได้เลย ระบบจะสแกนและอัพเครดิตทันทีค่ะ!`);
    return;
  }

  // 1. MATCH ACTION: ACCEPT / LOCK DEALS ("ต", "ติด", "ครับ", "เค", "จ้า")
  if (['ต', 'ติด', 'ครับ', 'เค', 'จ้า'].indexOf(clean) !== -1) {
    const matchedBet = matchExistingOpenBet(userId, displayName);
    if (matchedBet) {
      replyToLine(replyToken, `✅ จับคู่สำเร็จ! (Order #${matchedBet.orderNumber})\nยอดดวล: ${matchedBet.amount} แต้ม\nฝั่งต่ำ (Low): ${matchedBet.playerLowName}\nฝั่งสูง (High): ${matchedBet.playerHighName}\n\nระบบล็อกเครดิตทั้งคู่แล้ว รอการสรุปผลจรวดครับ 🚀`);
    } else {
      replyToLine(replyToken, `❌ ไม่มีแผลดวลเปิดรับอยู่ในขณะนี้`);
    }
    return;
  }
  
  // 2. PARSE BET FORMULAS (ชล100, ชถ500, 300-340ล100)
  const rangeRegex = /^(\d+)-(\d+)([ลถ])(\d+)$/;
  const simpleRegex = /^(ชล|ล|ไล่|ชย|ชถ|ย|ถ|ถอย)(\d+)$/;
  
  let betType = '';
  let rangeMin = null;
  let rangeMax = null;
  let side = '';
  let amount = 0;
  
  if (rangeRegex.test(clean)) {
    const match = clean.match(rangeRegex);
    rangeMin = parseInt(match[1]);
    rangeMax = parseInt(match[2]);
    side = match[3] === 'ล' ? 'low' : 'high';
    amount = parseInt(match[4]);
    betType = 'range';
  } else if (simpleRegex.test(clean)) {
    const match = clean.match(simpleRegex);
    const sub = match[1];
    side = ['ชล', 'ล', 'ไล่'].indexOf(sub) !== -1 ? 'low' : 'high';
    amount = parseInt(match[2]);
    betType = 'high_low';
  } else {
    // Not a betting command, ignore
    return;
  }
  
  // Check user credit balance
  const balance = getPlayerBalance(userId, displayName);
  if (balance < amount) {
    replyToLine(replyToken, `❌ เครดิตคงเหลือไม่เพียงพอ!\nยอดปัจจุบันของคุณ: ${balance} แต้ม\nต้องการใช้: ${amount} แต้ม\n\nกรุณาเติมแต้มด้วยการแจ้งเติมเงินและส่งรูปภาพสลิปที่ห้องหลังบ้านครับ`);
    return;
  }
  
  // Lock credits from player balance
  adjustPlayerBalance(userId, -amount);
  
  // Write to Sheets database as open bet
  const orderNumber = Math.floor(Math.random() * 89999 + 10000).toString();
  saveOpenBet(orderNumber, userId, displayName, side, amount, betType, rangeMin, rangeMax);
  
  replyToLine(replyToken, `📥 บันทึกบิลสำเร็จ! (Order #${orderNumber})\nยอดดวล: ${amount} แต้ม\nฝั่ง: ${side === 'low' ? 'ต่ำ (Low)' : 'สูง (High)'} ${rangeMin ? `(ช่วง ${rangeMin/100}-${rangeMax/100}s)` : ''}\n\n📢 กำลังรอคู่ดวลในกลุ่มพิมพ์ "ต" เพื่อร่วมเล่นแผลนี้...`);
}

/**
 * Handle incoming LINE image transfers (Bank slip verification check)
 */
function handleImageSlipMessage(messageId, userId, displayName, replyToken) {
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
    replyToLine(replyToken, `⚠️ ระบบเช็คสลิปขัดข้อง (HTTP ${responseCode})\nรายละเอียด: ${errorDetail}\n\nแอดมินได้รับบิลนี้เรียบร้อย กำลังตรวจสอบแมนนวลให้ในระบบหลังบ้านครับ`);
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
  adjustPlayerBalance(userId, actualAmount);
  
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
  replyToLine(replyToken, `🎉 เติมเครดิตสำเร็จ!\n\nยอดโอนเช็คพบ: ${actualAmount}.00 บาท\nอัพยอดเข้าบัญชีเรียบร้อย 1:1 แต้มครับ ขอให้สนุก! 🚀`);
}

// =========================================================================
// GOOGLE SHEETS DATABASE QUERIES & CRUD HELPER METHODS
// =========================================================================

function getPlayerBalance(userId, displayName) {
  if (userId === null || userId === undefined) return 0;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim() : '';
    if (rowId === searchId) {
      return Number(data[i][2]) || 0;
    }
  }
  // Register player if first-time user
  sheet.appendRow([searchId, displayName, 0, new Date(), '', '', '']);
  return 0;
}

function adjustPlayerBalance(userId, delta) {
  if (userId === null || userId === undefined) return;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Players');
  const data = sheet.getDataRange().getValues();
  const searchId = userId.toString().trim();
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
  // If player not found, auto-register them and set balance to the delta directly to avoid silent loss of credits
  sheet.appendRow([searchId, "ผู้ใช้งานใหม่", numericDelta, new Date(), '', '', '']);
}


function saveOpenBet(orderNo, userId, displayName, side, amount, type, rMin, rMax) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Bets');
  sheet.appendRow([
    orderNo,
    side === 'low' ? userId : '',
    side === 'low' ? displayName : '',
    side === 'high' ? userId : '',
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

function replyToLine(replyToken, text, fallbackTargetId) {
  if (replyToken === 'MOCK_REPLY_TOKEN') return; // Simulator bypass
  
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }]
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
  
  // Fallback to push message if replyToken has expired (HTTP 400 or similar)
  if (code >= 400 && fallbackTargetId) {
    pushToLine(fallbackTargetId, text);
  }
}

// =========================================================================
// REACT INTERACTIVE DASHBOARD SYNC CHANNELS
// =========================================================================

/**
 * Fetch players, transactions, and bets from Google Sheet database.
 */
function getDashboardData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  
  // 1. Players sheet
  const pSheet = ss.getSheetByName('Players');
  const pData = pSheet.getDataRange().getValues();
  const players = [];
  const avatars = ['🐉', '🐯', '🦅', '🦁', '🐻', '🐼', '🦊', '🦉'];
  for (let i = 1; i < pData.length; i++) {
    const row = pData[i];
    players.push({
      id: row[0].toString(),
      name: row[1].toString(),
      balance: Number(row[2]) || 0,
      isUser: row[0].toString() === 'user',
      avatar: avatars[i % avatars.length]
    });
  }
  // Setup database defaults if sheet is empty
  if (players.length === 0) {
    pSheet.appendRow(['p1', 'วชิระ ส. (โบ๊ท)', 1450, new Date()]);
    pSheet.appendRow(['p2', 'เบนซ์ (Benz)', 800, new Date()]);
    pSheet.appendRow(['p3', 'อาร์ต (Art)', 3000, new Date()]);
    pSheet.appendRow(['p4', 'เจ๋ง (Jeng)', 1200, new Date()]);
    pSheet.appendRow(['user', 'คุณ (You)', 500, new Date()]);
    return getDashboardData();
  }
  
  // 2. Transactions sheet
  const tSheet = ss.getSheetByName('Transactions');
  const tData = tSheet.getDataRange().getValues();
  const transactions = [];
  for (let i = 1; i < tData.length; i++) {
    const row = tData[i];
    transactions.push({
      id: row[0].toString(),
      playerId: row[1].toString(),
      playerName: row[2].toString(),
      requestedAmount: Number(row[3]) || 0,
      actualAmount: Number(row[4]) || 0,
      slipRef: row[5].toString(),
      status: row[6].toString(), // success, escalated, rejected
      reviewReason: row[7].toString(),
      timestamp: row[8] ? Utilities.formatDate(new Date(row[8]), "GMT+7", "HH:mm:ss") : '',
      logs: [`Verified in Sheets Database`, `Status: ${row[6]}`]
    });
  }

  // 3. Bets sheet
  const bSheet = ss.getSheetByName('Bets');
  const bData = bSheet.getDataRange().getValues();
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
      status: row[9].toString(), // matched, pending_match, resolved, cancelled
      winnerName: row[10] ? row[10].toString() : '',
      timestamp: row[11] ? Utilities.formatDate(new Date(row[11]), "GMT+7", "HH:mm:ss") : ''
    });
  }

  return {
    players: players,
    transactions: transactions,
    bets: bets
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
        pushToLine(userId, `💸 คำขอถอนเงินยอด ${reqAmt} บาท ได้รับการอนุมัติและโอนเงินเข้าบัญชีธนาคารเรียบร้อยแล้วค่ะ!`);
      } else {
        // Deposit: credit player balance
        adjustPlayerBalance(userId, actualAmount);
        const currentBalance = getPlayerBalance(userId, displayName);
        pushToLine(userId, `🎉 แอดมินได้อนุมัติเครดิตเติมเงินจำนวน ${actualAmount} แต้ม เรียบร้อยแล้วค่ะ!\n💰 คงเหลือปัจจุบัน: ${currentBalance} แต้ม`);
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
        adjustPlayerBalance(userId, reqAmt);
        const currentBalance = getPlayerBalance(userId, displayName);
        pushToLine(userId, `❌ คำขอถอนเงินยอด ${reqAmt} แต้ม ถูกปฏิเสธ!\nเหตุผล: ${reason || 'ข้อมูลไม่ถูกต้อง'}\n💰 ระบบได้คืนเครดิตเข้าบัญชีคุณเรียบร้อยแล้วค่ะ ยอดคงเหลือปัจจุบัน: ${currentBalance} แต้ม`);
      } else {
        pushToLine(userId, `❌ บิลฝากเงินยอด ${reqAmt} บาท ถูกปฏิเสธ!\nเหตุผล: ${reason || 'สลิปไม่ผ่านเกณฑ์ตรวจสอบ'}`);
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
      const pLowId = row[1];
      const pLowName = row[2];
      const pHighId = row[3];
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
        pushToLine(winnerId, `🎉 ยินดีด้วยค่ะ คุณชนะแผลดวล! (Order #${orderNo})\n⏱️ ผลเวลาบินจริง: ${finalTime}s\n💰 รับเครดิตเพิ่ม: ${payout} แต้ม (ทุนคืน ${amount} + กำไรหลังหักคอมมิชชั่น 10%: ${winnings - commission} แต้ม)\n💳 ยอดคงเหลือปัจจุบัน: ${winBal} แต้ม`);
      } catch (err) {
        Logger.log("Error pushing win message: " + err);
      }
      
      try {
        const loseBal = getPlayerBalance(loserId, loserName);
        pushToLine(loserId, `😭 เสียใจด้วยค่ะ คุณแพ้ในรอบนี้ (Order #${orderNo})\n⏱️ ผลเวลาบินจริง: ${finalTime}s\n💸 เสียเครดิต: ${amount} แต้ม\n💳 ยอดคงเหลือปัจจุบัน: ${loseBal} แต้ม`);
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
      let pLowId = row[1];
      let pLowName = row[2];
      let pHighId = row[3];
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
  pSheet.appendRow(['User ID', 'Display Name', 'Balance (Credits)', 'Registered Date', 'Bank Name', 'Bank Account Number', 'Bank Account Holder Name']);
  pSheet.appendRow(['p1', 'วชิระ ส. (โบ๊ท)', 1450, new Date(), 'KBANK', '987-6-54321-0', 'วชิระ สมบูรณ์']);
  pSheet.appendRow(['p2', 'เบนซ์ (Benz)', 800, new Date(), 'SCB', '123-4-56789-0', 'เบนซ์ ใจดี']);
  pSheet.appendRow(['p3', 'อาร์ต (Art)', 3000, new Date(), 'BBL', '111-2-33333-4', 'อาร์ต หล่อมาก']);
  pSheet.appendRow(['p4', 'เจ๋ง (Jeng)', 1200, new Date(), 'KTB', '555-6-77777-8', 'เจ๋ง จริงๆ']);
  pSheet.appendRow(['user', 'คุณ (You)', 500, new Date(), 'SCB', '123-4-56789-0', 'คุณ (You)']);

  // Reset Transactions
  const tSheet = ss.getSheetByName('Transactions');
  tSheet.clearContents();
  tSheet.appendRow(['Tx ID', 'User ID', 'Display Name', 'Requested Amount', 'Actual Amount', 'Bank Ref', 'Status', 'Reason', 'Timestamp']);

  // Reset Bets
  const bSheet = ss.getSheetByName('Bets');
  bSheet.clearContents();
  bSheet.appendRow(['Order Number', 'Player Low ID', 'Player Low Name', 'Player High ID', 'Player High Name', 'Amount', 'Type', 'Range Min', 'Range Max', 'Status', 'Winner Name', 'Timestamp']);
}

/**
 * Send push notification to a LINE user
 */
function pushToLine(userId, text) {
  if (!userId || userId === 'user' || userId.startsWith('p')) return; // Simulator bypass
  
  const url = 'https://api.line.me/v2/bot/message/push';
  const payload = {
    to: userId,
    messages: [{ type: 'text', text: text }]
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  UrlFetchApp.fetch(url, options);
}
