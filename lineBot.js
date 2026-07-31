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
    const pName = (userId ? db.getPlayerNameFromDb(userId) : null) || 'ผู้เล่น';
    const tagStr = `@${pName}`;
    
    if (userId && !outText.includes('@') && !outText.includes('ถึงคุณ')) {
      outText = `👤 [ถึงคุณ ${tagStr}]:\n` + outText;
    }
    
    messageObj = { type: 'text', text: outText };

    // Attach native LINE mention object if target is a real LINE User ID
    const rawUserId = userId ? (db.getRawLineUserId(userId) || userId) : null;
    if (typeof rawUserId === 'string' && rawUserId.startsWith('U')) {
      const tagIndex = outText.indexOf(tagStr);
      if (tagIndex !== -1) {
        messageObj.mention = {
          mentionees: [
            {
              index: tagIndex,
              length: tagStr.length,
              userId: rawUserId
            }
          ]
        };
      }
    }
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
    if (destinationId && (destinationId.startsWith('C') || db.getActiveGroupId() === destinationId)) {
      payload = `💡 [เมนูระบบดวลส่วนตัว]\n\nเมนูเช็คยอด เติมเงิน ถอนเงิน และตั้งค่าบัญชี เป็นข้อมูลส่วนบุคคลส่วนตัวค่ะ 💬\n\nท่านสามารถกดทักแชตตรงหา LINE OA แบบส่วนตัวเพื่อใช้งานได้ทันทีค่ะ!\n\n📌 สำหรับในกลุ่มนี้ ใช้สำหรับส่งคำสั่งแทงดวลสด (ชล, ชถ, 330-380ล) และพิมพ์ "กระดานดวล" เพื่อดูแผลค้างเท่านั้นค่ะ 🚀`;
    } else {
      payload = constructMainMenuFlex();
    }
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
    await pushToLine(groupId, `🚨 [UNSEND] @${displayName} ยกเลิกข้อความ: "${msgText}" (ผลดวลในระบบมีผลตามเดิมครับ)`);
  } else if (userId) {
    await pushToLine(userId, `🚨 [UNSEND] คุณ @${displayName} ได้ยกเลิกข้อความ: "${msgText}" ครับ`);
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
    await replyToLine(replyToken, `🚀 เปิดรอบ ➔ ${roundName}`, userId);
    return;
  }

  // Admin Command: Lock / Close Betting for Round ("ปิดรอบ", "ปิดรับดวล", "ล็อครอบ", "3-2-go")
  const closeRoundRegex = /^(ปิดรอบ|ปิดรับดวล|ล็อครอบ|3-2-go|32go)$/i;
  if (closeRoundRegex.test(clean)) {
    db.setRocketRoundStatus('CLOSED');
    const currentRound = db.getActiveRocketRound();
    const closeFlex = constructRoundCloseFlex(currentRound.name);
    await replyToLine(replyToken, closeFlex, userId);
    return;
  }

  // Admin Command 2: Settle Rocket Flight Round ("แจ้งผล [วินาที]")
  const announceResultRegex = /^(แจ้งผล|ผล|ผลรอบ)\s*(\d+)$/;
  if (announceResultRegex.test(text.trim())) {
    const match = text.trim().match(announceResultRegex);
    const finalSeconds = parseInt(match[2]);
    const currentRound = db.getActiveRocketRound();
    await db.adminResolveBets(finalSeconds, 350, sendMatchResultPush);
    await replyToLine(replyToken, `🏆 [ผลรอบ ${currentRound.name}]: ${finalSeconds}s | เคลียร์ยอดเรียบร้อยครับ`, userId);
    return;
  }
  
  // A. CHECK BALANCE
  if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
    if (groupId) {
      await replyToLine(replyToken, `💡 [แชตส่วนตัว] เช็คยอด/ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
    } else {
      const balance = await db.getPlayerBalance(userId, displayName);
      const balanceFlex = constructBalanceFlex(displayName, balance);
      await replyToLine(replyToken, balanceFlex, userId);
    }
    return;
  }
  
  // B. LIST ACTIVE DEALS
  if (clean === 'รายการจับคู่' || clean === 'matched' || clean === 'รายการดวล') {
    const matchedBets = db.getPlayerActiveBets(userId);
    if (matchedBets.length === 0) {
      await replyToLine(replyToken, `📝 [รายการดวล]: ไม่มีแผลดวลค้างครับ`, userId);
    } else {
      let replyMsg = `📝 [รายการดวลของคุณ (${matchedBets.length})]:\n`;
      matchedBets.forEach(b => {
        const side = b.playerLowId === userId ? 'ต่ำ' : 'สูง';
        const oppName = b.playerLowId === userId ? b.playerHighName : b.playerLowName;
        replyMsg += `#${b.orderNumber} | ${side} | ${b.amount}pt vs ${oppName || 'รอคู่'}\n`;
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
    if (groupId) {
      await replyToLine(replyToken, `💡 [แชตส่วนตัว] เช็คยอด/ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
    } else {
      const depositFlex = constructDepositFlex();
      await replyToLine(replyToken, depositFlex, userId);
    }
    return;
  }

  // E. INITIATE WITHDRAWAL
  if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
    if (groupId) {
      await replyToLine(replyToken, `💡 [แชตส่วนตัว] เช็คยอด/ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
    } else {
      const bank = db.getPlayerBank(userId);
      if (!bank) {
        if (db.hasSuccessfulDeposit(userId)) {
          const regFlex = constructBankRegistrationFlex();
          await replyToLine(replyToken, regFlex, userId);
        } else {
          await replyToLine(replyToken, `❌ ยังไม่มีข้อมูลบัญชี กรุณาทักแอดมินลงทะเบียนครับ`, userId);
        }
      } else {
        const balance = await db.getPlayerBalance(userId, bank.accountName || displayName);
        const withdrawFlex = constructWithdrawalFlex(bank.bankName, bank.accountNumber, bank.accountName, balance);
        await replyToLine(withdrawFlex ? withdrawFlex : `💸 บัญชี: ${bank.bankName} ${bank.accountNumber} (${balance}pt)\nพิมพ์ "ถอน [จำนวน]" เพื่อเริ่มทำรายการครับ`, userId);
      }
    }
    return;
  }

  // F. PROCESS WITHDRAWAL REQUEST ("ถอน [amount]")
  const withdrawTextRegex = /^(ถอน|ถอนเงิน|ถอนยอด)(\d+)$/;
  if (withdrawTextRegex.test(clean)) {
    if (groupId) {
      await replyToLine(replyToken, `💡 [แชตส่วนตัว] เช็คยอด/ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
      return;
    }
    const match = clean.match(withdrawTextRegex);
    const withdrawAmt = parseInt(match[2]);
    const bank = db.getPlayerBank(userId);
    
    if (!bank) {
      await replyToLine(replyToken, `❌ ยังไม่ได้ลงทะเบียนบัญชีธนาคาร กรุณาแจ้งแอดมินครับ`, userId);
      return;
    }
    
    const balance = await db.getPlayerBalance(userId, bank.accountName || displayName);
    if (balance < withdrawAmt) {
      await replyToLine(replyToken, `⚠️ เครดิตไม่พอ (มี ${balance}pt ต้องการถอน ${withdrawAmt}pt)`, userId);
      return;
    }
    
    if (withdrawAmt < 100) {
      await replyToLine(replyToken, `⚠️ ถอนขั้นต่ำ 100pt ครับ`, userId);
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
    if (groupId) {
      await replyToLine(replyToken, `💡 [แชตส่วนตัว] เช็คยอด/ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ 🚀`, userId);
      return;
    }
    if (depositAmt < 100 || depositAmt > 10000) {
      await replyToLine(replyToken, `⚠️ ยอดฝากขั้นต่ำ 100 บาท สูงสุด 10,000 บาทครับ`, userId);
      return;
    }

    db.logTransaction(userId, displayName, depositAmt, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
    const invoiceFlex = constructDepositInvoiceFlex(depositAmt);
    await replyToLine(replyToken, invoiceFlex, userId);
    return;
  }

  // H. ROCKET BETTING PARSING (Custom Thai language regex rocket science logic)
  const isMatchCommand = await parseBetCommand(text, userId, displayName, replyToken, groupId);
  if (isMatchCommand) return;

  // I. HELP MENU
  if (clean === 'เมนู' || clean === 'menu' || clean === 'เริ่ม' || clean === 'start' || clean === 'ช่วยเหลือ') {
    if (groupId) {
      await replyToLine(replyToken, `💡 [เมนูส่วนตัว] รายการเช็คยอด เติมเงิน ถอนเงิน เป็นข้อมูลส่วนบุคคลส่วนตัว กรุณาทักแชตตรงหา LINE OA แบบส่วนตัวครับ (ในกลุ่มใช้พิมพ์แทงดวลสด และพิมพ์ "กระดานดวล") 🚀`, userId);
    } else {
      const menuFlex = constructMainMenuFlex();
      await replyToLine(replyToken, menuFlex, userId);
    }
    return;
  }

  // J. FALLBACK
  await replyToLine(replyToken, `🤖 ไม่เข้าใจคำสั่ง พิมพ์ "เมนู" เพื่อดูคำสั่งที่ใช้ได้ค่ะ`, userId);
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
    await replyToLine(replyToken, `⚠️ ระบบตรวจสอบสลิปขัดข้องชั่วคราว\n📩 ส่งรายการให้แอดมินตรวจสอบแมนนวลแล้วค่ะ`);
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
    await replyToLine(replyToken, `⚠️ ระบบสแกนสลิปขัดข้องชั่วคราว\n📩 ส่งรายการให้แอดมินตรวจสอบแมนนวลแล้วค่ะ`);
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
      await replyToLine(replyToken, `🏦 สลิป BBL อยู่ระหว่างประมวลผล\n📩 ส่งรายการให้แอดมินตรวจสอบแมนนวลแล้วค่ะ`);
    } else {
      await replyToLine(replyToken, `⚠️ ระบบสแกนสลิปขัดข้อง (HTTP ${responseCode})\n📩 ส่งรายการให้แอดมินตรวจสอบแล้วค่ะ`);
    }
    return;
  }

  if (!slipData.success || !slipData.data) {
    const apiMessage = slipData.message || (slipData.error ? slipData.error.message : 'No QR code readable');
    db.logTransaction(userId, displayName, 0, 0, 'ERR_INVALID_SLIP', 'escalated', 'API check failed: ' + apiMessage);
    await replyToLine(replyToken, `❌ สแกนสลิปไม่ผ่าน (${apiMessage})\n📩 ส่งรายการให้แอดมินตรวจสอบแล้วค่ะ`);
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
    await replyToLine(replyToken, `❌ สลิปไม่มีเลขอ้างอิงธุรกรรม\n📷 กรุณาส่งสลิปจากแอปธนาคารโดยตรงค่ะ`);
    return;
  }

  if (db.checkIfRefExists(refCode)) {
    db.logTransaction(userId, displayName, 0, actualAmount, refCode, 'escalated', 'Duplicate transaction ref code');
    await replyToLine(replyToken, `⚠️ สลิปซ้ำในระบบ (Ref: ${refCode})\n📩 ส่งรายการให้แอดมินตรวจสอบแล้วค่ะ`);
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
      await replyToLine(replyToken, `⏰ สลิปหมดอายุ (โอนเมื่อ ${slipDateStr})\n⚠️ รับเฉพาะสลิปภายใน 24 ชม. เท่านั้นค่ะ`);
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
    await replyToLine(replyToken, `❌ บัญชีปลายทางไม่ถูกต้อง\n📩 ส่งรายการให้แอดมินตรวจสอบแล้วค่ะ`);
    return;
  }

  if (requestedAmount !== actualAmount) {
    db.logTransaction(userId, displayName, requestedAmount, actualAmount, refCode, 'escalated', `Amount Mismatch (Requested ${requestedAmount} vs Slip ${actualAmount})`);
    await replyToLine(replyToken, `⚠️ ยอดโอนไม่ตรง (ระบุ ${requestedAmount}B | สลิป ${actualAmount}B)\n📩 ส่งรายการให้แอดมินตรวจสอบแล้วค่ะ`);
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

async function parseBetCommand(text, userId, displayName, replyToken, groupId) {
  const clean = text.replace(/\s+/g, '').toLowerCase();
  
  // Keywords definition
  const keywordsLow = ['ชล', 'ล', 'ไล่', '+5ชล', '+5ล', 'ช่างไล่'];
  const keywordsHigh = ['ชย', 'ชถ', 'ย', 'ถ', 'ยั่ง', 'ถอย', '+5ชย', '+5ชถ', '+5ย', '+5ถ', 'ช่างยั่ง', 'ช่างถอย'];
  const keywordsAccept = ['ต', 'ติด', 'ครับ', 'เค', 'จ้า', 'ยอมรับ', 'ดีล'];
  
  // 0. Pending Deals Board Command ("กระดานดวล", "แผลค้าง", "เปิดรอคู่")
  if (clean === 'กระดานดวล' || clean === 'แผลค้าง' || clean === 'เปิดรอคู่' || clean === 'รอคู่') {
    const pendingList = db.getPendingBetsList();
    if (pendingList.length === 0) {
      replyToLine(replyToken, `📊 [กระดานดวล]: ไม่มีแผลดวลค้างครับ 🚀`, userId);
    } else {
      let boardMsg = `📊 [กระดานดวล (${pendingList.length} แผล)]:\n`;
      pendingList.forEach((b, idx) => {
        const creatorName = b.playerLowName || b.playerHighName;
        const sideText = b.playerLowId ? 'ต่ำ' : 'สูง';
        const rangeText = b.rangeMin && b.rangeMax ? `${b.rangeMin}-${b.rangeMax}s` : '';
        const shortCode = b.orderNumber.slice(-2);
        boardMsg += `${idx + 1}. #${b.orderNumber} (${shortCode}) | ${sideText} ${rangeText} | ${b.amount}pt (@${creatorName}) 👉 "ต${shortCode}"\n`;
      });
      boardMsg += `💡 พิมพ์ "ต [เลข]" เพื่อรับดวลครับ`;
      replyToLine(replyToken, boardMsg, userId);
    }
    return true;
  }

  // 0.1 Cancel Bet Command (e.g., "ยกเลิก", "ยกเลิก 70572", "ยกเลิก#70572", "ยกเลิก 72", "cancel")
  const cancelBetRegex = /^(ยกเลิก|cancel)\s*#?(\d{2,6})?$/i;
  if (cancelBetRegex.test(clean)) {
    const match = clean.match(cancelBetRegex);
    const targetOrderNo = match[2] || null;

    db.cancelOpenBet(userId, targetOrderNo).then(async res => {
      if (res.success) {
        const msg = `❌ [#${res.orderNumber} ยกเลิก] คืน ${res.amount}pt ให้ @${res.creatorName} เรียบร้อยครับ 🚀`;
        if (groupId) {
          await pushToLine(groupId, msg);
        } else {
          await replyToLine(replyToken, msg, userId);
        }
      } else if (res.error === 'UNAUTHORIZED') {
        await replyToLine(replyToken, `⚠️ เฉพาะเจ้าของแผล (@${res.creatorName}) หรือแอดมินเท่านั้นที่ยกเลิกได้ครับ`, userId);
      } else {
        const notFoundText = targetOrderNo
          ? `❌ ไม่พบแผล Order #${targetOrderNo} ครับ`
          : `❌ คุณไม่มีแผลดวลค้างครับ`;
        await replyToLine(replyToken, notFoundText, userId);
      }
    });
    return true;
  }

  // 1. Check Accept Match Command (e.g. "ต", "ต12", "ต 12", "ต905662 400", "12ต", "ต#12", "ติด", "รับแผล")
  const specificAcceptRegex = /^(ต|ติด|ครับ|เค|จ้า|ยอมรับ|ดีล|รับแผล|รับ)\s*#?(\d{2,6})(?:\s*\d+)?$/i;
  const reverseAcceptRegex = /^#?(\d{2,6})\s*(ต|ติด|รับ)(?:\s*\d+)?$/i;
  let targetOrderNo = null;

  const rawTrimmed = text.trim();
  if (specificAcceptRegex.test(rawTrimmed)) {
    targetOrderNo = rawTrimmed.match(specificAcceptRegex)[2];
  } else if (specificAcceptRegex.test(clean)) {
    targetOrderNo = clean.match(specificAcceptRegex)[2];
  } else if (reverseAcceptRegex.test(rawTrimmed)) {
    targetOrderNo = rawTrimmed.match(reverseAcceptRegex)[1];
  } else if (reverseAcceptRegex.test(clean)) {
    targetOrderNo = clean.match(reverseAcceptRegex)[1];
  }

  if (keywordsAccept.includes(clean) || targetOrderNo) {
    if (db.isRocketRoundClosed()) {
      await replyToLine(replyToken, `⚠️ ปิดรับดวลรอบนี้แล้วค่ะ (หมดเวลาแทงก่อนปล่อยบั้งไฟ)`, userId);
      return true;
    }
    db.matchExistingOpenBet(userId, displayName, targetOrderNo).then(async matched => {
      if (matched && matched.error === 'INSUFFICIENT_BALANCE') {
        await replyToLine(replyToken, `⚠️ เครดิตไม่พอ (มี ${matched.current}pt ต้องใช้ ${matched.required}pt)`, userId);
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
        const flexMatcher = constructMatchNotificationFlex(matched.orderNumber, matched.amount, matched.playerLowName, matched.playerHighName, matched.rangeInfo, matched.isChotoy, matched.rocketName);
        await pushToLine(matched.matcherId, flexMatcher);

        // Reply in group or chat
        if (groupId) {
          await pushToLine(groupId, `☄️ [#${matched.orderNumber} แมตช์!] @${matched.playerLowName} (ต่ำ) 🆚 @${matched.playerHighName} (สูง) | ${matched.amount}pt 🚀`);
        } else {
          await replyToLine(replyToken, flexMatcher, userId);
        }
      } else {
        const notFoundText = targetOrderNo
          ? `❌ ไม่พบแผล Order #${targetOrderNo} ที่เปิดรอคู่ครับ`
          : `❌ ไม่มีแผลดวลฝั่งตรงข้ามที่รอคู่ในขณะนี้ครับ`;
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
  if (db.isRocketRoundClosed()) {
    await replyToLine(replyToken, `⚠️ ปิดรับดวลรอบนี้แล้วค่ะ (หมดเวลาแทงก่อนปล่อยบั้งไฟ)`, userId);
    return;
  }
  const balance = await db.getPlayerBalance(userId, displayName);
  if (balance < amount) {
    await replyToLine(replyToken, `⚠️ เครดิตไม่พอ (มี ${balance}pt | ต้องการ ${amount}pt)\n💵 พิมพ์ "ฝากเงิน" เพื่อเติมเครดิตค่ะ`, userId);
    return;
  }

  // Generate order number
  const orderNo = Math.floor(Math.random() * 899999 + 100000);
  
  // Deduct balance (with strict return check)
  const success = await db.adjustPlayerBalance(userId, -amount, displayName);
  if (!success) {
    await replyToLine(replyToken, `⚠️ เครดิตไม่พอ (มี ${balance}pt | ต้องการ ${amount}pt)\n💵 พิมพ์ "ฝากเงิน" เพื่อเติมเครดิตค่ะ`, userId);
    return;
  }
  
  // Save open bet
  const saved = db.saveOpenBet(orderNo, userId, displayName, side, amount, type, minVal, maxVal);
  if (!saved) {
    await replyToLine(replyToken, `⚠️ ไม่สามารถบันทึกแผลดวลได้ เครดิตไม่พอค่ะ`, userId);
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
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "🚀 Rocket Science",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "6px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "เลือกบริการที่คุณต้องการครับ",
          "size": "xxs",
          "color": "#555555",
          "wrap": true
        }
      ],
      "paddingAll": "6px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
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
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "เช็คยอด",
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
          "spacing": "xs",
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
      "paddingAll": "6px"
    }
  };
}

export function constructBalanceFlex(displayName, balance) {
  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💳 เครดิตคงเหลือ",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "6px"
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
              "size": "xxs",
              "flex": 4
            },
            {
              "type": "text",
              "text": displayName,
              "weight": "bold",
              "color": "#333333",
              "size": "xxs",
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
              "text": "💰 ยอดคงเหลือ:",
              "color": "#888888",
              "size": "xxs",
              "flex": 5
            },
            {
              "type": "text",
              "text": balance.toFixed(2) + " pt",
              "weight": "bold",
              "color": "#2E7D32",
              "size": "xs",
              "flex": 5,
              "align": "end"
            }
          ]
        }
      ],
      "paddingAll": "6px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
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
        }
      ],
      "paddingAll": "6px"
    }
  };
}

