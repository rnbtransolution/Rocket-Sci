import * as db from './db.js';
import FormData from 'form-data';

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'imrgIDDKJzCz68l399JwA9h7O0DGfHeJYEH4BychnR766i6GfWTTENcpm3MshP37uQMGIrV3GoGY9UsMC3li2Yxvq4BYIJjwND1u4GJgppSR0EJPfnGrY+56hzfW0bh0zNyCfQz5wUCABcIhaLGl9gdB04t89/1O/w1cDnyilFU=';
const SLIP_API_KEY = process.env.SLIP_API_KEY || '697ef678-60df-4955-a13a-6ed4e26a38c0';
const SLIP_API_URL = process.env.SLIP_API_URL || 'https://api.easyslip.com/v2/verify/bank';
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// --- LINE OA COMMUNICATIONS HELPERS ---

export async function getLineUserProfile(userId) {
  const url = `https://api.line.me/v2/bot/profile/${userId}`;
  try {
    const res = await fetch(url, {
      headers: { "Authorization": "Bearer " + LINE_CHANNEL_ACCESS_TOKEN }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("Error getLineUserProfile:", e);
    return null;
  }
}

export async function replyToLine(replyToken, text, userId) {
  if (replyToken === 'MOCK_REPLY_TOKEN') {
    // Simulator bypass
    console.log(`[LINE Mock Reply to ${userId}]:`, typeof text === 'object' ? '[Flex Message]' : text);
    return;
  }
  
  const url = 'https://api.line.me/v2/bot/message/reply';
  let messageObj;
  
  if (typeof text === 'object' && text !== null) {
    messageObj = {
      type: 'flex',
      altText: 'ระบบบริการ Rocket Science 🚀',
      contents: text
    };
  } else {
    let outText = String(text);
    if (userId && !outText.includes('คุณ ') && !outText.includes('ถึงคุณ')) {
      const pName = db.getPlayerNameFromDb(userId) || 'ผู้เล่น';
      outText = `👤 [ถึงคุณ ${pName}]:\n` + outText;
    }
    messageObj = { type: 'text', text: outText };
  }
  
  const payload = {
    replyToken: replyToken,
    messages: [messageObj]
  };
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN
      },
      body: JSON.stringify(payload)
    });
    
    if (userId) {
      const logText = typeof text === 'object' ? '[Flex Message]' : text;
      db.logLineChatMessage(userId, 'ผู้ใช้', 'bot', logText, typeof text === 'object' ? 'flex' : 'text');
    }
  } catch (err) {
    console.error("Error sending reply to LINE:", err);
  }
}

export async function pushToLine(targetId, text) {
  if (!targetId || targetId === 'user') {
    console.log(`[LINE Mock Push to ${targetId}]:`, typeof text === 'object' ? '[Flex Message]' : text);
    return;
  }
  
  // Resolve Passport short ID to raw LINE ID if needed, but preserve raw Group IDs (C...) & User IDs (U...)
  let rawLineId = targetId;
  if (typeof targetId === 'string' && (targetId.startsWith('p') || (!targetId.startsWith('C') && !targetId.startsWith('U')))) {
    rawLineId = db.getRawLineUserId(targetId) || targetId;
  }
  if (!rawLineId || (typeof rawLineId === 'string' && rawLineId.startsWith('p'))) {
    console.log(`[LINE Push Bypassed]: targetId "${targetId}" is passport simulator account.`);
    return;
  }

  const url = 'https://api.line.me/v2/bot/message/push';
  let messageObj;
  
  if (typeof text === 'object' && text !== null) {
    messageObj = {
      type: 'flex',
      altText: 'ระบบบริการ Rocket Science 🚀',
      contents: text
    };
  } else {
    messageObj = { type: 'text', text: String(text) };
  }
  
  const payload = {
    to: rawLineId,
    messages: [messageObj]
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN
      },
      body: JSON.stringify(payload)
    });
    const resText = await response.text();
    console.log(`[LINE Push Result to ${rawLineId}]: Status ${response.status} - ${resText}`);
  } catch (err) {
    console.error(`[LINE Push Error to ${rawLineId}]:`, err);
  }
}

// Intercept admin sending message to Line to log it properly and convert keywords
export async function sendAdminMessageToLine(targetId, messageText) {
  const destinationId = targetId || db.getActiveGroupId();
  if (!destinationId) {
    console.error("[LINE Push] No target userId or activeGroupId available.");
    return false;
  }

  const clean = messageText.replace(/\s+/g, '').toLowerCase();
  let payload = messageText;
  
  if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
    const name = db.getPlayerNameFromDb(destinationId) || "ผู้เล่น";
    const balance = await db.getPlayerBalance(destinationId, name);
    payload = constructBalanceFlex(name, balance);
  } else if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit') {
    payload = constructDepositFlex();
  } else if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
    const bank = db.getPlayerBank(destinationId);
    if (bank) {
      const balance = await db.getPlayerBalance(destinationId, bank.accountName || "ผู้เล่น");
      payload = constructWithdrawalFlex(bank.bankName, bank.accountNumber, bank.accountName, balance);
    } else {
      payload = "❌ ผู้เล่นรายนี้ยังไม่ได้ลงทะเบียนบัญชีธนาคาร (กรุณาทำรายการฝากเงินเข้ามาก่อน)";
    }
  } else if (clean === 'เมนู' || clean === 'menu' || clean === 'เริ่ม' || clean === 'start') {
    payload = constructMainMenuFlex();
  }
  
  await pushToLine(destinationId, payload);
  
  const logText = typeof payload === 'object' ? `[Flex Message: ${messageText}]` : messageText;
  db.logLineChatMessage(destinationId, 'ผู้เล่น', 'admin', logText, typeof payload === 'object' ? 'flex' : 'text');
  return true;
}

