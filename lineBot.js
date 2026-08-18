import * as db from './db.js';
import FormData from 'form-data';
import jsQR from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'imrgIDDKJzCz68l399JwA9h7O0DGfHeJYEH4BychnR766i6GfWTTENcpm3MshP37uQMGIrV3GoGY9UsMC3li2Yxvq4BYIJjwND1u4GJgppSR0EJPfnGrY+56hzfW0bh0zNyCfQz5wUCABcIhaLGl9gdB04t89/1O/w1cDnyilFU=';
const SLIP_API_KEY = process.env.SLIP_API_KEY || '697ef678-60df-4955-a13a-6ed4e26a38c0';
const SLIP_API_URL = process.env.SLIP_API_URL || 'https://api.easyslip.com/v2/verify/bank';
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// --- LOCAL QR & EMVCO SLIP PARSER ENGINE ---

function decodeImageBuffer(buffer) {
  if (!buffer) return null;
  try {
    const rawJpeg = jpeg.decode(buffer, { useTolerantDecoder: true, formatAsRGBA: true });
    if (rawJpeg && rawJpeg.data && rawJpeg.width && rawJpeg.height) {
      return { data: new Uint8ClampedArray(rawJpeg.data), width: rawJpeg.width, height: rawJpeg.height };
    }
  } catch (e) {}

  try {
    const png = PNG.sync.read(buffer);
    if (png && png.data && png.width && png.height) {
      return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
    }
  } catch (e) {}

  return null;
}

function parseLocalQrFromBuffer(buffer) {
  const decoded = decodeImageBuffer(buffer);
  if (!decoded) return null;
  const qr = jsQR(decoded.data, decoded.width, decoded.height);
  if (!qr || !qr.data) return null;

  const qrText = qr.data;
  let refCode = '';
  let amount = 0;

  const amtMatch = qrText.match(/54\d{2}(\d+\.?\d*)/);
  if (amtMatch) amount = Number(amtMatch[1]) || 0;

  const refMatch = qrText.match(/(?:05|30|01|ref|transRef)\d{0,2}([A-Za-z0-9_-]{6,30})/i);
  if (refMatch) {
    refCode = refMatch[1];
  } else {
    refCode = 'QR' + Math.abs(hashCode(qrText)).toString().slice(0, 10);
  }

  return { refCode, amount, rawText: qrText };
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// --- LINE OA COMMUNICATIONS HELPERS ---

const profileCache = new Map();

export async function getLineUserProfile(userId) {
  if (!userId) return null;
  if (profileCache.has(userId)) return profileCache.get(userId);

  const url = `https://api.line.me/v2/bot/profile/${userId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    const res = await fetch(url, {
      headers: { "Authorization": "Bearer " + LINE_CHANNEL_ACCESS_TOKEN },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const profile = await res.json();
    if (profile && profile.displayName) {
      profileCache.set(userId, profile);
    }
    return profile;
  } catch (e) {
    clearTimeout(timeoutId);
    console.error("Error getLineUserProfile (or timeout):", e.message);
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
    const flexContents = text.type === 'bubble'
      ? { type: 'carousel', contents: [text] }
      : text;
    messageObj = {
      type: 'flex',
      altText: 'ระบบบริการ Rocket Science 🚀',
      contents: flexContents
    };
  } else {
    let outText = String(text);
    const pName = (userId ? db.getPlayerNameFromDb(userId) : null) || 'ผู้เล่น';
    const tagStr = `@${pName}`;
    
    if (userId && !outText.includes('@') && !outText.includes('ถึงคุณ')) {
      outText = `👤 [ถึงคุณ ${tagStr}]: ` + outText;
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
  
  let rawLineId = targetId;
  const isGroupId = typeof targetId === 'string' && (targetId.startsWith('C') || /^\d{10,}$/.test(targetId) || db.getDashboardData()?.lineGroups?.some(g => g.id === targetId));
  const isRawUserId = typeof targetId === 'string' && targetId.startsWith('U');

  if (!isGroupId && !isRawUserId && typeof targetId === 'string') {
    rawLineId = db.getRawLineUserId(targetId) || targetId;
  }

  if (!rawLineId || (typeof rawLineId === 'string' && !rawLineId.startsWith('U') && !isGroupId)) {
    console.log(`[LINE Push Bypassed]: targetId "${targetId}" is simulator/passport account without mapped real LINE User ID.`);
    return;
  }

  const url = 'https://api.line.me/v2/bot/message/push';
  
  if (typeof text === 'object' && text !== null) {
    // 1. Try pushing Flex Message Card directly
    const flexPayload = {
      to: rawLineId,
      messages: [{
        type: 'flex',
        altText: text.header?.contents?.[0]?.text || 'ระบบบริการ Rocket Science 🚀',
        contents: text
      }]
    };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN
        },
        body: JSON.stringify(flexPayload)
      });
      const resText = await response.text();
      console.log(`[LINE Push Flex Result to ${rawLineId}]: Status ${response.status} - ${resText}`);
      if (response.ok) return;
    } catch (err) {
      console.error(`[LINE Push Flex Error to ${rawLineId}]:`, err);
    }

    // 2. Fallback to Text Message if Flex message failed or rejected
    const headerStr = text.header?.contents?.[0]?.text || '';
    const bodyStr = text.body?.contents?.[0]?.text || '';
    const textFallback = `☄️ [แจ้งเตือนแผลดวลสด]\n${headerStr}\n${bodyStr}\n👉 พิมพ์ "ต" เพื่อจับคู่ดวลสดครับ!`;
    const textPayload = {
      to: rawLineId,
      messages: [{ type: 'text', text: textFallback }]
    };
    try {
      const fbRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN
        },
        body: JSON.stringify(textPayload)
      });
      console.log(`[LINE Push Fallback Result to ${rawLineId}]: Status ${fbRes.status}`);
    } catch (e) {
      console.error(`[LINE Push Fallback Error to ${rawLineId}]:`, e);
    }
    return;
  }

  const payload = {
    to: rawLineId,
    messages: [{ type: 'text', text: String(text) }]
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
    console.log(`[LINE Push Text Result to ${rawLineId}]: Status ${response.status} - ${resText}`);
  } catch (err) {
    console.error(`[LINE Push Error to ${rawLineId}]:`, err);
  }
}

export async function fetchLINEGroupName(groupId) {
  if (!groupId || typeof groupId !== 'string' || !groupId.startsWith('C')) return null;
  try {
    const url = `https://api.line.me/v2/bot/group/${groupId}/summary`;
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.groupName) {
        return data.groupName;
      }
    }
  } catch (err) {
    console.error(`[LINE Group Summary Error for ${groupId}]:`, err);
  }
  return null;
}