export function constructDepositFlex() {
  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💰 ฝากเครดิต",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "6px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "เลือกยอดเงินที่ต้องการฝากครับ",
          "size": "xxs",
          "color": "#555555",
          "wrap": true
        }
      ],
      "paddingAll": "6px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
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
          "spacing": "xs",
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
        }
      ],
      "paddingAll": "6px"
    }
  };
}

export function constructDepositInvoiceFlex(depositAmt) {
  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "🧾 ใบแจ้งยอดโอน",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "6px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "contents": [
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            { "type": "text", "text": "🏦 SCB:", "color": "#888888", "size": "xxs", "flex": 4 },
            { "type": "text", "text": "064-2-35656-6", "weight": "bold", "color": "#333333", "size": "xxs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            { "type": "text", "text": "👤 ชื่อ:", "color": "#888888", "size": "xxs", "flex": 4 },
            { "type": "text", "text": "อิทธิรัตน์ แนวหล่า", "weight": "bold", "color": "#333333", "size": "xxs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "contents": [
            { "type": "text", "text": "💵 ยอด:", "color": "#888888", "size": "xxs", "flex": 4 },
            { "type": "text", "text": depositAmt + ".00 บาท", "weight": "bold", "color": "#2E7D32", "size": "xs", "flex": 6, "align": "end" }
          ]
        }
      ],
      "paddingAll": "6px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💡 โอนเสร็จส่งสลิปในแชทรับเครดิตทันทีครับ",
          "size": "xxs",
          "color": "#666666",
          "align": "center"
        }
      ],
      "paddingAll": "6px"
    }
  };
}