export async function handleUnsendMessage(unsendMessageId, userId, displayName, groupId) {
  const lastLogs = db.getDashboardData()?.chatLogs || [];
  const foundLog = lastLogs.find(l => l.userId === userId && l.sender === 'player');
  const msgText = foundLog ? foundLog.text : 'ข้อความในกลุ่ม';

  if (groupId) {
    await pushToLine(groupId, `🚨 [แจ้งเตือนระบบตรวจจับยกเลิกข้อความ (UNSEND ALERT)]\n\nผู้เล่น: คุณ ${displayName}\nข้อความเดิมที่ถูกยกเลิก: "${msgText}"\n\n⚠️ หมายเหตุ: ตามระเบียนข้อตกลงดวล ผลรายการท้าดวลและเครดิตในระบบยังคงบันทึกมีผลเรียบร้อยตามเดิมค่ะ 🚀`);
  } else if (userId) {
    await pushToLine(userId, `🚨 [แจ้งเตือนระบบตรวจจับยกเลิกข้อความ]\n\nคุณได้ยกเลิกข้อความ: "${msgText}"\nบันทึกรายการท้าดวลของคุณยังคงได้รับการบันทึกและตรวจสอบเรียบร้อยแล้วค่ะ`);
  }

  db.logLineChatMessage(userId, displayName, 'system', `[UNSEND ALERT] User unsent message: "${msgText}"`, 'warning');
}

// --- LINE BOT CONTROLLER / WEBHOOK HANDLERS ---