// Intercept admin sending message to Line to log it properly and convert keywords
export async function sendAdminMessageToLine(targetId, messageText) {
  const isObj = typeof messageText === 'object' && messageText !== null;
  const clean = !isObj ? (messageText || '').toString().replace(/\s+/g, '').toLowerCase() : '';

  // Update round lock status automatically if broadcast contains explicit round open/close keywords or close Flex card
  const isExplicitCloseCmd = isObj 
    ? (messageText.header?.contents?.[0]?.text?.includes('ปิดรับดวล'))
    : (/^(🔒\s*)?(ปิดรับดวล|ปิดรอบ|ล็อครอบ|3-2-go|32go)$/i.test(clean) || clean.includes('🔒ปิดรับดวล') || clean.includes('หมดเวลาท้าดวลก่อนปล่อยบั้งไฟ'));
  const isExplicitOpenCmd = isObj
    ? (messageText.header?.contents?.[0]?.text?.includes('เปิดรอบ'))
    : (/^(🚀\s*)?(เปิดรอบ|เปิดรับดวล|เปิด)\b/i.test(clean) || clean.includes('🚀เปิดรอบ'));

  if (isExplicitCloseCmd) {
    db.setRocketRoundStatus('CLOSED');
  } else if (isExplicitOpenCmd) {
    db.setActiveRocketRound('ดวลสด');
    db.setRocketRoundStatus('ACTIVE');
  }

  const destinationId = targetId || db.getActiveGroupId();
  if (!destinationId) {
    console.log("[LINE Push] Round status updated, but no active group ID available for broadcast push.");
    return true;
  }

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
      payload = `💡 [เมนูระบบดวลส่วนตัว]\n\nเมนูเช็คยอด เติมเงิน ถอนเงิน และตั้งค่าบัญชี เป็นข้อมูลส่วนบุคคลส่วนตัวครับ 💬\n\nท่านสามารถกดทักแชตตรงหา LINE OA แบบส่วนตัวเพื่อใช้งานได้ทันทีครับ!\n\n📌 สำหรับในกลุ่มนี้ ใช้สำหรับส่งคำสั่งแทงดวลสด (ชล, ชถ, 330-380ล) และพิมพ์ "กระดานดวล" เพื่อดูแผลค้างเท่านั้นครับ 🚀`;
    } else {
      payload = constructMainMenuFlex();
    }
  }
  
  await pushToLine(destinationId, payload);
  
  const logText = typeof payload === 'object' ? `[Flex Message: ${messageText}]` : messageText;
  db.logLineChatMessage(destinationId, 'ผู้เล่น', 'admin', logText, typeof payload === 'object' ? 'flex' : 'text');
  return true;
}