export function constructBankRegistrationFlex() {
  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "📋 ยืนยันบัญชี",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs"
        }
      ],
      "backgroundColor": "#00796B",
      "paddingAll": "6px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "contents": [
        {
          "type": "text",
          "text": "📸 ส่งรูปสมุดบัญชี/สกรีนช็อตแอปที่เห็นชื่อ-เลขบัญชีตรงกับที่โอนฝากเข้ามาครับ",
          "size": "xxs",
          "color": "#333333",
          "wrap": true
        }
      ],
      "paddingAll": "6px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": "#00796B",
          "action": {
            "type": "uri",
            "label": "📞 ติดต่อ 089-104-1992",
            "uri": "tel:0891041992"
          }
        }
      ],
      "paddingAll": "6px"
    }
  };
}

export function constructWithdrawalFlex(bankName, accountNumber, accountName, balance) {
  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💸 ถอนเงินคืน",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs"
        }
      ],
      "backgroundColor": "#455A64",
      "paddingAll": "6px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "contents": [
        { "type": "text", "text": bankName + " " + accountNumber, "size": "xxs", "weight": "bold", "color": "#333333" },
        { "type": "text", "text": "👤 " + accountName, "size": "xxs", "color": "#555555" },
        { "type": "text", "text": "💰 เครดิต: " + balance.toFixed(2) + "pt", "size": "xs", "weight": "bold", "color": "#2E7D32" }
      ],
      "paddingAll": "6px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
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
                "label": "ถอน 500",
                "text": "ถอน 500"
              }
            }
          ]
        }
      ],
      "paddingAll": "6px"
    }
  };
}