export async function handleTextMessage(text, userId, displayName, replyToken, groupId) {
  userId = await db.getOrCreateShortUserId(userId, displayName);
  db.logLineChatMessage(userId, displayName, 'player', text, 'text');
  
  // Anti-spam deduplication for high-velocity group chats
  if (groupId && db.isDuplicateGroupMessage(userId, text)) {
    console.log(`[DEDUPLICATION] Suppressed duplicate group message from ${displayName}: ${text}`);
    return;
  }

  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  const clean = text.replace(/\s+/g, '').toLowerCase();

  // Admin Command 1: Open Rocket Flight Round ("เปิด [ชื่อบั้งไฟ]")
  const openRoundRegex = /^(เปิด|เปิดรอบ|รอบ)\s*(.+)$/;
  if (openRoundRegex.test(text.trim())) {
    const match = text.trim().match(openRoundRegex);
    const roundName = match[2];
    db.setActiveRocketRound(roundName);
    await replyToLine(replyToken, `🚀 [เปิดรอบดวล]: ${roundName}\n\nเชิญผู้เล่นลงราคา/ท้าดวลได้เลยครับ! (พิมพ์ ชล, ชถ, +5ถ, 345-380ล)`, userId);
    return;
  }

  // Admin Command 2: Settle Rocket Flight Round ("แจ้งผล [วินาที]")
  const announceResultRegex = /^(แจ้งผล|ผล|ผลรอบ)\s*(\d+)$/;
  if (announceResultRegex.test(text.trim())) {
    const match = text.trim().match(announceResultRegex);
    const finalSeconds = parseInt(match[2]);
    const currentRound = db.getActiveRocketRound();
    await db.adminResolveBets(finalSeconds, 350, sendMatchResultPush);
    await replyToLine(replyToken, `🏆 [สรุปผลรอบ ${currentRound.name}]: ${finalSeconds} วินาที\n\nระบบทำการเคลียร์ยอดแผลดวลและโอนเครดิตเข้ากระเป๋าผู้ชนะเรียบร้อยแล้วครับ!`, userId);
    return;
  }
  
  // A. CHECK BALANCE
  if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
    const balance = await db.getPlayerBalance(userId, displayName);
    const balanceFlex = constructBalanceFlex(displayName, balance);
    await replyToLine(replyToken, balanceFlex, userId);
    return;
  }
  
  // B. LIST ACTIVE DEALS
  if (clean === 'รายการจับคู่' || clean === 'matched' || clean === 'รายการดวล') {
    const matchedBets = db.getPlayerActiveBets(userId);
    if (matchedBets.length === 0) {
      await replyToLine(replyToken, `📝 รายการดวลของคุณ:\n\n❌ ปัจจุบันไม่มีแผลดวลค้างหรือรอคู่ในระบบค่ะ`, userId);
    } else {
      let replyMsg = `📝 รายการดวลของคุณ (${matchedBets.length} รายการ):\n`;
      matchedBets.forEach(b => {
        const side = b.playerLowId === userId ? 'ต่ำ (Low)' : 'สูง (High)';
        const statusText = b.status === 'matched' ? 'ดวลกันอยู่ ☄️' : 'รอคู่ดวล ⏳';
        const oppName = b.playerLowId === userId ? b.playerHighName : b.playerLowName;
        replyMsg += `\n-----------------------\nOrder: #${b.orderNumber}\nยอดดวล: ${b.amount} แต้ม\nฝั่งของคุณ: ${side}\nคู่ดวล: ${oppName || 'รอคู่...'}\nสถานะ: ${statusText}\n${b.status === 'pending_match' ? `💡 พิมพ์ "ยกเลิก ${b.orderNumber}" เพื่อถอนแผลและรับแต้มคืน` : ''}`;
      });
      await replyToLine(replyToken, replyMsg, userId);
    }
    return;
  }

  // C. CANCEL DEAL REQUEST
  const cancelRegex = /^(ยกเลิก|cancel)(?:order|#)?(\d+)$/;
  if (cancelRegex.test(clean)) {
    const match = clean.match(cancelRegex);
    const orderNo = match[2];
    const result = await db.handleCancelBetRequest(userId, orderNo);
    await replyToLine(replyToken, result, userId);
    return;
  }
  
  // D. INITIATE DEPOSIT
  if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit' || clean === 'เติมเครดิต') {
    const depositFlex = constructDepositFlex();
    await replyToLine(replyToken, depositFlex, userId);
    return;
  }

  // E. INITIATE WITHDRAWAL
  if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
    const bank = db.getPlayerBank(userId);
    if (!bank) {
      if (db.hasSuccessfulDeposit(userId)) {
        const regFlex = constructBankRegistrationFlex();
        await replyToLine(replyToken, regFlex, userId);
      } else {
        await replyToLine(replyToken, `❌ คุณไม่สามารถถอนเงินได้เนื่องจากยังไม่มีข้อมูลบัญชี หรือ ไม่เคยทำรายการฝากเครดิตเข้าระบบสำเร็จมาก่อนค่ะ`, userId);
      }
    } else {
      const balance = await db.getPlayerBalance(userId, bank.accountName || displayName);
      const withdrawFlex = constructWithdrawalFlex(bank.bankName, bank.accountNumber, bank.accountName, balance);
      await replyToLine(withdrawFlex ? withdrawFlex : `💸 บัญชีของคุณคือ:\nธนาคาร: ${bank.bankName}\nเลขบัญชี: ${bank.accountNumber}\nชื่อบัญชี: ${bank.accountName}\nยอดคงเหลือ: ${balance} แต้ม\n\n💡 พิมพ์ "ถอน [จำนวน]" เพื่อเริ่มทำรายการค่ะ`, userId);
    }
    return;
  }

  // F. PROCESS WITHDRAWAL REQUEST ("ถอน [amount]")
  const withdrawTextRegex = /^(ถอน|ถอนเงิน|ถอนยอด)(\d+)$/;
  if (withdrawTextRegex.test(clean)) {
    const match = clean.match(withdrawTextRegex);
    const withdrawAmt = parseInt(match[2]);
    const bank = db.getPlayerBank(userId);
    
    if (!bank) {
      await replyToLine(replyToken, `❌ ยังไม่ได้ลงทะเบียนบัญชีธนาคารสำหรับถอนเงิน กรุณาพิมพ์ "ฝากเงิน" เพื่อเริ่มทำการทำรายการ หรือ ส่งรูปหน้าบัญชีธนาคารให้แอดมินลงทะเบียนค่ะ`, userId);
      return;
    }
    
    const balance = await db.getPlayerBalance(userId, bank.accountName || displayName);
    if (balance < withdrawAmt) {
      await replyToLine(replyToken, `⚠️ ขออภัยค่ะ เครดิตของคุณมีไม่เพียงพอ (คงเหลือ ${balance} แต้ม ต้องการถอน ${withdrawAmt} แต้ม)`, userId);
      return;
    }
    
    if (withdrawAmt < 100) {
      await replyToLine(replyToken, `⚠️ ขออภัยค่ะ ระบบกำหนดการถอนเงินขั้นต่ำ 100 แต้มค่ะ`, userId);
      return;
    }

    // Deduct player balance
    await db.adjustPlayerBalance(userId, -withdrawAmt, bank.accountName || displayName);
    
    // Log withdrawal transaction
    db.logTransaction(userId, bank.accountName || displayName, withdrawAmt, 0, 'PENDING_WITHDRAW', 'escalated', `Withdrawal request to ${bank.bankName} ${bank.accountNumber} ${bank.accountName}`);
    
    // Send banking notification flex (money going out)
    const bankFlex = constructBankingFlex("withdraw", withdrawAmt, `ถอนเงินโอนเข้าบัญชี ${bank.bankName} เลขบัญชี ${bank.accountNumber}`, null, userId);
    await replyToLine(replyToken, bankFlex, userId);
    return;
  }

  // G. PROCESS DEPOSIT AMOUNT REQUEST
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
      await replyToLine(replyToken, `⚠️ ขออภัยค่ะ ระบบรองรับการฝากยอดขั้นต่ำ 100 THB และสูงสุดไม่เกิน 10,000 THB ต่อครั้งค่ะ`, userId);
      return;
    }

    db.logTransaction(userId, displayName, depositAmt, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
    const invoiceFlex = constructDepositInvoiceFlex(depositAmt);
    await replyToLine(replyToken, invoiceFlex, userId);
    return;
  }

  // H. ROCKET BETTING PARSING (Custom Thai language regex rocket science logic)
  const isMatchCommand = parseBetCommand(text, userId, displayName, replyToken, groupId);
  if (isMatchCommand) return;

  // I. HELP MENU
  if (clean === 'เมนู' || clean === 'menu' || clean === 'เริ่ม' || clean === 'start' || clean === 'ช่วยเหลือ') {
    const menuFlex = constructMainMenuFlex();
    await replyToLine(replyToken, menuFlex, userId);
    return;
  }

  // J. FALLBACK
  await replyToLine(replyToken, `🤖 ขออภัยค่ะ ไม่เข้าใจคำสั่งของคุณ\nกรุณากดปุ่มที่เมนูด้านล่าง หรือพิมพ์คำสั่ง เช่น "ฝากเงิน", "ถอนยอด" หรือ "เช็คยอด" เพื่อเริ่มทำรายการค่ะ`, userId);
}