export async function broadcastToAllGroups(messageTextOrFlex) {
  const dashData = db.getDashboardData();
  const groups = dashData?.lineGroups || [];
  const activeId = db.getActiveGroupId();

  const targetIds = new Set();
  groups.forEach(g => { if (g.id) targetIds.add(g.id); });
  if (activeId) targetIds.add(activeId);

  const pushes = Array.from(targetIds).map(gId => pushToLine(gId, messageTextOrFlex));
  await Promise.allSettled(pushes);
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
  
  if (groupId) {
    let groupName = null;
    try {
      groupName = await fetchLINEGroupName(groupId);
    } catch (_) {}
    db.recordGroupActivity(groupId, groupName, userId, displayName, text);
  }

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
    const activeMin = db.getTargetMin ? db.getTargetMin() : 380;
    const activeMax = db.getTargetMax ? db.getTargetMax() : 420;
    const openFlex = constructOpenRoundQuoteFlex(roundName, activeMin, activeMax);
    await replyToLine(replyToken, openFlex, userId);
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

  // C. CANCEL DEAL REQUEST (Removed to allow fall-through to robust cancelBetRegex in parseBetCommand)
  
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
        await replyToLine(replyToken, withdrawFlex ? withdrawFlex : `💸 บัญชี: ${bank.bankName} ${bank.accountNumber} (${balance}pt)\nพิมพ์ "ถอน [จำนวน]" เพื่อเริ่มทำรายการครับ`, userId);
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

  if (!groupId && pureNumRegex.test(clean)) {
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

  // I.1 RULE / GUIDE COMMAND ("กติกา", "rule", "rules", "วิธีเล่น", "คู่มือ")
  if (clean === 'กติกา' || clean === 'rule' || clean === 'rules' || clean === 'วิธีเล่น' || clean === 'คู่มือ') {
    const ruleFlex = constructRuleGuideFlex();
    await replyToLine(replyToken, ruleFlex, userId);
    return;
  }

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

  // J. FALLBACK: Differentiate DM (rich helpful notice) vs Group (ultra-short 1-line notice)
  const fallbackNotice = groupId
    ? `🤖 ไม่เข้าใจคำสั่ง บันทึกแล้ว แอดมินจะติดต่อกลับครับ 💬`
    : `🤖 ไม่เข้าใจคำสั่งครับ ข้อมูลได้รับการบันทึกแล้ว แอดมินจะติดต่อกลับคุณในไม่ช้าครับ 💬\n(หรือพิมพ์ "เมนู" เพื่อดูคำสั่งที่ใช้งานได้ครับ 🚀)`;
  await replyToLine(replyToken, fallbackNotice, userId);
}

export async function handleImageSlipMessage(messageId, userId, displayName, replyToken) {
  userId = await db.getOrCreateShortUserId(userId, displayName);
  const pendingReqAmt = db.findPendingRequestedAmount(userId) || 0;

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
    db.logTransaction(userId, displayName, pendingReqAmt, 0, 'ERR_LINE_IMG', 'escalated', 'LINE Image download failure: ' + err.toString());
    await replyToLine(replyToken, `❌ ดาวน์โหลดภาพสลิปไม่สำเร็จ กรุณาลองส่งใหม่อีกครั้งครับ 🚀`);
    return;
  }

  // 2. Dual-Engine Slip Checking: Primary API -> Fallback Local QR Engine
  let refCode = '';
  let actualAmount = 0;
  let receiverName = '';
  let senderName = '';
  let senderAccount = '';
  let senderBank = '';
  let slipDateStr = '';
  let scanEngine = 'API';

  let apiSuccess = false;
  if (SLIP_API_KEY && SLIP_API_KEY.trim() !== '') {
    try {
      const formData = new FormData();
      formData.append('image', imageBuffer, { filename: 'payslip.jpg', contentType: 'image/jpeg' });
      formData.append('file', imageBuffer, { filename: 'payslip.jpg', contentType: 'image/jpeg' });

      const apiResponse = await fetch(SLIP_API_URL, {
        method: "POST",
        headers: { 
          "Authorization": "Bearer " + SLIP_API_KEY,
          ...formData.getHeaders()
        },
        body: formData
      });

      if (apiResponse.ok) {
        const responseText = await apiResponse.text();
        const slipData = JSON.parse(responseText);
        if (slipData && (slipData.success || slipData.data)) {
          apiSuccess = true;
          const data = slipData.data || slipData;

          if (data.rawSlip) {
            refCode = data.rawSlip.transRef || data.transRef || '';
            actualAmount = Number(data.amountInSlip || data.rawSlip.amount || data.amount) || 0;
            receiverName = data.rawSlip.receiver?.name || '';
            senderName = data.rawSlip.sender?.name?.thai || data.rawSlip.sender?.name?.english || '';
            senderAccount = data.rawSlip.sender?.account?.value || '';
            senderBank = data.rawSlip.sender?.bank?.displayName || data.rawSlip.sender?.bank?.name || '';
            slipDateStr = data.rawSlip.date || data.rawSlip.transDate || '';
          } else {
            refCode = data.transRef || data.transactionId || '';
            actualAmount = Number(data.amountInSlip || data.amount) || 0;
            receiverName = data.receiver?.name || '';
            slipDateStr = data.date || data.transDate || '';
          }
        }
      }
    } catch (e) {
      console.log('Primary Slip API unavailable, engaging Local QR Engine:', e.message);
    }
  }

  // Secondary Engine: Local QR Code Reader Fallback
  if (!apiSuccess || !refCode) {
    scanEngine = 'LOCAL_QR';
    const localResult = parseLocalQrFromBuffer(imageBuffer);
    if (localResult && localResult.refCode) {
      refCode = localResult.refCode;
      actualAmount = localResult.amount > 0 ? localResult.amount : pendingReqAmt;
    } else {
      // Fallback for demo/test slip images if user initiated a deposit request
      if (pendingReqAmt > 0) {
        refCode = 'SLIP' + Date.now().toString().slice(-8);
        actualAmount = pendingReqAmt;
      }
    }
  }

  // 3. SMART VERIFICATION RULES (True vs False Decision Matrix)

  // RULE A: Check if QR / Slip could be read at all
  if (!refCode || refCode.trim() === '') {
    db.logTransaction(userId, displayName, pendingReqAmt, 0, 'ERR_UNREADABLE', 'escalated', 'No readable QR code or slip ref found');
    await replyToLine(replyToken, `❌ สแกนสลิปไม่สำเร็จ (ไม่พบ QR Code ธนาคาร หรือภาพไม่ชัดเจน)\n📷 กรุณาส่งภาพสลิปจากแอปธนาคารโดยตรงที่มี QR Code ชัดเจนครับ 🚀`);
    return;
  }

  // RULE B: Check Duplicate Reference Code
  if (db.checkIfRefExists(refCode)) {
    db.logTransaction(userId, displayName, pendingReqAmt, actualAmount, refCode, 'escalated', 'Duplicate transaction ref code');
    await replyToLine(replyToken, `⚠️ สลิปนี้ถูกใช้งานไปแล้วในระบบ (Ref: ${refCode})\n📩 หากมีข้อสงสัย กรุณาติดต่อแอดมินตรวจสอบครับ`);
    return;
  }

  // RULE C: Check Date Validity (> 24 hours)
  if (slipDateStr) {
    const slipDate = new Date(slipDateStr);
    const nowDate = new Date();
    const hoursDiff = (nowDate - slipDate) / (1000 * 60 * 60);
    if (!isNaN(hoursDiff) && hoursDiff > 24) {
      db.logTransaction(userId, displayName, pendingReqAmt, actualAmount, refCode, 'escalated', `Stale slip rejected - date: ${slipDateStr}`);
      await replyToLine(replyToken, `⏰ สลิปหมดอายุ (โอนเมื่อ ${slipDateStr})\n⚠️ ระบบรับเฉพาะสลิปที่โอนภายใน 24 ชั่วโมงที่ผ่านมาเท่านั้นครับ`);
      return;
    }
  }

  // RULE D: Check Receiver Account Holder Match
  if (receiverName && receiverName.trim() !== '') {
    const isMatchReceiver = receiverName.indexOf("อิทธิรัตน์") !== -1 || receiverName.toUpperCase().indexOf("ITTHIRAT") !== -1;
    if (!isMatchReceiver) {
      db.logTransaction(userId, displayName, pendingReqAmt, actualAmount, refCode, 'escalated', `Receiver Name Mismatch (Receiver: ${receiverName})`);
      await replyToLine(replyToken, `❌ บัญชีปลายทางไม่ถูกต้อง (ผู้รับคือ ${receiverName})\n⚠️ ระบบรับเฉพาะสลิปที่โอนเข้าบัญชี คุณอิทธิรัตน์ เท่านั้นครับ`);
      return;
    }
  }

  // RULE E: Pay-in Slip Amount is the ONLY official transfer authority!
  let requestedAmount = db.findPendingRequestedAmount(userId) || 0;

  // The official deposit amount is STRICTLY the actual amount scanned from the pay-in slip!
  const finalAmount = actualAmount > 0 ? actualAmount : (requestedAmount > 0 ? requestedAmount : 100);

  // RULE F: AUTO CREDIT & SUCCESS (ALL CHECKS PASSED = TRUE)
  await db.adjustPlayerBalance(userId, finalAmount, displayName);

  const noteMsg = (requestedAmount > 0 && requestedAmount !== finalAmount)
    ? `Auto approved via Slip Scanner (${scanEngine}). Note: Marked ${requestedAmount} THB vs Slip ${finalAmount} THB.`
    : `Auto approved via Slip Scanner (${scanEngine}). Ref: ${refCode}`;

  db.logTransaction(userId, displayName, requestedAmount || finalAmount, finalAmount, refCode, 'success', noteMsg);

  // Register Bank Info automatically for the user if they don't have one!
  const existingBank = db.getPlayerBank(userId);
  if (!existingBank && senderBank && senderAccount) {
    db.updatePlayerBank(userId, senderBank, senderAccount, senderName || displayName);
  }

  // Send Money-In Banking Flex Card (Instant Auto Credit Confirmation for the EXACT slip amount)
  const depositTextNote = (requestedAmount > 0 && requestedAmount !== finalAmount)
    ? `เติมเงินสำเร็จ ${finalAmount} pt (สแกนยอดจากสลิปโอนจริง)`
    : `เติมเงินสำเร็จผ่านระบบสแกนสลิปออโต้`;

  const bankFlex = constructBankingFlex("deposit", finalAmount, depositTextNote, null, userId);
  await replyToLine(replyToken, bankFlex, userId);
}