export function constructBetOpenFlex(orderNo, amount, side, creatorName, rangeInfo, isChotoy) {
  const sideShort = side === 'low' ? 'ล' : 'ถ';
  const headerTitle = `${creatorName || 'ผู้เล่น'} ${rangeInfo ? rangeInfo + ' ' : ''}${sideShort}${amount}`;
  const formulaTitle = `${rangeInfo ? rangeInfo + ' ' : ''}${sideShort} = ${amount}`;
  const chotaiLabel = isChotoy ? "ชตย (เผื่อช่างไม่ต่อย)" : "แผลดวลสด";

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#1E1B4B",
      "paddingAll": "8px",
      "contents": [
        {
          "type": "text",
          "text": headerTitle,
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
      "paddingAll": "10px",
      "contents": [
        {
          "type": "text",
          "text": formulaTitle,
          "weight": "bold",
          "color": "#111111",
          "size": "md",
          "align": "center"
        },
        {
          "type": "text",
          "text": chotaiLabel,
          "weight": "bold",
          "color": isChotoy ? "#E65100" : "#00796B",
          "size": "xs",
          "align": "center"
        },
        {
          "type": "separator",
          "margin": "xs"
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
              "color": "#1E88E5",
              "action": {
                "type": "message",
                "label": "ต 100",
                "text": `ต${orderNo} 100`
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#1E88E5",
              "action": {
                "type": "message",
                "label": "ต 200",
                "text": `ต${orderNo} 200`
              }
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "xs",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#1E88E5",
              "action": {
                "type": "message",
                "label": "ต 300",
                "text": `ต${orderNo} 300`
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#1E88E5",
              "action": {
                "type": "message",
                "label": "ต 400",
                "text": `ต${orderNo} 400`
              }
            }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "spacing": "xs",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "color": "#00796B",
              "action": {
                "type": "message",
                "label": "ต ทั้งหมด",
                "text": `ต ${orderNo}`
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "color": "#D32F2F",
              "action": {
                "type": "message",
                "label": "ยกเลิก",
                "text": `ยกเลิก ${orderNo}`
              }
            }
          ]
        }
      ]
    }
  };
}