export async function handleImageSlipMessage(messageId, userId, displayName, replyToken) {
  userId = await db.getOrCreateShortUserId(userId, displayName);
  // 1. Fetch image binary from LINE API
  const imageUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  let imageBuffer;
  try {
    const imageResponse = await fetch(imageUrl, {
      headers: { "Authorization": "Bearer " + LINE_CHANNEL_ACCESS_TOKEN }
    });
    if (!imageResponse.ok) throw new Error("LINE content fetch failed");
    imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  } catch (err) {
    db.logTransaction(userId, displayName, 0, 0, 'ERR_LINE_IMG', 'escalated', 'LINE Image download failure: ' + err.toString());
    await replyToLine(replyToken, `⚠️ ระบบตรวจสอบสลิปขัดข้องชั่วคราว (ไม่สามารถโหลดรูปภาพได้) บิลของคุณถูกส่งให้แอดมินตรวจสอบแมนนวลหลังบ้านแล้วครับ`);
    return;
  }

  // 2. Call EasySlip/SlipOk checking API
  const formData = new FormData();
  formData.append('image', imageBuffer, { filename: 'payslip.jpg', contentType: 'image/jpeg' });
  formData.append('file', imageBuffer, { filename: 'payslip.jpg', contentType: 'image/jpeg' });

  let slipData;
  let responseCode = 200;
  let responseText = "";
  try {
    const apiResponse = await fetch(SLIP_API_URL, {
      method: "POST",
      headers: { 
        "Authorization": "Bearer " + SLIP_API_KEY,
        ...formData.getHeaders()
      },
      body: formData
    });
    responseCode = apiResponse.status;
    responseText = await apiResponse.text();
    slipData = JSON.parse(responseText);
  } catch (err) {
    db.logTransaction(userId, displayName, 0, 0, 'ERR_CONN', 'escalated', 'Slip API connectivity failure: ' + err.toString());
    await replyToLine(replyToken, `⚠️ ระบบเช็คสลิปขัดข้อง\nการเชื่อมต่อไปยัง API เช็คสลิปขัดข้อง รายการเติมเงินได้ส่งให้แอดมินตรวจสอบแมนนวลในระบบหลังบ้านแล้วครับ`);
    return;
  }

  if (responseCode !== 200) {
    let errorDetail = "";
    try {
      const errObj = JSON.parse(responseText);
      errorDetail = errObj.error ? errObj.error.message : (errObj.message || responseText);
    } catch (e) {
      errorDetail = responseText || "Unknown API response error";
    }
    
    db.logTransaction(userId, displayName, 0, 0, 'ERR_API_' + responseCode, 'escalated', 'API HTTP Error ' + responseCode + ': ' + errorDetail);
    
    if (errorDetail.indexOf("Bangkok Bank") !== -1 && errorDetail.indexOf("pending") !== -1) {
      await replyToLine(replyToken, `🏦 สลิปธนาคารกรุงเทพอยู่ระหว่างประมวลผล\nเนื่องจากระบบธนาคารกรุงเทพมีความล่าช้าชั่วคราวในการอัพเดทข้อมูลธุรกรรม ทำให้ระบบออโต้ยังไม่สามารถตรวจสอบได้ในขณะนี้\n\nบิลของคุณได้ส่งถึงแอดมินเรียบร้อยแล้ว กำลังดำเนินการตรวจสอบแมนนวลหลังบ้านและจะปรับเครดิตให้คุณโดยเร็วที่สุดครับ`);
    } else {
      await replyToLine(replyToken, `⚠️ ระบบเช็คสลิปขัดข้อง (HTTP ${responseCode})\nรายละเอียด: ${errorDetail}\n\nแอดมินได้รับบิลนี้เรียบร้อย กำลังตรวจสอบแมนนวลให้ในระบบหลังบ้านครับ`);
    }
    return;
  }

  if (!slipData.success || !slipData.data) {
    const apiMessage = slipData.message || (slipData.error ? slipData.error.message : 'No QR code readable');
    db.logTransaction(userId, displayName, 0, 0, 'ERR_INVALID_SLIP', 'escalated', 'API check failed: ' + apiMessage);
    await replyToLine(replyToken, `❌ สแกนสลิปไม่ผ่าน\nเหตุผล: ${apiMessage}\n\nระบบส่งต่อบิลนี้ให้แอดมินเช็คบัญชีแมนนวลแล้วครับ`);
    return;
  }

  // 3. Extract transaction details
  let refCode = '';
  if (slipData.data) {
    if (slipData.data.rawSlip && slipData.data.rawSlip.transRef) {
      refCode = slipData.data.rawSlip.transRef;
    } else if (slipData.data.transRef) {
      refCode = slipData.data.transRef;
    } else if (slipData.data.transactionId) {
      refCode = slipData.data.transactionId;
    }
  }

  let actualAmount = 0;
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

  if (!refCode || refCode.trim() === '') {
    db.logTransaction(userId, displayName, 0, actualAmount, 'NO_REF', 'escalated', 'Slip has no transaction reference code');
    await replyToLine(replyToken, `❌ สลิปไม่มีรหัสอ้างอิง!\nระบบตรวจพบว่าสลิปนี้ไม่มีเลขอ้างอิงธุรกรรม อาจเป็นภาพ Screenshot หรือถูกตัดต่อ\n\nกรุณาส่งสลิปจากแอปธนาคารโดยตรงครับ`);
    return;
  }

  if (db.checkIfRefExists(refCode)) {
    db.logTransaction(userId, displayName, 0, actualAmount, refCode, 'escalated', 'Duplicate transaction ref code');
    await replyToLine(replyToken, `⚠️ ตรวจพบสลิปซ้ำในระบบ!\nเลขอ้างอิง: ${refCode}\nสลิปนี้เคยถูกนำมาใช้งานแล้ว\n\nรายการส่งให้แอดมินตรวจสอบแมนนวลครับ`);
    return;
  }

  // Date Check (must be within 24 hours)
  let slipDateStr = '';
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
      db.logTransaction(userId, displayName, 0, actualAmount, refCode, 'escalated', `Stale slip rejected - date: ${slipDateStr}`);
      await replyToLine(replyToken, `⏰ สลิปหมดอายุ!\nสลิปนี้มีวันที่: ${slipDateStr}\nระบบยอมรับเฉพาะสลิปที่โอนภายใน 24 ชั่วโมงที่ผ่านมาเท่านั้นครับ`);
      return;
    }
  }

  let requestedAmount = db.findPendingRequestedAmount(userId);
  if (requestedAmount === null) {
    requestedAmount = actualAmount; // Accept directly if user just sent slip
  }

  // Validate Bank Account Holder & Bank Account Number to make sure they are correct
  // (In Code.gs, they also verify if they have registered a bank, register it now if new)
  let receiverName = '';
  let senderName = '';
  let senderAccount = '';
  let senderBank = '';

  if (slipData.data.rawSlip) {
    receiverName = slipData.data.rawSlip.receiver?.name || '';
    senderName = slipData.data.rawSlip.sender?.name?.thai || slipData.data.rawSlip.sender?.name?.english || '';
    senderAccount = slipData.data.rawSlip.sender?.account?.value || '';
    senderBank = slipData.data.rawSlip.sender?.bank?.displayName || slipData.data.rawSlip.sender?.bank?.name || '';
  }

  // Make sure receiverName contains owner's name (Thai: อิทธิรัตน์, English: ITTHIRAT)
  const isMatchReceiver = receiverName.indexOf("อิทธิรัตน์") !== -1 || receiverName.toUpperCase().indexOf("ITTHIRAT") !== -1;
  if (!isMatchReceiver) {
    db.logTransaction(userId, displayName, requestedAmount, actualAmount, refCode, 'escalated', `Receiver Name Mismatch (Receiver: ${receiverName})`);
    await replyToLine(replyToken, `❌ บัญชีปลายทางไม่ถูกต้อง!\nสลิปนี้ไม่ได้โอนเงินให้กับบัญชีของคุณ อิทธิรัตน์ แนวหล่า\n\nรายการส่งให้แอดมินตรวจสอบแล้วค่ะ`);
    return;
  }

  if (requestedAmount !== actualAmount) {
    db.logTransaction(userId, displayName, requestedAmount, actualAmount, refCode, 'escalated', `Amount Mismatch (Requested ${requestedAmount} vs Slip ${actualAmount})`);
    await replyToLine(replyToken, `⚠️ ยอดเงินโอนไม่ตรงกับใบแจ้งยอด!\nใบแจ้งยอดระบุ: ${requestedAmount} บาท\nยอดโอนจริงในสลิป: ${actualAmount} บาท\n\nระบบโอนเข้าสู่หน้าตรวจสอบของแอดมิน เพื่อพิจารณาปรับเครดิตให้แมนนวลค่ะ`);
    return;
  }

  // Register Bank Info automatically for the user if they don't have one!
  const existingBank = db.getPlayerBank(userId);
  if (!existingBank && senderBank && senderAccount) {
    db.updatePlayerBank(userId, senderBank, senderAccount, senderName || displayName);
  }

  // Approve Transaction & Credit Add
  await db.adjustPlayerBalance(userId, actualAmount, displayName);
  db.logTransaction(userId, displayName, requestedAmount, actualAmount, refCode, 'success', `Auto approved via SlipCheck API. Ref: ${refCode}`);

  // Send Money In Notification Card
  const bankFlex = constructBankingFlex("deposit", actualAmount, `เติมเงินสำเร็จผ่าน Slip API`, null, userId);
  await replyToLine(replyToken, bankFlex, userId);
}