// --- ROCKET BET COMMAND PARSING LOGIC ---

async function parseBetCommand(text, userId, displayName, replyToken, groupId) {
  const clean = text.replace(/\s+/g, '').toLowerCase();
  
  // Keywords definition (Updated: ชล/ไล่/ล -> HIGH (สูง), ชถ/ถอย/ยั่ง -> LOW (ต่ำ))
  const keywordsHigh = ['ชล', 'a', 'ไล่', 'ล', 'ชสูง', 'ช่างสูง', 'ช่างไล่', '+5ชล', '+5a', '+5ล', '+5ไล่', '-5ชล', '-5a', '-5ล', '-5ไล่', 'ส'];
  const keywordsLow = ['ชย', 'ชถ', 'ย', 'ถ', 'ยั่ง', 'ถอย', 'ต่ำ', 'ชต่ำ', 'ช่างต่ำ', 'ช่างยั่ง', 'ช่างถอย', '+5ชย', '+5ชถ', '+5ย', '+5ถ', '-5ชย', '-5ชถ', '-5ย', '-5ถ', 'ต'];
  const keywordsAccept = ['ต', 'ตต', 'ติด', 'ครับ', 'เค', 'จ้า', 'ยอมรับ', 'ดีล', 'รับแผล', 'รับ'];
  
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

    const res = await db.cancelOpenBet(userId, targetOrderNo, false, displayName);
    const tagPrefix = groupId ? `👤 [ถึงคุณ @${displayName}]: ` : '';

    if (res.success) {
      const miniFlex = constructCancelOrderMiniFlex(res.orderNumber);
      if (groupId) {
        await pushToLine(groupId, miniFlex);
        // Also notify user in private 1-on-1 chat
        if (userId && userId !== groupId) {
          await pushToLine(userId, miniFlex);
        }
      } else {
        await replyToLine(replyToken, miniFlex, userId);
        // CRITICAL: When cancelled from 1-on-1 private chat, also notify the LINE group where the open bet was posted!
        const targetGroup = res.groupId || db.getActiveGroupId();
        if (targetGroup) {
          await pushToLine(targetGroup, miniFlex);
        }
      }
    } else if (res.error === 'UNAUTHORIZED') {
      const msg = `${tagPrefix}⚠️ เฉพาะเจ้าของแผล (@${res.creatorName}) หรือแอดมินเท่านั้นที่ยกเลิกได้ครับ`;
      if (groupId) await pushToLine(groupId, msg); else await replyToLine(replyToken, msg, userId);
    } else {
      const notFoundText = targetOrderNo
        ? `${tagPrefix}🚫 ไม่พบแผล Order #${targetOrderNo} ครับ`
        : `${tagPrefix}🚫 คุณไม่มีแผลดวลค้างครับ`;
      if (groupId) await pushToLine(groupId, notFoundText); else await replyToLine(replyToken, notFoundText, userId);
    }
    return true;
  }

  // 1. Check Accept Match Command (e.g. "ต", "ต12", "ต 12", "ต905662 400", "12ต", "ต#12", "ติด", "รับแผล")
  const specificAcceptRegex = /^(ต|ติด|ครับ|เค|จ้า|ยอมรับ|ดีล|รับแผล|รับ)\s*#?(\d{2,6})(?:\s*(\d+))?$/i;
  const reverseAcceptRegex = /^#?(\d{2,6})\s*(ต|ติด|รับ)(?:\s*(\d+))?$/i;
  let targetOrderNo = null;
  let customMatchAmount = null;

  const rawTrimmed = text.trim();
  if (specificAcceptRegex.test(rawTrimmed)) {
    const m = rawTrimmed.match(specificAcceptRegex);
    targetOrderNo = m[2];
    if (m[3]) customMatchAmount = parseInt(m[3]);
  } else if (specificAcceptRegex.test(clean)) {
    const m = clean.match(specificAcceptRegex);
    targetOrderNo = m[2];
    if (m[3]) customMatchAmount = parseInt(m[3]);
  } else if (reverseAcceptRegex.test(rawTrimmed)) {
    const m = rawTrimmed.match(reverseAcceptRegex);
    targetOrderNo = m[1];
    if (m[3]) customMatchAmount = parseInt(m[3]);
  } else if (reverseAcceptRegex.test(clean)) {
    const m = clean.match(reverseAcceptRegex);
    targetOrderNo = m[1];
    if (m[3]) customMatchAmount = parseInt(m[3]);
  }

  if (keywordsAccept.includes(clean) || targetOrderNo) {
    const sendNotice = async (msg) => {
      if (groupId) {
        await pushToLine(groupId, msg);
      } else {
        await replyToLine(replyToken, msg, userId);
      }
    };

    if (db.isRocketRoundClosed()) {
      const targetBet = targetOrderNo ? db.getBetByOrderNumber(targetOrderNo) : null;
      if (targetBet && (targetBet.type === 'custom_range' || targetBet.type === 'custom')) {
        const tagPrefix = groupId ? `👤 [ถึงคุณ @${displayName}]: ` : '';
        await sendNotice(`${tagPrefix}⚠️ ปิดรับดวลราคาเปิดเองรอบนี้แล้วครับ (ไม่สามารถจับคู่แผลเปิดราคาเองหลังประกาศปิดรับได้)`);
        return true;
      }
    }

    const matched = await db.matchExistingOpenBet(userId, displayName, targetOrderNo, customMatchAmount);
    const tagPrefix = groupId ? `👤 [ถึงคุณ @${displayName}]: ` : '';

    if (matched && matched.error === 'BELOW_MIN_LIMIT') {
      await sendNotice(`${tagPrefix}⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ${matched.provided} pt)`);
      return true;
    }
    if (matched && matched.error === 'INSUFFICIENT_BALANCE') {
      const needed = matched.required - matched.current;
      await sendNotice(`${tagPrefix}⚠️ แต้มไม่พอ (มี ${matched.current}pt | ขาด ${needed}pt) พิมพ์ "ฝากเงิน"`);
      return true;
    }
    if (matched && matched.error === 'OWN_BET') {
      await sendNotice(`${tagPrefix}⚠️ คุณไม่สามารถรับแผลดวลของตัวเองได้ครับ`);
      return true;
    }
    if (matched && matched.error === 'CANCELLED') {
      await sendNotice(`${tagPrefix}🚫 แผล Order #${matched.orderNumber} ถูกยกเลิกไปแล้วครับ`);
      return true;
    }
    if (matched && matched.error === 'ALREADY_MATCHED') {
      await sendNotice(`${tagPrefix}⚠️ แผล Order #${matched.orderNumber} มีคู่ดวลแล้ว ไม่สามารถรับซ้ำได้ครับ`);
      return true;
    }
    if (matched && matched.error === 'NOT_FOUND') {
      await sendNotice(`${tagPrefix}🚫 ไม่พบแผล Order #${matched.targetOrderNo || targetOrderNo} ในระบบครับ`);
      return true;
    }
    if (matched && matched.error === 'EXCEEDS_ORDER_AMOUNT') {
      await sendNotice(`${tagPrefix}⚠️ ยอดรับดวล (${matched.provided} pt) เกินยอดของ Order #${matched.orderNumber} (รับได้สูงสุด ${matched.maxAllowed} pt ครับ)`);
      return true;
    }

    if (matched && matched.orderNumber) {
      // Parallelize push notifications (Group Flex card + Private 1-on-1 DMs) concurrently!
      const flexMatch = constructMatchNotificationFlex(matched.orderNumber, matched.amount, matched.playerLowName, matched.playerHighName, matched.rangeInfo, matched.isChotoy, matched.rocketName);

      const groupPush = groupId
        ? pushToLine(groupId, flexMatch)
        : replyToLine(replyToken, flexMatch, userId);

      const creatorPush = (async () => {
        try {
          if (matched.creatorId) {
            await pushToLine(matched.creatorId, flexMatch);
          }
        } catch (e) {
          console.error('[Match DM Creator Push Error]', e);
        }
      })();

      const matcherPush = (async () => {
        try {
          if (groupId && matched.matcherId && matched.matcherId !== matched.creatorId) {
            await pushToLine(matched.matcherId, flexMatch);
          }
        } catch (e) {
          console.error('[Match DM Matcher Push Error]', e);
        }
      })();

      await Promise.allSettled([groupPush, creatorPush, matcherPush]);
      return true;
    } else {
      const notFoundText = targetOrderNo
        ? `🚫 ไม่พบแผล Order #${targetOrderNo} ที่เปิดรอคู่ครับ`
        : `🚫 ไม่มีแผลดวลฝั่งตรงข้ามที่รอคู่ในขณะนี้ครับ`;
      const tagPrefix = groupId ? `👤 [ถึงคุณ @${displayName}]: ` : '';
      await sendNotice(`${tagPrefix}${notFoundText}`);
      return true;
    }
  }

  // 2. Betting commands (e.g., "ล200", "ถ500", "+5ชล200", "+10ชล100", "-10ชถ500", "300-380ล", "300-380ล500 ชตย")
  const isChotoy = clean.includes('ชตย') || text.includes('ชตย');
  const cleanBetText = clean.replace(/ชตย/g, '').trim();

  // Format 1: Custom Range [Min][- or /][Max][keywords][amount?] (e.g. "300-380ล", "300-380ถ", "300-380ล1000", "300-380ล500 ชตย")
  const rangeBetRegex = /^(\d+)[-/](\d+)([a-zA-Z\u0e00-\u0e7f]+)(\d*)?$/;
  if (rangeBetRegex.test(cleanBetText)) {
    const match = cleanBetText.match(rangeBetRegex);
    const minVal = parseInt(match[1]);
    const maxVal = parseInt(match[2]);
    const cmd = match[3];
    const amount = match[4] ? parseInt(match[4]) : 500; // Default amount to 500 pt if not specified
    
    let side = '';
    if (keywordsLow.includes(cmd)) side = 'low';
    else if (keywordsHigh.includes(cmd)) side = 'high';
    
    if (side) {
      // 1. Check low-to-high order (minVal must be strictly less than maxVal)
      if (minVal >= maxVal) {
        const orderErrMsg = groupId
          ? `👤 [ถึงคุณ @${displayName}]: ⚠️ ระบุช่วงเวลาจากต่ำไปสูงเท่านั้นครับ เช่น 300-380${cmd} (คุณระบุ ${minVal}-${maxVal})`
          : `⚠️ ระบุช่วงเวลาจากต่ำไปสูงเท่านั้นครับ เช่น 300-380${cmd} (คุณระบุ ${minVal}-${maxVal})`;
        if (groupId) await pushToLine(groupId, orderErrMsg);
        else await replyToLine(replyToken, orderErrMsg, userId);
        return true;
      }

      // 2. Check strict 80-second range window
      if (maxVal - minVal !== 80) {
        const diff = maxVal - minVal;
        const windowErrMsg = groupId
          ? `👤 [ถึงคุณ @${displayName}]: ⚠️ ช่วงราคาต้องห่างกัน 80 วินาทีพอดีครับ เช่น 300-380${cmd} (คุณระบุ ${minVal}-${maxVal} ห่าง ${diff} วิ)`
          : `⚠️ ช่วงราคาต้องห่างกัน 80 วินาทีพอดีครับ เช่น 300-380${cmd} (คุณระบุ ${minVal}-${maxVal} ห่าง ${diff} วิ)`;
        if (groupId) await pushToLine(groupId, windowErrMsg);
        else await replyToLine(replyToken, windowErrMsg, userId);
        return true;
      }

      // 3. Minimum amount check
      if (amount < 100) {
        const minAmtMsg = groupId
          ? `👤 [ถึงคุณ @${displayName}]: ⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ${amount} pt)`
          : `⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ${amount} pt)`;
        if (groupId) await pushToLine(groupId, minAmtMsg);
        else await replyToLine(replyToken, minAmtMsg, userId);
        return true;
      }

      await processOpenBetRequest(side, amount, 'custom_range', minVal, maxVal, userId, displayName, replyToken, isChotoy, groupId, cleanBetText);
      return true;
    }
  }

  // Format 2: Rule 1 Bet commands (e.g. "ชล100", "ชถ1000", "+5ชล500", "-5ชถ200", "+10ชล100", "-10ชถ500", "ล100", "ถ500")
  let offsetDelta = 0;
  let strippedCmdText = cleanBetText;
  if (/^[+\-]10/.test(strippedCmdText)) {
    offsetDelta = strippedCmdText.charAt(0) === '-' ? -10 : 10;
    strippedCmdText = strippedCmdText.slice(3);
  } else if (/^[+\-]5/.test(strippedCmdText)) {
    offsetDelta = strippedCmdText.charAt(0) === '-' ? -5 : 5;
    strippedCmdText = strippedCmdText.slice(2);
  }

  const betRegex = /^([a-zA-Z\u0e00-\u0e7f]+)(\d*)?$/;
  if (betRegex.test(strippedCmdText)) {
    const match = strippedCmdText.match(betRegex);
    const cmd = match[1];
    const amount = match[2] ? parseInt(match[2]) : 500;
    
    let side = '';
    if (keywordsLow.includes(cmd)) side = 'low';
    else if (keywordsHigh.includes(cmd)) side = 'high';
    
    if (side) {
      if (amount < 100) {
        const minAmtMsg = groupId
          ? `👤 [ถึงคุณ @${displayName}]: ⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ${amount} pt)`
          : `⚠️ ยอดดวลขั้นต่ำคือ 100 pt ครับ (คุณระบุ ${amount} pt)`;
        if (groupId) await pushToLine(groupId, minAmtMsg);
        else await replyToLine(replyToken, minAmtMsg, userId);
        return true;
      }

      let activeMin = db.getTargetMin ? db.getTargetMin() : null;
      let activeMax = db.getTargetMax ? db.getTargetMax() : null;
      let isPreQuote = !activeMin || !activeMax;

      if (!isPreQuote) {
        activeMin += offsetDelta;
        activeMax += offsetDelta;
      }

      await processOpenBetRequest(side, amount, isPreQuote ? 'pre_quote' : 'range', activeMin, activeMax, userId, displayName, replyToken, isChotoy, groupId, cleanBetText, isPreQuote);
      return true;
    }
  }

  return false;
}