export function constructMatchNotificationFlex(orderNo, amount, playerLowName, playerHighName, rangeInfo, isChotoy, rocketName) {
  const lowText = playerLowName || "ผู้เล่น";
  const highText = playerHighName || "คู่ดวล";
  const formattedAmt = Number(amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateStr = new Date().toLocaleDateString("en-GB", { day: '2-digit', month: 'short', year: '2-digit' }) + " " + new Date().toLocaleTimeString("th-TH", { hour: '2-digit', minute: '2-digit' });

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#4CAF50",
      "paddingAll": "10px",
      "contents": [
        {
          "type": "text",
          "text": "✓ จับคู่สำเร็จ",
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
      "paddingAll": "14px",
      "contents": [
        {
          "type": "text",
          "text": `Order #${orderNo}`,
          "color": "#999999",
          "size": "xs",
          "align": "center"
        },
        {
          "type": "text",
          "text": formattedAmt,
          "weight": "bold",
          "color": "#111111",
          "size": "3xl",
          "align": "center",
          "margin": "xs"
        },
        {
          "type": "text",
          "text": dateStr,
          "color": "#AAAAAA",
          "size": "xxs",
          "align": "center",
          "margin": "xs"
        },
        {
          "type": "separator",
          "margin": "md",
          "color": "#F0F0F0"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "md",
          "contents": [
            { "type": "text", "text": lowText, "weight": "bold", "color": "#333333", "size": "xs", "flex": 5 },
            { "type": "text", "text": "ทายต่ำ (Low)", "weight": "bold", "color": "#1E88E5", "size": "xs", "flex": 5, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": highText, "weight": "bold", "color": "#333333", "size": "xs", "flex": 5 },
            { "type": "text", "text": "ทายสูง (High)", "weight": "bold", "color": "#E53935", "size": "xs", "flex": 5, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "ทีม", "color": "#999999", "size": "xs", "flex": 4 },
            { "type": "text", "text": rocketName || "ช่างบั้งไฟสด", "weight": "bold", "color": "#333333", "size": "xs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "สถานะ", "color": "#999999", "size": "xs", "flex": 4 },
            { "type": "text", "text": "✓ ยืนยันแล้ว", "weight": "bold", "color": "#4CAF50", "size": "xs", "flex": 6, "align": "end" }
          ]
        }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "paddingAll": "10px",
      "contents": [
        {
          "type": "button",
          "style": "secondary",
          "height": "sm",
          "color": "#E53935",
          "action": {
            "type": "message",
            "label": "แตะเพื่อยกเลิก",
            "text": `ยกเลิก ${orderNo}`
          }
        }
      ]
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
  const amountText = (isIncome ? "+" : "-") + formattedAmount + " บาท";

  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "💳 " + badgeText + ": " + amountText,
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs"
        }
      ],
      "backgroundColor": headerBgColor,
      "paddingAll": "6px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "contents": [
        { "type": "text", "text": accountDetails, "size": "xxs", "color": "#333333", "wrap": true },
        { "type": "text", "text": "🕒 " + dateStr, "size": "xxs", "color": "#888888" }
      ],
      "paddingAll": "6px"
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
      "paddingAll": "6px"
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

  const isWithdrawal = (type === "WD" || type === "withdraw" || type === "ถอนเงิน");
  const title = isWithdrawal ? "ปฏิเสธถอนเงิน" : "ปฏิเสธฝากเงิน";

  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "❌ " + title + " (" + formattedAmount + "B)",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "xs"
        }
      ],
      "backgroundColor": "#D32F2F",
      "paddingAll": "6px"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "xs",
      "contents": [
        { "type": "text", "text": "เหตุผล: " + (reason || "ข้อมูลไม่ถูกต้อง"), "size": "xxs", "color": "#D32F2F", "wrap": true }
      ],
      "paddingAll": "6px"
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "height": "sm",
          "color": "#D32F2F",
          "action": {
            "type": "uri",
            "label": "📞 ติดต่อ 089-104-1992",
            "uri": "tel:0891041992"
          }
        }
      ],
      "paddingAll": "6px"
    }
  };
}