// --- ROCKET BET COMMAND PARSING LOGIC ---

function parseBetCommand(text, userId, displayName, replyToken, groupId) {
  const clean = text.replace(/\s+/g, '').toLowerCase();
  
  // Keywords definition
  const keywordsLow = ['ชล', 'ล', 'ไล่', '+5ชล', '+5ล', 'ช่างไล่'];
  const keywordsHigh = ['ชย', 'ชถ', 'ย', 'ถ', 'ยั่ง', 'ถอย', '+5ชย', '+5ชถ', '+5ย', '+5ถ', 'ช่างยั่ง', 'ช่างถอย'];
  const keywordsAccept = ['ต', 'ติด', 'ครับ', 'เค', 'จ้า', 'ยอมรับ', 'ดีล'];
  
  // 0. Pending Deals Board Command ("กระดานดวล", "แผลค้าง", "เปิดรอคู่")
  if (clean === 'กระดานดวล' || clean === 'แผลค้าง' || clean === 'เปิดรอคู่' || clean === 'รอคู่') {
    const pendingList = db.getPendingBetsList();
    if (pendingList.length === 0) {
      replyToLine(replyToken, `📊 [กระดานดวลสด]\n\n❌ ปัจจุบันไม่มีแผลดวลที่เปิดรอคู่ในระบบเลยค่ะ คุณสามารถเปิดแผลท้าดวลใหม่ได้ทันทีค่ะ 🚀`, userId);
    } else {
      let boardMsg = `📊 [กระดานแผลดวลที่เปิดรอคู่ดวลสด (${pendingList.length} รายการ)]\n`;
      pendingList.forEach((b, idx) => {
        const creatorName = b.playerLowName || b.playerHighName;
        const sideText = b.playerLowId ? 'ต่ำ (ชล)' : 'สูง (ชถ)';
        const rangeText = b.rangeMin && b.rangeMax ? `ช่วง ${b.rangeMin}-${b.rangeMax}s` : '';
        const shortCode = b.orderNumber.slice(-2);
        boardMsg += `\n${idx + 1}. Order #${b.orderNumber} (รหัส: ${shortCode})\n   👤 ผู้ท้า: คุณ${creatorName}\n   🎯 ฝั่ง: ${sideText} ${rangeText}\n   💰 ยอด: ${b.amount} pt\n   👉 พิมพ์ "ต${shortCode}" เพื่อกดรับแผลนี้โดยเฉพาะ\n-----------------------`;
      });
      boardMsg += `\n\n💡 พิมพ์ "ต [เลขแผล]" หรือกดปุ่มบนการ์ดแผลเพื่อรับดวลได้ทันทีค่ะ! ☄️`;
      replyToLine(replyToken, boardMsg, userId);
    }
  // 0.1 Cancel Bet Command (e.g., "ยกเลิก", "ยกเลิก 70572", "ยกเลิก#70572", "ยกเลิก 72", "cancel")
  const cancelBetRegex = /^(ยกเลิก|cancel)\s*#?(\d{2,6})?$/i;
  if (cancelBetRegex.test(clean)) {
    const match = clean.match(cancelBetRegex);
    const targetOrderNo = match[2] || null;

    db.cancelOpenBet(userId, targetOrderNo).then(async res => {
      if (res.success) {
        const msg = `❌ [ยกเลิกแผลดวลสำเร็จ]\nOrder #${res.orderNumber} ถูกยกเลิกโดย คุณ${res.creatorName}\n💰 ระบบคืนเครดิต ${res.amount} แต้มกลับเข้าบัญชีเรียบร้อยแล้วค่ะ 🚀`;
        if (groupId) {
          await pushToLine(groupId, msg);
        } else {
          await replyToLine(replyToken, msg, userId);
        }
      } else if (res.error === 'UNAUTHORIZED') {
        await replyToLine(replyToken, `⚠️ [ไม่อนุญาตให้ยกเลิกแผลผู้เล่นอื่น]\n\nเฉพาะเจ้าของแผลท้าดวล (คุณ${res.creatorName}) หรือแอดมินเท่านั้นที่สามารถยกเลิก Order #${res.orderNumber} ได้ค่ะ`, userId);
      } else {
        const notFoundText = targetOrderNo
          ? `❌ ไม่พบแผลดวล Order #${targetOrderNo} ที่เปิดรอคู่ในระบบเลยค่ะ (แผลอาจจับคู่แล้วหรือถูกยกเลิกไปแล้ว)`
          : `❌ ขออภัยค่ะ คุณไม่มีแผลดวลที่เปิดรอคู่อยู่ในระบบเลยค่ะ`;
        await replyToLine(replyToken, notFoundText, userId);
      }
    });
    return true;
  }

  // 1. Check Accept Match Command (e.g. "ต", "ต12", "ต 12", "12ต", "ต#12", "ติด", "รับแผล")
  const specificAcceptRegex = /^(ต|ติด|ครับ|เค|จ้า|ยอมรับ|ดีล|รับแผล|รับ)\s*#?(\d{2,6})$/;
  const reverseAcceptRegex = /^#?(\d{2,6})\s*(ต|ติด|รับ)$/;
  let targetOrderNo = null;

  if (specificAcceptRegex.test(clean)) {
    targetOrderNo = clean.match(specificAcceptRegex)[2];
  } else if (reverseAcceptRegex.test(clean)) {
    targetOrderNo = clean.match(reverseAcceptRegex)[1];
  }

  if (keywordsAccept.includes(clean) || targetOrderNo) {
    db.matchExistingOpenBet(userId, displayName, targetOrderNo).then(async matched => {
      if (matched && matched.error === 'INSUFFICIENT_BALANCE') {
        await replyToLine(replyToken, `⚠️ [ไม่อนุญาตให้เล่นเกินเครดิต]\n\nคุณไม่สามารถกดรับแผลดวลนี้ได้ เนื่องจากยอดเครดิตคงเหลือไม่เพียงพอ!\n• เครดิตคงเหลือของคุณ: ${matched.current} แต้ม\n• ยอดแผลที่ต้องการดวล: ${matched.required} แต้ม\n\n❌ ระบบได้ทำการบล็อกรายการนี้เรียบร้อยค่ะ กรุณาพิมพ์ "ฝากเงิน" เพื่อเติมเครดิตก่อนแทงดวลนะคะ 🚀`, userId);
        return;
      }

      if (matched && matched.orderNumber) {
        // Send Private 1-on-1 Flex Notification DM to Creator
        const creatorName = matched.playerLowName || matched.playerHighName;
        const creatorBal = await db.getPlayerBalance(matched.creatorId, creatorName);
        const flexCreator = constructMatchNotificationFlex(matched.orderNumber, matched.amount, displayName, 'creator', creatorBal);
        await pushToLine(matched.creatorId, flexCreator);

        // Send Private 1-on-1 Flex Notification DM to Matcher
        const matcherBal = await db.getPlayerBalance(matched.matcherId, displayName);
        const flexMatcher = constructMatchNotificationFlex(matched.orderNumber, matched.amount, creatorName, 'matcher', matcherBal);
        await pushToLine(matched.matcherId, flexMatcher);

        // Reply in group or chat
        if (groupId) {
          await pushToLine(groupId, `☄️ [จับคู่ดวลสำเร็จ!]\n👤 ผู้กดรับแผล: คุณ ${displayName}\nOrder #${matched.orderNumber}\nคู่ดวล: คุณ ${matched.playerLowName} 🆚 คุณ ${matched.playerHighName}\nยอดดวล: ${matched.amount} แต้ม\nสถานะ: แมตช์ดวลเรียบร้อย (หักเครดิตเข้ากองกลาง 100% เรียบร้อยแล้วค่ะ) 🚀`);
        } else {
          await replyToLine(replyToken, flexMatcher, userId);
        }
      } else {
        const notFoundText = targetOrderNo
          ? `❌ ไม่พบแผลดวล Order #${targetOrderNo} ที่เปิดรอคู่ในระบบเลยค่ะ (แผลอาจจับคู่แล้วหรือถูกยกเลิก)`
          : `❌ ขออภัยค่ะ ตอนนี้ไม่มีแผลดวลฝั่งตรงข้ามที่รอคู่ดวลในระบบเลยค่ะ คุณสามารถเปิดแผลใหม่ได้ทันทีค่ะ`;
        await replyToLine(replyToken, notFoundText, userId);
      }
    });
    return true;
  }

  // 2. Betting commands (e.g., "ล200", "ถ500", "+5ชล200", "300-340ล", "345-385ล500 ชตย")
  const isChotoy = clean.includes('ชตย') || text.includes('ชตย');
  const cleanBetText = clean.replace(/ชตย/g, '').trim();

  // Format 1: [keywords][amount] (e.g. "ล200", "ถ500")
  const betRegex = /^(\+?5?[a-zA-Z\u0e00-\u0e7f]+)(\d+)$/;
  if (betRegex.test(cleanBetText)) {
    const match = cleanBetText.match(betRegex);
    const cmd = match[1];
    const amount = parseInt(match[2]);
    
    let side = '';
    if (keywordsLow.includes(cmd)) side = 'low';
    else if (keywordsHigh.includes(cmd)) side = 'high';
    
    if (side && amount >= 10) {
      processOpenBetRequest(side, amount, 'normal', null, null, userId, displayName, replyToken, isChotoy);
      return true;
    }
  }

  // Format 2: [Min]-[Max][keywords][amount?] (e.g. "300-340ล", "300-340ถ", "300-340ล1000", "345-385ล500 ชตย")
  const rangeBetRegex = /^(\d+)-(\d+)([a-zA-Z\u0e00-\u0e7f]+)(\d*)?$/;
  if (rangeBetRegex.test(cleanBetText)) {
    const match = cleanBetText.match(rangeBetRegex);
    const minVal = parseInt(match[1]);
    const maxVal = parseInt(match[2]);
    const cmd = match[3];
    const amount = match[4] ? parseInt(match[4]) : 500; // Default amount to 500 pt if not specified
    
    let side = '';
    if (keywordsLow.includes(cmd)) side = 'low';
    else if (keywordsHigh.includes(cmd)) side = 'high';
    
    if (side && amount >= 10 && minVal < maxVal) {
      processOpenBetRequest(side, amount, 'range', minVal, maxVal, userId, displayName, replyToken, isChotoy);
      return true;
    }
  }

  return false;
}

async function processOpenBetRequest(side, amount, type, minVal, maxVal, userId, displayName, replyToken, isChotoy = false) {
  const balance = await db.getPlayerBalance(userId, displayName);
  if (balance < amount) {
    await replyToLine(replyToken, `⚠️ [ไม่อนุญาตให้เล่นเกินเครดิต]\n\nยอดเงินเครดิตคงเหลือของคุณไม่เพียงพอสำหรับการท้าดวลแผลนี้!\n• เครดิตคงเหลือของคุณ: ${balance} แต้ม\n• ยอดที่ต้องการใช้: ${amount} แต้ม\n\n❌ กรุณาพิมพ์ "ฝากเงิน" เพื่อทำรายการเติมทุนก่อนแทงดวลนะคะ 🚀`, userId);
    return;
  }

  // Generate order number
  const orderNo = Math.floor(Math.random() * 899999 + 100000);
  
  // Deduct balance (with strict return check)
  const success = await db.adjustPlayerBalance(userId, -amount, displayName);
  if (!success) {
    await replyToLine(replyToken, `⚠️ [ไม่อนุญาตให้เล่นเกินเครดิต]\n\nเกิดข้อผิดพลาด: ยอดเงินเครดิตคงเหลือของคุณไม่เพียงพอสำหรับการท้าดวลแผลนี้ (คงเหลือ ${balance} แต้ม ต้องการใช้ ${amount} แต้ม)\n\n❌ กรุณาพิมพ์ "ฝากเงิน" เพื่อเติมเครดิตก่อนแทงดวลนะคะ 🚀`, userId);
    return;
  }
  
  // Save open bet
  const saved = db.saveOpenBet(orderNo, userId, displayName, side, amount, type, minVal, maxVal);
  if (!saved) {
    await replyToLine(replyToken, `⚠️ [ไม่อนุญาตให้เล่นเกินเครดิต]\n\nไม่สามารถบันทึกรายการท้าดวลได้ เนื่องจากเครดิตไม่เพียงพอค่ะ`, userId);
    return;
  }
  
  let rangeInfo = '';
  if (type === 'range') {
    rangeInfo = `${minVal}-${maxVal}${isChotoy ? ' (ชตย: ช่างไม่ต่อย)' : ''}`;
  } else if (isChotoy) {
    rangeInfo = '(ชตย: ช่างไม่ต่อย)';
  }
  
  const betCard = constructBetOpenFlex(orderNo, amount, side, displayName, rangeInfo);
  await replyToLine(replyToken, betCard, userId);
}

// --- LINE FLEX CONSTRUCTORS ---

export function constructMainMenuFlex() {
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

export function constructBalanceFlex(displayName, balance) {
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

export function constructDepositFlex() {
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

export function constructDepositInvoiceFlex(depositAmt) {
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

export function constructBankRegistrationFlex() {
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

export function constructWithdrawalFlex(bankName, accountNumber, accountName, balance) {
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

export function constructBetOpenFlex(orderNo, amount, side, creatorName, rangeInfo) {
  const sideText = side === 'low' ? 'ต่ำ (Low)' : 'สูง (High)';
  const sideColor = side === 'low' ? '#1E88E5' : '#E53935';
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
      "spacing": "sm",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": "#1E88E5",
          "action": {
            "type": "message",
            "label": "🤝 กดรับแผลดวลนี้ (Order #" + orderNo + ")",
            "text": "ต " + orderNo
          }
        },
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "color": "#D32F2F",
          "action": {
            "type": "message",
            "label": "❌ ยกเลิกแผลนี้ (เจ้าของแผล)",
            "text": "ยกเลิก " + orderNo
          }
        },
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "action": {
            "type": "message",
            "label": "📋 รายการดวลของคุณ",
            "text": "รายการดวล"
          }
        }
      ],
      "paddingAll": "16px"
    }
  };
}

export function constructMatchNotificationFlex(orderNo, amount, opponentName, role, currentBalance) {
  const isCreator = role === 'creator';
  return {
    "type": "bubble",
    "size": "mega",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": isCreator ? "☄️ มีผู้เล่นกดรับแผลดวลของคุณ!" : "☄️ ยืนยันการรับแผลดวลสำเร็จ!",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md"
        }
      ],
      "backgroundColor": isCreator ? "#1E88E5" : "#43A047",
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
            { "type": "text", "text": "เลขที่ดีล:", "color": "#888888", "size": "sm", "flex": 4 },
            { "type": "text", "text": "#" + orderNo, "weight": "bold", "color": "#333333", "size": "sm", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            { "type": "text", "text": "คู่ดวลของคุณ:", "color": "#888888", "size": "sm", "flex": 4 },
            { "type": "text", "text": opponentName, "weight": "bold", "color": "#00796B", "size": "sm", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            { "type": "text", "text": "ยอดท้าดวล:", "color": "#888888", "size": "sm", "flex": 4 },
            { "type": "text", "text": amount + " แต้ม", "weight": "bold", "color": "#E65100", "size": "sm", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            { "type": "text", "text": "สถานะแต้ม:", "color": "#888888", "size": "sm", "flex": 4 },
            { "type": "text", "text": "หักแต้มเข้ากองกลางแล้ว", "weight": "bold", "color": "#43A047", "size": "sm", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            { "type": "text", "text": "เครดิตคงเหลือ:", "color": "#888888", "size": "sm", "flex": 4 },
            { "type": "text", "text": currentBalance + " แต้ม", "weight": "bold", "color": "#333333", "size": "sm", "flex": 6, "align": "end" }
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
          "style": "secondary",
          "height": "sm",
          "action": {
            "type": "message",
            "label": "📋 ดูรายการดวลทั้งหมด",
            "text": "รายการดวล"
          }
        }
      ],
      "paddingAll": "16px"
    }
  };
}