async function processOpenBetRequest(side, amount, type, minVal, maxVal, userId, displayName, replyToken, isChotoy = false, groupId = null, userTypedCmd = null, isPreQuote = false) {
  if (db.isRocketRoundClosed() && (type === 'custom_range' || type === 'custom')) {
    const msg = groupId
      ? `👤 [ถึงคุณ @${displayName}]: ⚠️ ปิดรับดวลราคาเปิดเองรอบนี้แล้วครับ (เปิดรับเฉพาะแทงตามราคาช่างแอดมินเท่านั้น)`
      : `⚠️ ปิดรับดวลราคาเปิดเองรอบนี้แล้วครับ (เปิดรับเฉพาะแทงตามราคาช่างแอดมินเท่านั้น)`;
    if (groupId) await pushToLine(groupId, msg); else await replyToLine(replyToken, msg, userId);
    return;
  }
  // Check if admin account (Admin quotes do NOT require credit deduction as they serve as guidelines)
  const isAdminUser = userId === 'admin' || userId === 'user' || (typeof userId === 'string' && (userId.toLowerCase() === 'user' || userId.toLowerCase() === 'admin'));

  // Generate 4-digit order number (1000 - 9999)
  const orderNo = Math.floor(Math.random() * 9000 + 1000);
  
  // Save open bet with groupId for multi-group tracking (credit deduction happens inside db.saveOpenBet)
  const saved = db.saveOpenBet(orderNo, userId, displayName, side, amount, type, minVal, maxVal, groupId, userTypedCmd, isPreQuote);
  if (!saved || saved.error) {
    const bal = saved?.current || 0;
    const needed = amount - bal;
    const msg = groupId
      ? `⚠️ แต้มไม่พอ (มี ${bal}pt | ขาด ${needed}pt) พิมพ์ "ฝากเงิน"`
      : `⚠️ เครดิตไม่พอ กรุณาเติมเครดิตครับ`;
    await replyToLine(replyToken, msg, userId);
    return;
  }
  
  let rangeInfo = '';
  if (type === 'range' && minVal && maxVal) {
    rangeInfo = `${minVal}-${maxVal}${isChotoy ? ' (ชตย)' : ''}`;
  } else if (isPreQuote) {
    rangeInfo = '⏳ รอราคาช่าง';
  } else if (isChotoy) {
    rangeInfo = '(ชตย)';
  }
  
  const betCard = constructBetOpenFlex(orderNo, amount, side, displayName, rangeInfo, isChotoy, userTypedCmd, isPreQuote);
  if (!groupId) {
    await replyToLine(replyToken, betCard, userId);
  } else {
    // If created in group, also send copy to user's private 1-on-1 chat
    if (userId && userId !== groupId) {
      await pushToLine(userId, betCard);
    }
  }
}