export function constructMatchResultFlex(isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission, userId, rocketName, rangeInfo) {
  const isWin = !!isWinner;
  const headerBg = isWin ? "#2E7D32" : "#D32F2F";
  const headerTitle = isWin ? `🏆 ชนะ (${finalTime}s)` : `☄️ แพ้ (${finalTime}s)`;
  const formattedAmt = isWin 
    ? `+${Number(payout || (amount * 1.9)).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `-${Number(amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const amtColor = isWin ? "#2E7D32" : "#D32F2F";
  const dateStr = new Date().toLocaleDateString("en-GB", { day: '2-digit', month: 'short', year: '2-digit' }) + " " + new Date().toLocaleTimeString("th-TH", { hour: '2-digit', minute: '2-digit' });

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": headerBg,
      "paddingAll": "10px",
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
      "paddingAll": "14px",
      "contents": [
        {
          "type": "text",
          "text": `Order #${orderNo}`,
          "color": "#999999",
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
          "color": "#AAAAAA",
          "size": "xxs",
          "align": "center",
          "margin": "xs"
        },
        {
          "type": "separator",
          "margin": "md",
          "color": "#F0F0F0"
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "md",
          "contents": [
            { "type": "text", "text": "ทีม", "color": "#999999", "size": "xs", "flex": 4 },
            { "type": "text", "text": rocketName || "ช่างบั้งไฟสด", "weight": "bold", "color": "#333333", "size": "xs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "ราคาช่าง", "color": "#999999", "size": "xs", "flex": 4 },
            { "type": "text", "text": rangeInfo ? `${rangeInfo}s` : "รอราคาช่าง", "weight": "bold", "color": "#333333", "size": "xs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "คงเหลือ", "color": "#999999", "size": "xs", "flex": 4 },
            { "type": "text", "text": `${Number(currentBalance || 0).toLocaleString('th-TH')} pt`, "weight": "bold", "color": "#2E7D32", "size": "xs", "flex": 6, "align": "end" }
          ]
        }
      ]
    }
  };
}

export function constructRoundCloseFlex(rocketName, timeStr) {
  const rocketTitle = rocketName || "ช่างบั้งไฟสด";
  const time = timeStr || new Date().toLocaleTimeString("th-TH", { hour: '2-digit', minute: '2-digit' });

  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#D32F2F",
      "paddingAll": "10px",
      "contents": [
        {
          "type": "text",
          "text": "❌ ปิดรับดวลรอบนี้ ❌",
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
      "paddingAll": "14px",
      "contents": [
        {
          "type": "text",
          "text": `ทีม: ${rocketTitle}`,
          "weight": "bold",
          "color": "#111111",
          "size": "sm",
          "align": "center"
        },
        {
          "type": "text",
          "text": "3-2-GO! 🚀",
          "weight": "bold",
          "color": "#D32F2F",
          "size": "md",
          "align": "center",
          "margin": "xs"
        },
        {
          "type": "text",
          "text": "⛔️ หลังปิด ไม่ติดทุกกรณี ⛔️",
          "color": "#999999",
          "size": "xs",
          "align": "center",
          "margin": "xs"
        },
        {
          "type": "text",
          "text": time,
          "color": "#CCCCCC",
          "size": "xxs",
          "align": "center",
          "margin": "xs"
        }
      ]
    }
  };
}

// Push match result to line helper
export async function sendMatchResultPush(userId, isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission, rocketName, rangeInfo) {
  const flex = constructMatchResultFlex(isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission, userId, rocketName, rangeInfo);
  await pushToLine(userId, flex);
}