export function constructBankingFlex(type, amount, accountDetails, targetUrl, userId) {
  let formattedAmount = "";
  try {
    const parsedAmount = parseFloat(amount.toString().replace(/,/g, ''));
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

  const dateStr = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });

  const isIncome = (type === "Income" || type === "deposit" || type === "เงินเข้า" || type === "ฝากเงิน");
  const headerBgColor = isIncome ? "#00796B" : "#455A64"; 
  const badgeText = isIncome ? "เงินเข้า" : "เงินออก";
  const badgeBgColor = isIncome ? "#E0F2F1" : "#ECEFF1";
  const badgeTextColor = isIncome ? "#00796B" : "#455A64";
  
  const amountText = (isIncome ? "+" : "-") + formattedAmount + " บาท";
  const amountTextColor = isIncome ? "#00796B" : "#455A64";
  
  const transactionLabel = isIncome ? "โอนเงินเข้าบัญชี" : "ถอน/โอนเงินออกจากบัญชี";
  const buttonColor = isIncome ? "#00796B" : "#455A64";
  
  let finalUrl = targetUrl || "";
  if (!finalUrl) {
    finalUrl = APP_URL;
    if (userId) finalUrl += "?userId=" + userId;
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

export function constructRejectionFlex(type, amount, reason, currentBalance, userId) {
  let formattedAmount = "";
  try {
    const parsedAmount = parseFloat(amount.toString().replace(/,/g, ''));
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

  const dateStr = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });

  const isWithdrawal = (type === "WD" || type === "withdraw" || type === "ถอนเงิน");
  const title = isWithdrawal ? "คำขอถอนเงินถูกปฏิเสธ" : "บิลฝากเงินถูกปฏิเสธ";
  const headerBgColor = "#E07A5F"; 
  const badgeText = "ปฏิเสธ";
  const badgeBgColor = "#FDF0ED";
  const badgeTextColor = "#E07A5F";
  
  const amountText = formattedAmount + " บาท";
  const amountTextColor = "#E07A5F";
  
  const transactionLabel = isWithdrawal ? "ถอนเครดิต (คืนแต้ม)" : "แจ้งฝากเงิน";
  const balanceLabel = isWithdrawal ? "ยอดคงเหลือปัจจุบัน" : "ยอดคงเหลือ";
  const balanceText = currentBalance !== undefined ? currentBalance.toLocaleString('th-TH') + " แต้ม" : "-";

  const contents = [
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

  let finalUrl = APP_URL;
  if (userId) finalUrl += "?userId=" + userId;

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
            "uri": "tel:0891041992"
          }
        }
      ],
      "flex": 0,
      "paddingAll": "16px"
    }
  };
}