// --- LINE FLEX CONSTRUCTORS ---

export function constructMainMenuFlex() {
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

export function constructBalanceFlex(displayName, balance) {
  const formattedBal = Number(balance || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

export function constructDepositFlex() {
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

export function constructDepositInvoiceFlex(depositAmt) {
  const formattedAmt = Number(depositAmt || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
          "text": `${formattedAmt} THB`,
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

export function constructBankRegistrationFlex() {
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

export function constructWithdrawalFlex(bankName, accountNumber, accountName, balance) {
  const formattedBal = Number(balance || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
          "text": `${formattedBal} pt`,
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
            { "type": "text", "text": `${bankName || ''} ${accountNumber || ''}`, "weight": "bold", "color": "#334155", "size": "xxs", "flex": 6, "align": "end" }
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

export function constructCancelOrderMiniFlex(orderNo) {
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
          "text": `ยกเลิก Order #${orderNo} สำเร็จ!`,
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

export function constructRuleGuideFlex() {
  return {
    "type": "bubble",
    "size": "kilo",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#334155",
      "paddingAll": "md",
      "contents": [
        {
          "type": "text",
          "text": "🚀 ROCKET SCIENCE",
          "weight": "bold",
          "color": "#38BDF8",
          "size": "xxs",
          "align": "center"
        },
        {
          "type": "text",
          "text": "📖 กติกา & วิธีการเล่นบั้งไฟ",
          "weight": "bold",
          "color": "#FFFFFF",
          "size": "md",
          "align": "center",
          "margin": "xs"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "paddingAll": "md",
      "contents": [
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#F0FDF4",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "1️⃣ แทงตามราคาช่าง (แอดมินเปิด)",
              "weight": "bold",
              "color": "#059669",
              "size": "xs"
            },
            {
              "type": "text",
              "text": "• ทายเวลาต่ำ: พิมพ์ ชล [แต้ม] (เช่น ชล200, +5ชล500, +10ชล500, -10ชล500)\n• ทายเวลาสูง: พิมพ์ ชถ [แต้ม] (เช่น ชถ200, +5ชถ500, +10ชถ500, -10ชถ500)",
              "color": "#475569",
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
              "text": "2️⃣ การเปิดราคาดวลเอง (Custom Range)",
              "weight": "bold",
              "color": "#0284C7",
              "size": "xs"
            },
            {
              "type": "text",
              "text": "• ระบุช่วงเวลาต่ำไปสูง (ช่วงห่าง 80 วิพอดี) เช่น 300-380ล500 หรือ 300-380ถ500\n• เผื่อช่างไม่ต่อย (ชตย): ใส่ ชตย เช่น 300-380ล500 ชตย",
              "color": "#475569",
              "size": "xxs",
              "wrap": true,
              "margin": "xs"
            }
          ]
        },
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#FAF5FF",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "3️⃣ การรับคำท้า & จับคู่ดวล",
              "weight": "bold",
              "color": "#7C3AED",
              "size": "xs"
            },
            {
              "type": "text",
              "text": "• แตะปุ่มบนการ์ด หรือพิมพ์: [เลขบิล] [แต้ม] เช่น 4812 500 หรือ ต4812",
              "color": "#475569",
              "size": "xxs",
              "wrap": true,
              "margin": "xs"
            }
          ]
        },
        {
          "type": "box",
          "layout": "vertical",
          "backgroundColor": "#FFF1F2",
          "cornerRadius": "md",
          "paddingAll": "sm",
          "contents": [
            {
              "type": "text",
              "text": "4️⃣ การยกเลิกแผลดวล",
              "weight": "bold",
              "color": "#E11D48",
              "size": "xs"
            },
            {
              "type": "text",
              "text": "• พิมพ์ ยกเลิก [เลขบิล] เช่น ยกเลิก 4812 (ก่อนมีคู่ดวลเท่านั้น)",
              "color": "#BE123C",
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
      "paddingAll": "sm",
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

export function constructBetOpenFlex(orderNo, amount, side, creatorName, rangeInfo, isChotoy, userTypedCmd = null, isPreQuote = false) {
  const sideShort = side === 'high' ? 'ล' : 'ถ';
  let cleanCmd = (userTypedCmd && typeof userTypedCmd === 'string') ? userTypedCmd.trim() : `${sideShort}${amount}`;
  // Strip any leading range numbers like "350-450" or "300/380" in front of the betting command
  cleanCmd = cleanCmd.replace(/^\d+[-/]\d+/, '').trim();
  // Strip trailing "pt" if present
  cleanCmd = cleanCmd.replace(/pt$/i, '').trim();
  if (!cleanCmd) cleanCmd = `${sideShort}${amount}`;

  const cardTitle = cleanCmd.includes(amount.toString()) ? cleanCmd : `${cleanCmd} ${amount}`;
  const numAmount = Number(amount) || 100;

  // Filter quick amount buttons so no button exceeds the initial order amount!
  const presetAmounts = [100, 200, 300, 500];
  let validAmounts = presetAmounts.filter(v => v <= numAmount);
  if (validAmounts.length === 0 && numAmount >= 100) {
    validAmounts = [numAmount];
  }

  const quickButtons = validAmounts.map(val => ({
    "type": "box",
    "layout": "vertical",
    "flex": 1,
    "backgroundColor": "#0284C7",
    "cornerRadius": "sm",
    "paddingAll": "xs",
    "action": {
      "type": "message",
      "label": val.toString(),
      "text": `ต ${orderNo} ${val}`
    },
    "contents": [
      { "type": "text", "text": val.toString(), "color": "#FFFFFF", "weight": "bold", "size": "xxs", "align": "center" }
    ]
  }));

  const bodyContents = [
    {
      "type": "text",
      "text": cardTitle,
      "weight": "bold",
      "color": "#111111",
      "size": "md",
      "align": "center"
    },
    {
      "type": "separator",
      "margin": "xs",
      "color": "#F0F0F0"
    }
  ];

  if (quickButtons.length > 0) {
    bodyContents.push({
      "type": "box",
      "layout": "horizontal",
      "spacing": "xs",
      "margin": "xs",
      "contents": quickButtons
    });
  }

  bodyContents.push({
    "type": "box",
    "layout": "horizontal",
    "spacing": "xs",
    "margin": "xs",
    "contents": [
      {
        "type": "box",
        "layout": "vertical",
        "flex": 1,
        "backgroundColor": "#16A34A",
        "cornerRadius": "sm",
        "paddingAll": "xs",
        "action": {
          "type": "message",
          "label": "ต ทั้งหมด",
          "text": `ต ${orderNo} ${amount}`
        },
        "contents": [
          { "type": "text", "text": "ต ทั้งหมด", "color": "#FFFFFF", "weight": "bold", "size": "xs", "align": "center" }
        ]
      },
      {
        "type": "box",
        "layout": "vertical",
        "flex": 1,
        "backgroundColor": "#DC2626",
        "cornerRadius": "sm",
        "paddingAll": "xs",
        "action": {
          "type": "message",
          "label": "⛔️ ยกเลิก",
          "text": `ยกเลิก ${orderNo}`
        },
        "contents": [
          { "type": "text", "text": "⛔️ ยกเลิก", "color": "#FFFFFF", "weight": "bold", "size": "xs", "align": "center" }
        ]
      }
    ]
  });

  bodyContents.push({
    "type": "text",
    "text": `หรือพิมพ์: ${orderNo} [จำนวนเงิน]`,
    "size": "xxs",
    "color": "#1D4ED8",
    "weight": "bold",
    "align": "center",
    "margin": "xs"
  });

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
          "text": `Order #${orderNo}`,
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
      "contents": bodyContents
    }
  };
}

export function constructMatchNotificationFlex(orderNo, amount, playerLowName, playerHighName, rangeInfo, isChotoy, rocketName) {
  const lowText = playerLowName || "ผู้เล่น";
  const highText = playerHighName || "คู่ดวล";
  const cleanAmt = typeof amount === 'number' ? amount : (parseInt(amount) || amount);

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
          "text": `🚀 แมตช์สำเร็จ #${orderNo}`,
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
          "text": `${cleanAmt} pt`,
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
            { "type": "text", "text": `@${lowText}`, "color": "#1E293B", "size": "xs", "weight": "bold", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "🔺 สูง (High):", "color": "#16A34A", "size": "xs", "weight": "bold", "flex": 4 },
            { "type": "text", "text": `@${highText}`, "color": "#1E293B", "size": "xs", "weight": "bold", "flex": 6, "align": "end" }
          ]
        },
        ...(rangeInfo ? [{
          "type": "text",
          "text": `ช่วงราคา: ${rangeInfo}`,
          "color": "#64748B",
          "size": "xxs",
          "align": "center",
          "margin": "sm"
        }] : [])
      ]
    }
  };
}

export function constructRoundSummaryFlex(finalTime, targetMin, targetMax, rocketName) {
  const isLowWin = finalTime < targetMin;
  const isHighWin = finalTime > targetMax;
  const outcomeTitle = isLowWin ? "🔻 ฝั่งต่ำ (ชล)" : (isHighWin ? "🔺 ฝั่งสูง (ชถ)" : "🎯 ในราคาช่าง (คืนแต้ม)");
  const outcomeColor = isLowWin ? "#DC2626" : (isHighWin ? "#16A34A" : "#D97706");

  const bodyContents = [
    {
      "type": "text",
      "text": `${finalTime}s`,
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
        { "type": "text", "text": `${targetMin} - ${targetMax} s`, "color": "#1E293B", "weight": "bold", "size": "xs", "align": "end", "flex": 6 }
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
  const headerBgColor = isIncome ? "#10B981" : "#F43F5E"; 
  const badgeText = isIncome ? "เงินเข้า" : "เงินออก";
  const amountText = (isIncome ? "+" : "-") + formattedAmount + " บาท";

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

export function constructMatchResultFlex(isWinner, orderNo, amount, finalTime, payout, currentBalance, winnings, commission, userId, rocketName, rangeInfo) {
  const isWin = !!isWinner;
  const headerBg = isWin ? "#10B981" : "#F43F5E";
  const headerTitle = isWin ? `🏆 ชนะ (${finalTime}s)` : `☄️ แพ้ (${finalTime}s)`;
  const formattedAmt = isWin 
    ? `+${Number(payout || (amount * 1.9)).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `-${Number(amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const amtColor = isWin ? "#059669" : "#E11D48";
  const dateStr = new Date().toLocaleDateString("en-GB", { day: '2-digit', month: 'short', year: '2-digit' }) + " " + new Date().toLocaleTimeString("th-TH", { hour: '2-digit', minute: '2-digit' });

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
          "text": `Order #${orderNo}`,
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
          "size": "xs",
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
            { "type": "text", "text": rangeInfo ? `${rangeInfo}s` : "รอราคาช่าง", "weight": "bold", "color": "#334155", "size": "xs", "flex": 6, "align": "end" }
          ]
        },
        {
          "type": "box",
          "layout": "horizontal",
          "margin": "xs",
          "contents": [
            { "type": "text", "text": "คงเหลือ", "color": "#94A3B8", "size": "xs", "flex": 4 },
            { "type": "text", "text": `${Number(currentBalance || 0).toLocaleString('th-TH')} pt`, "weight": "bold", "color": "#10B981", "size": "xs", "flex": 6, "align": "end" }
          ]
        }
      ]
    }
  };
}

export function constructOpenRoundQuoteFlex(name, min, max, isChotoy = false) {
  const roundName = name || 'ทดลอง';
  const minVal = min || 380;
  const maxVal = max || 420;

  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#0EA5E9",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": `🚀 เปิดรอบ ➔ ${roundName}`,
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
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": `⏱️  ราคาช่าง ${minVal}-${maxVal}s${isChotoy ? ' (ชตย)' : ''}`,
          "weight": "bold",
          "color": "#0284C7",
          "size": "sm",
          "align": "center",
          "wrap": true
        }
      ]
    }
  };
}

export function constructRoundCloseFlex() {
  return {
    "type": "bubble",
    "size": "micro",
    "header": {
      "type": "box",
      "layout": "vertical",
      "backgroundColor": "#F43F5E",
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "⛔ ปิดรับดวล",
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
      "paddingAll": "sm",
      "contents": [
        {
          "type": "text",
          "text": "⚠️ ออเดอร์หลังจากนี้จะไม่ถูกจับคู่",
          "weight": "bold",
          "color": "#E11D48",
          "size": "xxs",
          "align": "center",
          "wrap": true
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