export function constructMatchResultFlex(isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission, userId) {
  const headerBgColor = isWinner ? "#00796B" : "#455A64"; 
  const title = isWinner ? "🏆 สรุปผลดวล - คุณชนะ!" : "☄️ สรุปผลดวล - คุณแพ้";
  const badgeText = isWinner ? "ชนะ" : "แพ้";
  const badgeBgColor = isWinner ? "#E8F5E9" : "#ECEFF1";
  const badgeTextColor = isWinner ? "#00796B" : "#455A64";
  
  const amountText = isWinner ? "+" + payout.toLocaleString('th-TH') + " แต้ม" : "-" + amount.toLocaleString('th-TH') + " แต้ม";
  const amountTextColor = isWinner ? "#00796B" : "#E07A5F";
  
  const details = isWinner 
    ? "คืนทุน " + amount + " + กำไรหลังหักคอมมิชชั่น 10% (" + (winnings - commission) + " แต้ม)"
    : "หักเครดิตตามจำนวนเดิมพัน";

  const contents = [
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

  let finalUrl = APP_URL;
  if (userId) finalUrl += "?userId=" + userId;

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

// Push match result to line helper
export async function sendMatchResultPush(userId, isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission) {
  const flex = constructMatchResultFlex(isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission, userId);
  await pushToLine(userId, flex);
}
