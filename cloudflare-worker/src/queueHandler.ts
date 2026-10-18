import { Env, LineEvent, Order, PlayerProfile, RocketRound, Transaction } from './types.js';
import { state } from './state.js';
import { scanSlipImage } from './slipScanner.js';
import { getPaymentBank } from './paymentBank.js';
import {
  generateOrderFlex,
  generateMatchNotificationFlex,
  generateMatchMismatchFlex,
  generateBalanceFlex,
  generatePendingBoardFlex,
  generateRuleGuideFlex,
  generateMainMenuQuickReply,
  generateMainMenuFlex,
  attachMainMenuQuickReply,
  stripQuickReply,
  MAIN_MENU_QUICK_REPLY_ITEMS,
  generateDepositFlex,
  generateTypedAmountHintFlex,
  generateDepositInvoiceFlex,
  generateWithdrawalFlex,
  generateBankRegistrationFlex,
  generateNoticeFlex,
  generateOrderCancelFlex,
  generateInsufficientBalanceFlex,
  generateWithdrawalSuccessFlex,
  generateSlipReceivedFlex,
  generateSlipCreditedFlex,
} from './flexTemplates.js';

export const RULE_GUIDE_TEXT = `📖 [กติกาการเล่น]

📌 กฏที่ 1: เล่นราคาช่าง

🎉 ทายว่าชนะ (สูง):
• ช่างไล่ / ชล / ไล่ / ลง
• +5ชล / +5ล / +5ไล่
• -5ชล / -5ล / -5ไล่
💵 พิมพ์คีย์เวิร์ดตามด้วยจำนวนเงิน (ตัวเลขเท่านั้น)
เช่น ชล100 , ชล1000 , ชล10000

👊 ทายว่าแพ้ (ต่ำ):
• ช่างยั่ง / ช่างถอย / ชย
• ชถ / ยั่ง / ย / ถอย / ถ
• +5ชย / +5ชถ / +5ย / +5ถ
• -5ชย / -5ชถ / -5ย / -5ถ
เช่น ชถ100 , ชถ1000

-----------------------------

📌 กฏที่ 2: การเปิดราคาเอง (กรณีช่างไม่ต่อย / ต้องมีเครดิตพอ)

💰 การเปิดราคาเอง (เปิดแผลสดใหม่):
⚠️ ช่วงราคาต้องห่างกัน 50 วิพอดี เช่น
• 300-350ล500 | 300-350ถ500
• 350-400ล500 | 350-400ถ500

⬆️ ช่างต่อยยกเลิก (ชตย) 
ใส่ ชตย หลังจำนวนเงิน เช่น
• 300-350ล500 ชตย
• 350-400ถ500 ชตย`;

/**
 * Verify whether a LINE user has administrative privileges for chat commands
 */
async function isSenderLineAdmin(userId: string | undefined, env: Env): Promise<boolean> {
  if (!userId) return false;
  const envAdmins = (env.ADMIN_LINE_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envAdmins.includes(userId)) return true;
  try {
    const cachedAdminsStr = await state(env).get('ADMIN_LINE_USER_IDS');
    if (cachedAdminsStr) {
      const cachedAdmins = cachedAdminsStr.split(',').map(s => s.trim()).filter(Boolean);
      if (cachedAdmins.includes(userId)) return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Cloudflare Worker Queue & Background Event Processor
 * Executes all order validation, atomic balance locking, and LINE API calls with sub-second latency.
 */
export async function processLineEvent(event: LineEvent, env: Env, ctx?: ExecutionContext): Promise<void> {
  const source = event.source || {};
  const userId = source.userId;
  const groupId = source.groupId || source.roomId || null;
  const isGroup = !!groupId;

  // ── Universal Inbound Chat Log (admin conversation monitor feed) ──
  // Previously inbound user messages were never recorded anywhere — only
  // admin-sent messages were — leaving the dashboard chat feed blind.
  if (event.type === 'message' && userId) {
    const msgType = event.message?.type || 'unknown';
    const displayText =
      msgType === 'text'
        ? (event.message?.text || '').trim()
        : msgType === 'image'
          ? '[รูปภาพ — สลิปโอนเงิน]'
          : `[${msgType}]`;
    const evtTime = new Date(event.timestamp || Date.now()).toLocaleTimeString('th-TH', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const logTask = async () => {
      let displayName = 'ผู้เล่น';
      try {
        const cached = await state(env).get(`USER_${userId}`);
        if (cached) displayName = JSON.parse(cached).displayName || displayName;
      } catch (_) {}
      await logUserMessage(env, {
        timestamp: evtTime,
        userId,
        displayName,
        sender: 'user',
        text: displayText || '[empty]',
        type: msgType,
      });
    };
    if (ctx) {
      ctx.waitUntil(logTask());
    } else {
      logTask().catch(() => {});
    }
  }

  // Offload group activity recording to background (0ms on critical path)
  if (groupId && ctx) {
    ctx.waitUntil(recordActiveGroup(groupId, env));
  } else if (groupId) {
    recordActiveGroup(groupId, env).catch(() => {});
  }

  if (event.type === 'message' && event.message?.type === 'text') {
    const text = (event.message.text || '').trim();
    const replyToken = event.replyToken;

    // ── 0. Utility Command: !groupid ──
    if (text.toLowerCase() === '!groupid' && replyToken) {
      if (groupId) {
        const gidFlex = generateNoticeFlex('🆔 LINE Group ID', groupId, 'info');
        await replyToLine(replyToken, gidFlex, env, false);
      } else {
        const warnFlex = generateNoticeFlex('⚠️ แจ้งเตือน', 'คำสั่งนี้ใช้งานได้เฉพาะในกลุ่ม LINE เท่านั้นครับ', 'warning');
        await replyToLine(replyToken, warnFlex, env, true);
      }
      return;
    }

    if (!userId) return;

    // Resolve Player Profile with KV caching
    const profile = await getOrCreatePlayerProfile(userId, env, ctx);

    // ── 1. Balance Inspection ("เช็คยอด", "คงเหลือ", "balance", "สอบถามยอด", "ยอด", "ยอดเงิน", "ดูยอด", "กระเป๋า") ──
    const clean = text.replace(/\s+/g, '').toLowerCase();
    const balanceKeywords = ['เช็คยอด', 'คงเหลือ', 'balance', 'สอบถามยอด', 'ยอด', 'ยอดเงิน', 'ดูยอด', 'กระเป๋า', 'กระเป๋าเงิน'];
    if (balanceKeywords.includes(clean)) {
      const balanceFlex = generateBalanceFlex(profile.displayName, profile.balance);
      await deliverPrivateNotice(userId, replyToken, groupId, balanceFlex, env, profile.displayName, ctx);
      return;
    }

    // ── 1.1 Main Menu ("เมนู", "เมนูหลัก", "menu", "เริ่ม", "start", "ช่วยเหลือ", "help") ──
    const menuKeywords = ['เมนู', 'เมนูหลัก', 'menu', 'เริ่ม', 'start', 'ช่วยเหลือ', 'help'];
    if (menuKeywords.includes(clean)) {
      const menuPayload = generateMainMenuFlex(profile.displayName, profile.balance);
      await deliverPrivateNotice(userId, replyToken, groupId, menuPayload, env, profile.displayName, ctx);
      return;
    }

    // ── 1.2 Deposit Intent ("ฝากเงิน", "เติมเงิน", "deposit", "เติมเครดิต", "ฝาก") ──
    //
    // No amount is requested. The player transfers whatever they want and sends
    // the slip; the scanner reads the amount off it. Asking for a number first
    // only created a second source of truth that could disagree with the slip.
    const depositKeywords = ['ฝากเงิน', 'เติมเงิน', 'deposit', 'เติมเครดิต', 'ฝาก'];
    if (depositKeywords.includes(clean)) {
      const bank = await getPaymentBank(env);
      const depositFlex = generateDepositFlex(bank);
      await deliverPrivateNotice(userId, replyToken, groupId, depositFlex, env, profile.displayName, ctx);
      return;
    }

    // ── 1.3 Typed Amount ("1000", "ฝาก 1000") ──
    //
    // Kept only to answer the question gracefully. This used to open a deposit
    // transaction with a requested amount, which is what the slip scanner then
    // had to be reconciled against; now the amount is irrelevant, so the reply
    // just re-explains the procedure instead of silently creating a record the
    // player never asked for.
    const cleanWithoutCommas = clean.replace(/,/g, '');
    const pureNumRegex = /^(\d+)\s*(?:บาท|thb|pt)?$/i;
    const depositTextRegex = /^(?:ฝาก|ฝากเงิน|เติม|เติมเงิน)\s*(\d+)\s*(?:บาท|thb|pt)?$/i;
    const typedAmount =
      !isGroup && pureNumRegex.test(cleanWithoutCommas)
        ? parseInt(cleanWithoutCommas.match(pureNumRegex)![1], 10)
        : depositTextRegex.test(cleanWithoutCommas)
          ? parseInt(cleanWithoutCommas.match(depositTextRegex)![1], 10)
          : null;

    if (typedAmount !== null) {
      const bank = await getPaymentBank(env);
      // A purpose-built card rather than generateNoticeFlex. As a single text
      // node the numbered steps could not hang their wrapped lines under the
      // step text, so it rendered as a ragged blob on a phone.
      const hintFlex = generateTypedAmountHintFlex(bank);
      await deliverPrivateNotice(userId, replyToken, groupId, hintFlex, env, profile.displayName, ctx);
      return;
    }

    // ── 1.4 Bank Account Registration ("บัญชี [ธนาคาร] [เลขบัญชี] [ชื่อ-สกุล]") ──
    const bankRegRegex = /^(?:บัญชี|ลงทะเบียนบัญชี|bank)\s+(\S+)\s+(\d{8,15})\s+(.+)$/i;
    if (bankRegRegex.test(text)) {
      const match = text.match(bankRegRegex)!;
      profile.bankName = match[1];
      profile.accountNumber = match[2];
      profile.accountName = match[3].trim();
      await savePlayerProfile(profile, env, ctx);
      const bankSuccessFlex = generateNoticeFlex(
        '✅ บันทึกบัญชีธนาคารเรียบร้อย',
        `🏦 ธนาคาร: ${profile.bankName}\n🔢 เลขบัญชี: ${profile.accountNumber}\n👤 ชื่อ: ${profile.accountName}`,
        'success',
        '💡 ท่านสามารถพิมพ์ "ถอน [จำนวน]" เพื่อแจ้งถอนได้ทันทีครับ 💸'
      );
      await deliverPrivateNotice(userId, replyToken, groupId, bankSuccessFlex, env, profile.displayName, ctx);
      return;
    }

    // ── 1.5 Withdrawal Intent ("ถอน", "ถอนเงิน", "ถอนยอด", "withdraw") ──
    const withdrawKeywords = ['ถอน', 'ถอนเงิน', 'ถอนยอด', 'withdraw'];
    if (withdrawKeywords.includes(clean)) {
      if (profile.bankName && profile.accountNumber) {
        const withdrawFlex = generateWithdrawalFlex(
          profile.bankName,
          profile.accountNumber,
          profile.accountName || profile.displayName,
          profile.balance
        );
        await deliverPrivateNotice(userId, replyToken, groupId, withdrawFlex, env, profile.displayName, ctx);
      } else {
        const bankRegFlex = generateBankRegistrationFlex();
        await deliverPrivateNotice(userId, replyToken, groupId, bankRegFlex, env, profile.displayName, ctx);
      }
      return;
    }

    // ── 1.6 Withdrawal Execution ("ถอน 500", "ถอน 1,000", "ถอน 500 บาท") ──
    const withdrawAmtRegex = /^(?:ถอน|ถอนเงิน|ถอนยอด)\s*(\d+)\s*(?:บาท|thb|pt)?$/i;
    if (withdrawAmtRegex.test(cleanWithoutCommas)) {
      const match = cleanWithoutCommas.match(withdrawAmtRegex)!;
      const withdrawAmt = parseInt(match[1], 10);
      if (withdrawAmt < 100) {
        const minFlex = generateNoticeFlex('⚠️ ยอดถอนขั้นต่ำ', 'ยอดถอนขั้นต่ำคือ 100 pt ครับ\nกรุณาระบุจำนวนตั้งแต่ 100 pt ขึ้นไป', 'warning');
        await deliverPrivateNotice(userId, replyToken, groupId, minFlex, env, profile.displayName, ctx);
        return;
      }
      if (profile.balance < withdrawAmt) {
        const needed = withdrawAmt - profile.balance;
        const insufficientFlex = generateInsufficientBalanceFlex(profile.balance, needed);
        await deliverPrivateNotice(userId, replyToken, groupId, insufficientFlex, env, profile.displayName, ctx);
        return;
      }
      if (!profile.bankName || !profile.accountNumber) {
        // Nothing is deducted and no request is opened — the player is told
        // precisely what to send and that they then repeat the same command.
        const bankRegFlex = generateBankRegistrationFlex(withdrawAmt);
        await deliverPrivateNotice(userId, replyToken, groupId, bankRegFlex, env, profile.displayName, ctx);
        return;
      }

      profile.balance -= withdrawAmt;
      await savePlayerProfile(profile, env, ctx);

      const txId = `WD${Math.floor(100000 + Math.random() * 900000)}`;
      const nowStr = new Date().toLocaleTimeString('th-TH', { hour12: false });
      const newTx: Transaction = {
        id: txId,
        playerId: profile.shortId,
        lineUserId: profile.lineUserId,
        playerName: profile.displayName,
        requestedAmount: withdrawAmt,
        actualAmount: withdrawAmt,
        slipRef: '',
        status: 'escalated',
        reviewReason: `แจ้งถอนเข้า ${profile.bankName} ${profile.accountNumber} (${profile.accountName || profile.displayName})`,
        timestamp: nowStr,
        type: 'withdraw',
        createdAt: Date.now(),
      };
      await addTransaction(newTx, env, ctx);

      const withdrawSuccessFlex = generateWithdrawalSuccessFlex(
        withdrawAmt,
        profile.bankName,
        profile.accountNumber,
        profile.accountName || profile.displayName,
        profile.balance
      );
      await deliverPrivateNotice(userId, replyToken, groupId, withdrawSuccessFlex, env, profile.displayName, ctx);
      return;
    }

    // ── 1.1 Live Betting Board ("กระดานดวล", "แผลค้าง", "เปิดรอคู่", "รอคู่", "กระดาน", "board") ──
    const boardRegex = /^(?:📊\s*)?(กระดานดวล|แผลค้าง|เปิดรอคู่|รอคู่|กระดาน|board)$/i;
    if (boardRegex.test(clean) || boardRegex.test(text)) {
      const pendingList = await getPendingOrdersList(env);
      const openMatches = pendingList.filter((o) => o && o.status === 'pending_match');
      const boardFlex = generatePendingBoardFlex(openMatches);
      await deliverPrivateNotice(userId, replyToken, groupId, boardFlex, env, profile.displayName, ctx);
      return;
    }

    // ── 1.2 Rule Guide ("กติกา", "rule", "rules", "วิธีเล่น", "คู่มือ") ──
    const ruleRegex = /^(?:📖\s*)?(กติกา|rule|rules|วิธีเล่น|คู่มือ)$/i;
    if (ruleRegex.test(clean) || ruleRegex.test(text)) {
      const ruleFlex = generateRuleGuideFlex();
      await deliverPrivateNotice(userId, replyToken, groupId, ruleFlex, env, profile.displayName, ctx);
      return;
    }

    // ── 1.3 Admin/System Command: Clear Board & Cache ("ล้างกระดาน", "เคลียร์แผล", "ล้างแคช", "clearboard") ──
    const clearRegex = /^(?:🧹\s*)?(ล้างกระดาน|เคลียร์กระดาน|ล้างแผล|เคลียร์แผล|ล้างแคช|เคลียร์แคช|clearboard|resetboard|clearcache)$/i;
    if (clearRegex.test(clean) || clearRegex.test(text)) {
      if (!(await isSenderLineAdmin(userId, env))) {
        const unauthFlex = generateNoticeFlex('⚠️ สิทธิ์ไม่เพียงพอ', 'คำสั่งล้างกระดานสงวนสิทธิ์เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นครับ', 'warning');
        if (replyToken) await replyToLine(replyToken, unauthFlex, env, !isGroup);
        return;
      }
      const res = await clearAllPendingOrders(env);
      const clearFlex = generateNoticeFlex(
        '🧹 ล้างกระดานดวลเรียบร้อย',
        `ลบแผลรอคู่ทั้งหมด ${res.cleared} รายการ\nกระดานว่าง 0 แผล พร้อมเริ่มรอบใหม่ครับ 🚀`,
        'success'
      );
      if (replyToken) {
        await replyToLine(replyToken, clearFlex, env, !isGroup);
      } else {
        await pushToLine(userId, clearFlex, env);
      }
      return;
    }

    // ── 2. Cancel Order ("ยกเลิก [orderNo]" or "ยกเลิก") ──
    const cancelRegex = /^(ยกเลิก|cancel)(?:\s*#?(\d{2,6}))?$/i;
    if (cancelRegex.test(clean) || cancelRegex.test(text)) {
      const match = text.match(cancelRegex) || clean.match(cancelRegex);
      let targetNo = match ? match[2] : null;

      if (!targetNo) {
        // Auto-find caller's latest pending open bet
        const pendingList = await getPendingOrdersList(env);
        const myPending = pendingList.find((o) => o.creatorId === profile.shortId);
        if (myPending) {
          targetNo = myPending.orderNumber;
        } else {
          const noOrderFlex = generateNoticeFlex('⚠️ ไม่พบแผลที่ยกเลิกได้', 'ไม่พบแผลดวลค้างของคุณที่สามารถยกเลิกได้ครับ\n(หรือพิมพ์ "ยกเลิก [เลข Order]" เช่น "ยกเลิก 5189")', 'warning');
          await deliverPrivateNotice(userId, replyToken, groupId, noOrderFlex, env, profile.displayName, ctx);
          return;
        }
      }

      const cancelRes = await cancelOrder(targetNo, profile, env, ctx);
      if (cancelRes.success) {
        // Use the balance cancelOrder read back from the authoritative record,
        // not the profile snapshot this handler started with.
        const cancelFlex = generateOrderCancelFlex(targetNo, cancelRes.amount || 0, cancelRes.balance ?? profile.balance);
        await deliverPrivateNotice(userId, replyToken, groupId, cancelFlex, env, profile.displayName, ctx);
      } else {
        const cancelErrFlex = generateNoticeFlex('⛔ ไม่สามารถยกเลิกได้', cancelRes.message, 'warning');
        await deliverPrivateNotice(userId, replyToken, groupId, cancelErrFlex, env, profile.displayName, ctx);
      }
      return;
    }

    // ── 3. Accept/Match Bet Commands ──
    // Formats supported:
    // A) "ต 695066 500", "ต #695066 500", "695066 500" (Order Number + Amount)
    const orderAndAmountRegex = /^(?:(ต|ติด|รับ|เค|ดีล)\s*)?#?(\d{4,6})\s+(\d+)(?:\s*(?:pt|แต้ม))?$/i;
    // B) "ต #695066", "ต 695066", "#695066" (Explicit Order Number)
    const explicitOrderRegex = /^(?:(ต|ติด|รับ|เค|ดีล)\s*)#?(\d{4,6})$/i;
    const hashOnlyRegex = /^#(\d{4,6})$/i;
    // C) "ต 500", "ต500", "ติด 200" (Keyword + Amount for latest pending bet)
    const keywordAndAmountRegex = /^(?:(ต|ติด|รับ|เค|ดีล)\s*)(\d{1,5})(?:\s*(?:pt|แต้ม))?$/i;
    // D) Just "ต", "ติด", "รับ", "ดีล" (Match latest pending bet full amount)
    const pureKeywordRegex = /^(ต|ติด|รับ|เค|ดีล)$/i;

    if (
      orderAndAmountRegex.test(text) ||
      hashOnlyRegex.test(text) ||
      explicitOrderRegex.test(text) ||
      keywordAndAmountRegex.test(text) ||
      pureKeywordRegex.test(clean)
    ) {
      let targetOrderNo: string | undefined;
      let matchAmt: number | undefined;

      if (orderAndAmountRegex.test(text)) {
        const match = text.match(orderAndAmountRegex)!;
        targetOrderNo = match[2];
        matchAmt = parseInt(match[3], 10);
      } else if (hashOnlyRegex.test(text)) {
        const match = text.match(hashOnlyRegex)!;
        targetOrderNo = match[1];
        matchAmt = undefined;
      } else if (explicitOrderRegex.test(text)) {
        const match = text.match(explicitOrderRegex)!;
        const numStr = match[2];
        // 6 digits or explicitly formatted with # is an order number
        if (numStr.length >= 6 || text.includes('#')) {
          targetOrderNo = numStr;
          matchAmt = undefined;
        } else {
          // Check if exists as order
          const exists = await env.KV_ORDERS.get(`ORDER_${numStr}`);
          if (exists) {
            targetOrderNo = numStr;
            matchAmt = undefined;
          } else {
            // Treat as amount for latest open bet
            targetOrderNo = undefined;
            matchAmt = parseInt(numStr, 10);
          }
        }
      } else if (keywordAndAmountRegex.test(text)) {
        const match = text.match(keywordAndAmountRegex)!;
        targetOrderNo = undefined;
        matchAmt = parseInt(match[2], 10);
      } else if (pureKeywordRegex.test(clean)) {
        targetOrderNo = undefined;
        matchAmt = undefined;
      }

      await handleMatchOrder(targetOrderNo, matchAmt, profile, userId, groupId, replyToken, env, ctx);
      return;
    }

    // ── 4. Order Creation Formulas (e.g. "ล500", "ล 500", "ชล500", "+10ชล500", "300-350ล100") ──
    const betRegex = /^(?:([+-]?\d+)\s*)?(ชล|ชถ|ชย|ชต|ย|ถ|ล|สูง|ต่ำ|ยั่ง|ถอย|ไล่)\s*(\d+)?(?:\s*(?:pt|แต้ม))?$/i;
    const rangeBetRegex = /^(\d+)\s*[-/]\s*(\d+)\s*(ชล|ชถ|ชย|ชต|ย|ถ|ล|สูง|ต่ำ)\s*(\d+)?(?:\s*(?:pt|แต้ม))?$/i;

    // Thousands separators are stripped before matching. Players type "ชล1,000"
    // — it is how every other amount in this system is written, and the
    // deposit and withdrawal paths already accept it — but these two patterns
    // were tested against the raw text, so a comma made the whole message fall
    // through to "no match" with no explanation. Matching the normalised form
    // keeps one way of writing an amount across the whole OA.
    // `handleCreateOrder` re-derives its captures from the same normalised
    // string, so the comma can never survive into the parsed amount.
    const betText = text.replace(/,/g, '');

    if (betRegex.test(betText) || rangeBetRegex.test(betText)) {
      await handleCreateOrder(betText, betRegex, rangeBetRegex, profile, userId, groupId, replyToken, env, ctx);
      return;
    }

    // ── 5. Admin Commands (e.g. "เปิด [ชื่อ]", "ปิดรอบ") ──
    const openRoundRegex = /^(เปิด|เปิดรอบ|รอบ)\s*(.+)$/;
    if (openRoundRegex.test(text)) {
      if (!(await isSenderLineAdmin(userId, env))) {
        const unauthFlex = generateNoticeFlex('⚠️ สิทธิ์ไม่เพียงพอ', 'คำสั่งเปิดรอบสงวนสิทธิ์เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นครับ', 'warning');
        if (replyToken) await replyToLine(replyToken, unauthFlex, env, !isGroup);
        return;
      }
      const match = text.match(openRoundRegex);
      const roundName = match ? match[2].trim() : 'รอบดวลสด';
      await state(env).put('ACTIVE_ROUND', JSON.stringify({
        name: roundName,
        targetMin: 330,
        targetMax: 380,
        status: 'ACTIVE',
        isChotoy: false,
        quoteReleased: false,
        updatedAt: Date.now(),
      }));
      if (replyToken) {
        const openFlex = generateNoticeFlex(
          `🚀 เปิดรอบดวล: ${roundName}`,
          `ราคาช่าง 330-380 วินาที\nพร้อมเปิดรับคำสั่งดวลแล้วครับ 🚀`,
          'success'
        );
        await replyToLine(replyToken, openFlex, env, !isGroup);
      }
      return;
    }

    if (clean === 'ปิดรอบ' || clean === 'ปิดรับดวล' || clean === 'ล็อครอบ' || clean === '3-2-go' || clean === '32go') {
      if (!(await isSenderLineAdmin(userId, env))) {
        const unauthFlex = generateNoticeFlex('⚠️ สิทธิ์ไม่เพียงพอ', 'คำสั่งปิดรอบสงวนสิทธิ์เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นครับ', 'warning');
        if (replyToken) await replyToLine(replyToken, unauthFlex, env, !isGroup);
        return;
      }
      const roundStr = await state(env).get('ACTIVE_ROUND');
      let roundName = 'รอบดวลสด';
      if (roundStr) {
        const round = JSON.parse(roundStr) as RocketRound;
        round.status = 'CLOSED';
        roundName = round.name;
        await state(env).put('ACTIVE_ROUND', JSON.stringify(round));
      }
      // Also clear pending unmatched orders so board resets cleanly for next round
      await clearAllPendingOrders(env);
      const closeFlex = generateNoticeFlex(
        `⛔ ปิดรับดวลรอบ: ${roundName}`,
        `ล็อครอบเรียบร้อย (ล้างกระดานรอคู่ 0 แผล)\nรอลุ้นผลการแข่งขันครับ 💥`,
        'warning'
      );
      if (replyToken) {
        await replyToLine(replyToken, closeFlex, env, !isGroup);
      } else {
        await pushToLine(userId, closeFlex, env);
      }
      return;
    }

    // ── Fallback for Unrecognized Private Messages ──
    if (!isGroup) {
      const fallbackFlex = generateNoticeFlex(
        '🤖 ยินดีต้อนรับครับ',
        'ท่านสามารถแตะเลือกทำรายการจากเมนูด้านล่างได้ทันทีครับ 👇',
        'info',
        'เช็คยอด • ฝากเงิน • ถอนเงิน • กติกา • กระดานดวล'
      );
      await deliverPrivateNotice(userId, replyToken, null, fallbackFlex, env, profile.displayName, ctx);
      return;
    }
  }

  // ── Follow Event (User Adds or Unblocks Bot) ──
  if (event.type === 'follow' && userId) {
    const profile = await getOrCreatePlayerProfile(userId, env, ctx);
    const welcomeFlex = generateNoticeFlex(
      `🚀 ยินดีต้อนรับคุณ ${profile.displayName}`,
      'ยินดีต้อนรับสู่ระบบดวล Rocket Science!\n\nท่านสามารถแตะเมนูด้านล่างเพื่อ เช็คยอด, ฝากเงิน, ถอนเงิน หรือดูกติกาได้ตลอดเวลาครับ 👇',
      'info'
    );
    await deliverPrivateNotice(userId, event.replyToken, null, welcomeFlex, env, profile.displayName, ctx);
    return;
  }

  // ── Image Message Handler (Slip Upload → auto-credit) ──
  if (event.type === 'message' && event.message?.type === 'image' && userId) {
    await handleSlipUpload(event, userId, env, ctx);
    return;
  }

  // ── Postback Event (from Button Click in LINE) ──
  if (event.type === 'postback' && event.postback?.data && userId) {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    if (action === 'match_order') {
      const orderNo = params.get('order_id') || '';
      const amount = parseInt(params.get('amount') || '0', 10);
      const profile = await getOrCreatePlayerProfile(userId, env, ctx);
      await handleMatchOrder(orderNo, amount || undefined, profile, userId, groupId, event.replyToken, env, ctx);
    }
  }
}

// ── Internal Business Handlers ──

async function handleCreateOrder(
  text: string,
  betRegex: RegExp,
  rangeBetRegex: RegExp,
  profile: PlayerProfile,
  userId: string,
  groupId: string | null,
  replyToken: string | undefined,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  let side: 'low' | 'high' = 'low';
  let amount = 500;
  let rangeMin = 330;
  let rangeMax = 380;
  let isCustom = false;
  let offsetDelta = 0;

  // Resolve target group for broadcasting order cards
  const activeGroupId = await state(env).get('ACTIVE_GROUP_ID');
  const targetGroupId = groupId || activeGroupId || null;

  if (!targetGroupId) {
    const noGroupFlex = generateNoticeFlex(
      '⚠️ ไม่พบกลุ่ม LINE',
      'ยังไม่พบกลุ่ม LINE ที่เปิดใช้งาน กรุณาส่งคำสั่งนี้ในกลุ่มดวล LINE ครับ 🚀',
      'warning'
    );
    await deliverPrivateNotice(
      userId,
      replyToken,
      null,
      noGroupFlex,
      env,
      profile.displayName,
      ctx
    );
    return;
  }

  // 1. Parallel fetch of ACTIVE_ROUND & PENDING_ORDERS_LIST (1 roundtrip instead of 2+)
  const [roundStr, pendingList] = await Promise.all([
    state(env).get('ACTIVE_ROUND'),
    getPendingOrdersList(env),
  ]);
  let round = roundStr ? (JSON.parse(roundStr) as RocketRound) : null;

  // Auto-initialize or reactivate round if null, VOID, or RESOLVED (previous round ended)
  if (!round || round.status === 'VOID' || round.status === 'RESOLVED') {
    round = {
      name: round?.name || 'บั้งไฟสด',
      targetMin: round?.targetMin || 330,
      targetMax: round?.targetMax || 380,
      status: 'ACTIVE',
      isChotoy: false,
      quoteReleased: false,
      updatedAt: Date.now(),
    };
    if (ctx) {
      ctx.waitUntil(state(env).put('ACTIVE_ROUND', JSON.stringify(round)).catch(() => {}));
    } else {
      state(env).put('ACTIVE_ROUND', JSON.stringify(round)).catch(() => {});
    }
  }

  // Only reject order if round is actively CLOSED (in-flight countdown "3-2-go" / locked)
  if (round.status === 'CLOSED') {
    const closedFlex = generateNoticeFlex(
      '⛔ ปิดรับออเดอร์รอบนี้แล้ว',
      'ปิดรับออเดอร์รอบนี้แล้วครับ (ล็อครอบระหว่างการแข่งขัน)\nกรุณารอรอบถัดไปครับ 🙏',
      'warning'
    );
    await deliverPrivateNotice(userId, replyToken, groupId, closedFlex, env, profile.displayName, ctx);
    return;
  }

  if (rangeBetRegex.test(text)) {
    const match = text.match(rangeBetRegex)!;
    rangeMin = parseInt(match[1], 10);
    rangeMax = parseInt(match[2], 10);
    const cmd = match[3];
    side = ['ชล', 'ล', 'สูง', 'ไล่'].includes(cmd) ? 'high' : 'low';
    amount = match[4] ? parseInt(match[4], 10) : 500;
    isCustom = true;
  } else if (betRegex.test(text)) {
    const match = text.match(betRegex)!;
    const cmd = match[2];
    side = ['ชล', 'ล', 'สูง', 'ไล่'].includes(cmd) ? 'high' : 'low';
    amount = match[3] ? parseInt(match[3], 10) : 500;
    if (match && match[1]) {
      const rawOffset = match[1].replace('+', '').trim();
      offsetDelta = parseInt(rawOffset, 10) || 0;
      if (![5, -5, 10, -10].includes(offsetDelta)) {
        const offsetFlex = generateNoticeFlex(
          '⚠️ ปรับราคาช่างไม่ถูกต้อง',
          'การปรับราคาช่างรองรับเฉพาะ +/-5 และ +/-10 วินาทีเท่านั้นครับ\n(เช่น +5ชล, -5ชถ, +10ชล, -10ชถ)',
          'warning'
        );
        await deliverPrivateNotice(userId, replyToken, groupId, offsetFlex, env, profile.displayName, ctx);
        return;
      }
    }
  }

  if (amount < 50 || amount > 50000) {
    const limitFlex = generateNoticeFlex(
      '⚠️ ยอดดวลไม่อยู่ในเกณฑ์',
      `ยอดดวลต้องอยู่ระหว่าง 50 ถึง 50,000 pt ครับ\n(คุณระบุ ${amount.toLocaleString()} pt)`,
      'warning'
    );
    await deliverPrivateNotice(userId, replyToken, groupId, limitFlex, env, profile.displayName, ctx);
    return;
  }

  if (isCustom) {
    if (rangeMin >= rangeMax) {
      const rangeFlex = generateNoticeFlex(
        '⚠️ ระบุช่วงเวลาไม่ถูกต้อง',
        `ระบุช่วงเวลาจากต่ำไปสูงเท่านั้นครับ เช่น 300-350\n(คุณระบุ ${rangeMin}-${rangeMax})`,
        'warning'
      );
      await deliverPrivateNotice(userId, replyToken, groupId, rangeFlex, env, profile.displayName, ctx);
      return;
    }
    if (rangeMax - rangeMin > 50) {
      const diff = rangeMax - rangeMin;
      const rangeSpanFlex = generateNoticeFlex(
        '⚠️ ช่วงราคาห่างเกินไป',
        `ช่วงราคาต้องห่างกันไม่เกิน 50 วินาทีครับ\n(คุณระบุ ${rangeMin}-${rangeMax} ห่าง ${diff} วิ)`,
        'warning'
      );
      await deliverPrivateNotice(userId, replyToken, groupId, rangeSpanFlex, env, profile.displayName, ctx);
      return;
    }
  }

  if (profile.balance < amount) {
    const needed = amount - profile.balance;
    const insufficientFlex = generateInsufficientBalanceFlex(profile.balance, needed);
    await deliverPrivateNotice(userId, replyToken, groupId, insufficientFlex, env, profile.displayName, ctx);
    return;
  }

  // 2. Generate unique orderNumber in-memory (0ms KV latency)
  const existingNumbers = new Set(pendingList.map((o) => o.orderNumber));
  let orderNumber = Math.floor(1000 + Math.random() * 9000).toString();
  for (let attempt = 0; attempt < 20 && existingNumbers.has(orderNumber); attempt++) {
    orderNumber = Math.floor(1000 + Math.random() * 9000).toString();
  }

  // 3. Determine order status
  const quoteReleased = !!(round && round.quoteReleased === true);
  const isPreQuote = !isCustom && !quoteReleased;
  const orderStatus = isPreQuote ? 'pending_hold' : 'pending_match';

  // 4. Construct Order object
  const newOrder: Order = {
    orderNumber,
    creatorId: profile.shortId,
    creatorName: profile.displayName,
    creatorLineUserId: profile.lineUserId,
    side,
    amount,
    betType: isPreQuote ? 'pre_quote' : (isCustom ? 'custom_range' : 'range'),
    rangeMin: isPreQuote ? offsetDelta : (isCustom ? rangeMin : ((round?.targetMin || 330) + offsetDelta)),
    rangeMax: isPreQuote ? offsetDelta : (isCustom ? rangeMax : ((round?.targetMax || 380) + offsetDelta)),
    status: orderStatus,
    groupId: targetGroupId,
    userTypedCmd: text,
    rocketName: round?.name || null,
    offset: isPreQuote ? offsetDelta : undefined,
    createdAt: Date.now(),
    id: `bet_${orderNumber}`,
    playerLowId: side === 'low' ? profile.shortId : null,
    playerLowName: side === 'low' ? profile.displayName : null,
    playerHighId: side === 'high' ? profile.shortId : null,
    playerHighName: side === 'high' ? profile.displayName : null,
  };

  // 5. Update profile balance in-memory
  profile.balance -= amount;

  // 6. Generate Group Flex Card in-memory (< 0.1ms)
  const flexCard = generateOrderFlex(newOrder);

  // 7. Update pending orders list in-memory
  const updatedPendingList = [newOrder, ...pendingList.filter((o) => o.orderNumber !== orderNumber)].slice(0, 300);

  // 8. Pipeline Order Persistence & LINE Dispatch Concurrently (< 500ms)
  const persistenceTask = Promise.all([
    env.KV_ORDERS.put(`ORDER_${orderNumber}`, JSON.stringify(newOrder)),
    savePlayerProfile(profile, env, ctx),
    state(env).put('PENDING_ORDERS_LIST', JSON.stringify(updatedPendingList), { expirationTtl: 86400 }),
  ]);

  let cardDispatched = false;
  if (groupId) {
    // ── Order created in LINE Group: Dispatch directly to the Group Chat ──
    if (replyToken) {
      cardDispatched = await replyToLine(replyToken, flexCard, env, false);
    }
    if (!cardDispatched && targetGroupId) {
      const pushRes = await pushToLine(targetGroupId, flexCard, env);
      cardDispatched = !!pushRes.success;
    }

    // STRICT USER RULE: Never send private DM confirmation when order is created in a LINE Group.
    // The group received the Order Flex card. Sending DM wastes monthly LINE push quota.
  } else {
    // ── Order created in 1-on-1 private chat (DM): ──
    // 1) Broadcast Order Flex to the main Group
    if (targetGroupId) {
      if (ctx) {
        ctx.waitUntil(pushToLine(targetGroupId, flexCard, env).catch((e) => console.error(e)));
      } else {
        pushToLine(targetGroupId, flexCard, env).catch(() => {});
      }
    }

    // 2) Send private confirmation to the player in DM
    const confirmFlex = isPreQuote
      ? generateNoticeFlex(
          '⏳ ถือออเดอร์รอราคาช่าง',
          `Order #${orderNumber} ถูกถืออยู่รอราคาช่างครับ (${amount.toLocaleString()} pt)\nเมื่อแอดมินเปิดราคาช่าง ระบบจะลงกระดานให้อัตโนมัติครับ 🚀`,
          'info'
        )
      : generateNoticeFlex(
          `✅ เปิดแผล #${orderNumber} สำเร็จ`,
          `รายการ: ${newOrder.userTypedCmd || ''} (${amount.toLocaleString()} pt)\nแต้มคงเหลือ: ${profile.balance.toLocaleString()} pt 💎`,
          'success'
        );

    if (replyToken) {
      await replyToLine(replyToken, confirmFlex, env, true);
    } else if (userId && userId.startsWith('U')) {
      if (ctx) {
        ctx.waitUntil(pushToLine(userId, confirmFlex, env).catch((e) => console.error(e)));
      } else {
        pushToLine(userId, confirmFlex, env).catch(() => {});
      }
    }
  }

  // Ensure persistence completes
  await persistenceTask;

  if (ctx) {
    ctx.waitUntil(
      state(env).put(
        'LAST_ORDER_CREATE_DEBUG',
        JSON.stringify({
          orderNumber,
          cmd: text,
          amount,
          userId,
          groupId,
          targetGroupId,
          cardDispatched,
          time: new Date().toISOString(),
        })
      ).catch(() => {})
    );
  }
}

async function handleMatchOrder(
  orderNo: string | undefined,
  matchAmt: number | undefined,
  profile: PlayerProfile,
  userId: string,
  groupId: string | null,
  replyToken: string | undefined,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  const resolvedNo = await resolveOrderNumber(orderNo, profile.shortId, env);
  if (!resolvedNo) {
    const errorMsg = orderNo
      ? `ไม่พบแผล Order #${orderNo} ในระบบครับ`
      : 'ขณะนี้ไม่มีแผลที่เปิดรอคู่ในระบบครับ 🚀\n(ท่านสามารถพิมพ์ ชล หรือ ชถ ในกลุ่มดวล เพื่อเปิดแผลใหม่ได้ครับ)';
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(orderNo, errorMsg, 'พิมพ์ "ต <เลข order>" เพื่อรับแผลที่ยังว่างอยู่ครับ'), env, profile.displayName, ctx);
    return;
  }

  const orderRaw = await env.KV_ORDERS.get(`ORDER_${resolvedNo}`);
  if (!orderRaw) {
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, `ไม่พบแผล Order #${resolvedNo} ในระบบครับ`, 'พิมพ์ "ต <เลข order>" เพื่อลองรับแผลอื่นครับ'), env, profile.displayName, ctx);
    return;
  }

  const order = JSON.parse(orderRaw) as Order;
  // A pre-quote order (pending_hold) IS matchable before the price is announced.
  // It has no range yet; it is confirmed when the admin sends the quote, and
  // cancelled with both sides refunded if the admin never sends one. So it must
  // not be rejected here the way a cancelled order is.
  const isPreQuoteHeld = order.status === 'pending_hold' && order.betType === 'pre_quote';
  if (order.status !== 'pending_match' && !isPreQuoteHeld) {
    // Each status gets its own explanation. This used to be a two-way ternary
    // that called everything which was not `matched` "cancelled" — so an order
    // merely WAITING for the rocket price to be announced was reported as
    // cancelled. Players were tapping a live order and being told it no longer
    // existed.
    let reason: string;
    let hint: string;
    if (order.status === 'matched') {
      reason = 'แผลนี้มีคู่ดวลแล้วครับ';
      hint = 'พิมพ์ "กระดานดวล" เพื่อดูแผลที่ยังว่างอยู่ครับ';
    } else {
      reason = 'แผลนี้ถูกยกเลิกไปแล้วครับ';
      hint = 'พิมพ์ "กระดานดวล" เพื่อดูแผลที่ยังว่างอยู่ครับ';
    }
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, reason, hint), env, profile.displayName, ctx);
    return;
  }

  if (order.creatorId === profile.shortId) {
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, 'คุณไม่สามารถรับแผลดวลของตัวเองได้ครับ', 'เลือกแผลของผู้เล่นอื่นเพื่อเปิดการดวลครับ'), env, profile.displayName, ctx);
    return;
  }

  // ── Partial match validation ──
  //
  // A matcher may take any portion of an open order, not only the whole thing.
  // This port previously rejected anything but an exact match, which silently
  // removed the partial-match feature the board advertises: the GAS reference
  // enforced these rules (Code.gs ~2255):
  //
  //   * at least 100pt — below that the match is not worth the round trip
  //   * at least 20% of the order — stops five 100pt players fragmenting a
  //     500pt order into dust, and keeps the remainder worth offering
  //   * never more than the order amount — the remainder belongs to the
  //     creator, not the matcher
  const MIN_MATCH_POINTS = 100;
  const MIN_MATCH_RATIO = 0.20;

  if (matchAmt !== undefined) {
    if (matchAmt < MIN_MATCH_POINTS) {
      const msg = `ยอดดวลขั้นต่ำคือ ${MIN_MATCH_POINTS.toLocaleString()} pt ครับ (คุณระบุ ${matchAmt.toLocaleString()} pt)`;
      await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, msg, `พิมพ์ "ต <เลข order> <ยอด>" โดยยอดไม่ต่ำกว่า ${MIN_MATCH_POINTS} pt ครับ`), env, profile.displayName, ctx);
      return;
    }
    const minRatio = Math.max(MIN_MATCH_POINTS, Math.round(order.amount * MIN_MATCH_RATIO));
    if (matchAmt < minRatio) {
      const msg = `รับได้ขั้นต่ำ ${Math.round(MIN_MATCH_RATIO * 100)}% ของแผล คือ ${minRatio.toLocaleString()} pt ครับ (คุณระบุ ${matchAmt.toLocaleString()} pt)`;
      await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, msg, `พิมพ์ "ต ${resolvedNo} ${minRatio.toLocaleString()}" หรือมากกว่า สูงสุด ${order.amount.toLocaleString()} pt ครับ`), env, profile.displayName, ctx);
      return;
    }
    if (matchAmt > order.amount) {
      const msg = `ยอดรับดวล (${matchAmt.toLocaleString()} pt) เกินยอดของ Order #${resolvedNo} (รับได้สูงสุด ${order.amount.toLocaleString()} pt ครับ)`;
      await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, msg, `พิมพ์ "ต ${resolvedNo} <ยอด>" โดยยอดไม่เกิน ${order.amount.toLocaleString()} pt ครับ`), env, profile.displayName, ctx);
      return;
    }
  }

  // The portion this matcher actually takes. Undefined = take the whole order.
  const effectiveAmt = matchAmt !== undefined ? matchAmt : order.amount;
  const isPartial = effectiveAmt < order.amount;
  const remainingAmount = order.amount - effectiveAmt;
  if (profile.balance < effectiveAmt) {
    const needed = effectiveAmt - profile.balance;
    const msg = `แต้มไม่พอรับแผลครับ (มี ${profile.balance.toLocaleString()} pt | ขาด ${needed.toLocaleString()} pt)`;
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, msg, 'พิมพ์ "ฝากเงิน" ในแชตนี้เพื่อเติมเครดิตครับ 🚀'), env, profile.displayName, ctx);
    return;
  }

  // ── Claim the match ──
  //
  // Everything above decided "is this order still open?" by reading KV_ORDERS,
  // which is eventually consistent. Two match requests arriving close together
  // can BOTH observe `pending_match` and both proceed to debit their matcher and
  // mark the order matched — two matches against one order, with only one
  // refund ever owed.
  //
  // The production chat log shows exactly this traffic: players re-tapping the
  // same order seconds apart (A-K at 07:33:50 and again at 07:33:57 on #7015,
  // with a third attempt from another player at 07:35:47). Each tap is a
  // separate webhook invocation, so the race is reachable, not theoretical.
  //
  // This is the same compare-and-set that makes `refundOrderOnce` idempotent,
  // applied to the other direction of the trade. Only the claim winner debits
  // anybody. Fails closed: if the claim cannot be taken, the match is refused
  // rather than risking a second debit.
  const matchClaimKey = `MATCH:${resolvedNo}@${Number(order.createdAt) || 0}`;
  const matchClaimed = await state(env).claimExclusive(matchClaimKey, {
    orderNumber: resolvedNo,
    createdAt: Number(order.createdAt) || 0,
    amount: effectiveAmt,
    matcherId: profile.shortId,
    claimedAt: Date.now(),
  });

  if (!matchClaimed) {
    await deliverPrivateNotice(
      userId, replyToken, groupId,
      generateMatchMismatchFlex(resolvedNo, 'แผลนี้ถูกรับไปโดยผู้เล่นอื่นแล้วครับ', 'พิมพ์ "กระดานดวล" เพื่อดูแผลที่ยังว่างอยู่ครับ'),
      env, profile.displayName, ctx
    );
    return;
  }

  // Deduct matcher balance BEFORE saving
  profile.balance -= effectiveAmt;

  // The matched portion carries the original order number and the amount that
  // was actually taken. Downstream settlement reads `amount`, so this is what
  // both sides get paid out on — the matcher cannot win or lose more than the
  // portion they committed.
  const originalAmount = order.amount;
  order.amount = effectiveAmt;
  order.status = 'matched';
  order.matcherId = profile.shortId;
  order.matcherName = profile.displayName;
  order.matcherLineUserId = profile.lineUserId;
  order.matchedAt = Date.now();
  // Clear the pre-match side so settlement cannot double-assign a winner. The
  // creator's side is restored below for the remainder order only.
  // The creator's own side was recorded when the order opened; restore it so
  // the settled record names BOTH players. Blanking both fields and setting
  // only the matcher's side left playerHighId null on every matched 'high'
  // order, which the P2P report and the admin portal both read.
  order.playerLowId = order.side === 'low' ? order.creatorId : null;
  order.playerLowName = order.side === 'low' ? order.creatorName : null;
  order.playerHighId = order.side === 'high' ? order.creatorId : null;
  order.playerHighName = order.side === 'high' ? order.creatorName : null;
  if (order.side === 'low') {
    order.playerHighId = profile.shortId;
    order.playerHighName = profile.displayName;
  } else {
    order.playerLowId = profile.shortId;
    order.playerLowName = profile.displayName;
  }

  const updateParts: Promise<any>[] = [
    env.KV_ORDERS.put(`ORDER_${resolvedNo}`, JSON.stringify(order)),
    removeFromPendingOrdersList(resolvedNo, env),
    addToMatchedOrdersList(order, env),
  ];

  // ── Remainder handling ──
  //
  // The creator is charged the FULL amount when the order opens, so whatever a
  // matcher does NOT take is money already taken from them. It is returned
  // immediately, here, at match time.
  //
  // It is deliberately NOT re-listed as a second open order. That model needed
  // a fresh order number (ORDER_<n> is a KV key, so reusing the parent's would
  // overwrite the matched record), which left an order the group could not see,
  // a leftover below the 100pt minimum that nobody was allowed to bet, and a
  // separate class of edge cases around cancelling the remainder. Returning the
  // money removes all of it and leaves the creator in control: they can open a
  // new order with it or sit it out until the next round.
  //
  // Net effect on the creator's balance for a 500pt order taken at 200:
  //   -500 when opened, +300 back now, so their exposure is only the 200.
  let remainderRefunded = 0;

  if (isPartial) {
    remainderRefunded = remainingAmount;

    if (remainderRefunded > 0) {
      const creatorLine = (await state(env).get(`RAW_LINE_${order.creatorId}`)) || order.creatorLineUserId || order.creatorId;
      const creatorProfile = await getOrCreatePlayerProfile(creatorLine, env, ctx);
      if (creatorProfile) {
        creatorProfile.balance += remainderRefunded;
        updateParts.push(savePlayerProfile(creatorProfile, env, ctx));
      } else {
        // No creator profile to credit. The points were taken from them at
        // order time, so losing them here would be silent theft. Fall back to
        // the by-id refund path, which searches the player list.
        console.error(
          `[Worker] partial take on #${resolvedNo}: creator profile not found for ${order.creatorId}`
        );
        updateParts.push(
          refundPlayerPoints(order.creatorId, order.creatorLineUserId, remainderRefunded, env, ctx)
        );
      }
    }
  }

  const updatePersistence = Promise.all(updateParts);

  // Generate match card
  const matchFlex = generateMatchNotificationFlex(order);

  // Match notification: send match card to group without floating quick reply, and push to DM of both players
  const creatorLineId = (await state(env).get(`RAW_LINE_${order.creatorId}`)) || order.creatorLineUserId;
  const matchPromises: Promise<any>[] = [updatePersistence];
  
  if (groupId) {
    if (replyToken) {
      matchPromises.push(replyToLine(replyToken, matchFlex, env, false));
    } else if (order.groupId) {
      matchPromises.push(pushToLine(order.groupId, matchFlex, env));
    }
    // Also push match card to matcher's DM
    if (userId && userId.startsWith('U')) {
      matchPromises.push(pushToLine(userId, matchFlex, env));
    }
  } else {
    // Matched in DM
    if (replyToken) {
      matchPromises.push(replyToLine(replyToken, matchFlex, env, true));
    } else if (userId && userId.startsWith('U')) {
      matchPromises.push(pushToLine(userId, matchFlex, env));
    }
    // Also broadcast match card to the group where the order originated
    if (order.groupId) {
      matchPromises.push(pushToLine(order.groupId, matchFlex, env));
    }
  }

  // Push match card to creator's DM
  if (creatorLineId && creatorLineId !== userId) {
    matchPromises.push(pushToLine(creatorLineId, matchFlex, env));
  }

  // Tell the creator what happened to the rest of their points. They were
  // charged the full amount when the order opened, so silence here leaves them
  // thinking 500pt is still riding on this order when in fact only the matched
  // portion is — and that 300pt is already back in their balance.
  if (isPartial && creatorLineId) {
    const remainderFlex = generateNoticeFlex(
      `ℹ️ แผล Order #${resolvedNo} ถูกรับไปบางส่วน`,
      `รับไป ${effectiveAmt.toLocaleString()} pt จากทั้งหมด ${originalAmount.toLocaleString()} pt\n` +
      `ส่วนที่ไม่ถูกรับ ${remainderRefunded.toLocaleString()} pt คืนเข้ากระเป๋าคุณแล้วครับ ✅\n` +
      `(ต้องการเล่นต่อ พิมพ์คำสั่งเปิดแผลใหม่ได้เลยครับ)`,
      'info'
    );
    matchPromises.push(pushToLine(creatorLineId, remainderFlex, env));
  }

  if (ctx) {
    ctx.waitUntil(Promise.all(matchPromises));
  } else {
    await Promise.all(matchPromises);
  }
}

async function cancelOrder(
  orderNo: string,
  profile: PlayerProfile,
  env: Env,
  ctx?: ExecutionContext
): Promise<{ success: boolean; message: string; amount?: number; balance?: number }> {
  const resolvedNo = await resolveOrderNumber(orderNo, null, env);
  if (!resolvedNo) return { success: false, message: `🚫 ไม่พบแผล Order #${orderNo}` };

  const raw = await env.KV_ORDERS.get(`ORDER_${resolvedNo}`);
  if (!raw) return { success: false, message: `🚫 ไม่พบแผล Order #${resolvedNo}` };

  const order = JSON.parse(raw) as Order;
  if (order.creatorId !== profile.shortId) {
    return { success: false, message: '⚠️ คุณไม่ใช่เจ้าของแผลนี้ครับ' };
  }
  if (order.status !== 'pending_match' && order.status !== 'pending_hold') {
    return { success: false, message: `⚠️ แผล Order #${resolvedNo} อยู่ในสถานะ ${order.status} ไม่สามารถยกเลิกได้ครับ` };
  }

  // Claim the refund BEFORE crediting anything. The status check above reads
  // eventually-consistent KV, so on its own it cannot tell "nobody has
  // cancelled this yet" from "the admin cancelled it a moment ago and the
  // write has not reached this region". The claim is strongly consistent, so it
  // can — this is what stops a second, duplicate refund.
  const refund = await refundOrderOnce(order, env, ctx, 'player_cancel');

  if (!refund.refunded) {
    return {
      success: false,
      message: `⚠️ แผล Order #${resolvedNo} ถูกยกเลิกไปแล้วครับ ไม่สามารถยกเลิกซ้ำได้ (ระบบคืนแต้มให้ครั้งแรกเรียบร้อยแล้ว)`,
    };
  }

  // 1. Mark order cancelled in KV_ORDERS & remove from pending list
  order.status = 'cancelled';
  await Promise.all([
    env.KV_ORDERS.put(`ORDER_${resolvedNo}`, JSON.stringify(order)),
    removeFromPendingOrdersList(resolvedNo, env),
  ]);

  // 2. Report the balance as it actually stands now. The old code added to the
  // in-memory profile it was handed, which could be stale relative to the
  // authoritative record and printed a number the player never received.
  const freshRaw = profile.lineUserId
    ? await state(env).get(`USER_${profile.lineUserId}`)
    : await state(env).get(`USER_${profile.shortId}`);
  const currentBalance = freshRaw
    ? (Number((JSON.parse(freshRaw) as PlayerProfile).balance) || 0)
    : profile.balance + refund.amount;

  return {
    success: true,
    amount: refund.amount,
    balance: currentBalance,
    message: `✅ ยกเลิก Order #${resolvedNo} เรียบร้อยแล้วครับ!\n💰 คืนแต้ม: +${refund.amount.toLocaleString()} pt\n💎 แต้มคงเหลือปัจจุบัน: ${currentBalance.toLocaleString()} pt 🚀`,
  };
}

/**
 * A player sent a slip image.
 *
 * The slip is the source of truth: the amount credited is the amount the slip
 * proves, not anything the player typed beforehand. This replaces a stub that
 * created a transaction with `requestedAmount: 1000` hardcoded and always
 * escalated it to an admin.
 *
 * Every failure path lands in the Admin Console with the reason attached, so a
 * slip the scanner cannot read is still a deposit the operator can settle —
 * the player is never left with money transferred and nothing to show for it.
 */
async function handleSlipUpload(
  event: LineEvent,
  userId: string,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  const profile = await getOrCreatePlayerProfile(userId, env, ctx);
  const messageId = event.message?.id || '';
  const groupId = event.source?.groupId || null;
  const replyToken = event.replyToken;

  const nowStr = new Date().toLocaleTimeString('th-TH', { hour12: false });
  const txId = `TX${Math.floor(100000 + Math.random() * 900000)}`;

  const escalate = async (detail: string, playerMessage: string, slipRef = '') => {
    const tx: Transaction = {
      id: txId,
      playerId: profile.shortId,
      lineUserId: profile.lineUserId,
      playerName: profile.displayName,
      requestedAmount: 0,
      actualAmount: 0,
      slipRef: slipRef || messageId,
      status: 'escalated',
      reviewReason: detail,
      timestamp: nowStr,
      type: 'deposit',
      createdAt: Date.now(),
    };
    await addTransaction(tx, env, ctx);
    await deliverPrivateNotice(
      userId,
      replyToken,
      groupId,
      generateNoticeFlex('📥 ได้รับสลิปแล้ว', playerMessage, 'warning'),
      env,
      profile.displayName,
      ctx
    );
  };

  // Scanning is a network round-trip to the slip provider; acknowledge the
  // player first so the reply token is not left to expire on a slow response.
  await deliverPrivateNotice(
    userId,
    replyToken,
    groupId,
    generateNoticeFlex('🔍 กำลังตรวจสอบสลิป', 'ระบบกำลังอ่านสลิปของคุณอยู่ครับ\nกรุณารอสักครู่นะครับ 🙏', 'info'),
    env,
    profile.displayName,
    ctx
  );

  const scan = await scanSlipImage(messageId, env);

  if (!scan.ok) {
    await escalate(scan.detail, scan.message);
    return;
  }

  // GUARD 3 — the same slip must never credit twice.
  //
  // The player re-sending a slip, LINE redelivering the webhook, or two uploads
  // racing would all otherwise credit the same reference again. The claim is
  // taken BEFORE any money moves and fails closed, so an unavailable Durable
  // Object means no credit rather than a possible duplicate.
  const firstUse = await state(env).claimExclusive(
    `SLIP:${scan.refCode}`,
    {
      refCode: scan.refCode,
      amount: scan.amount,
      playerId: profile.shortId,
      lineUserId: profile.lineUserId,
      messageId,
      at: Date.now(),
    },
    90 * 24 * 60 * 60 * 1000 // 90 days — comfortably past any dispute window
  );

  if (!firstUse) {
    await escalate(
      `Duplicate slip reference ${scan.refCode} — already submitted before`,
      `⚠️ ตรวจพบสลิปซ้ำในระบบ\nเลขอ้างอิง: ${scan.refCode}\nสลิปนี้เคยถูกใช้งานแล้ว จึงไม่ได้เติมเครดิตซ้ำครับ\n\nหากคุณคิดว่าไม่ถูกต้อง กรุณาแจ้งแอดมินครับ`,
      scan.refCode
    );
    return;
  }

  // Credit the verified slip amount.
  profile.balance = (Number(profile.balance) || 0) + scan.amount;
  await savePlayerProfile(profile, env, ctx);

  // Register the payer's bank details. These are what a later "ถอน x,xxx"
  // reuses, so a player who has deposited never has to type them again.
  if (scan.sender?.account && scan.sender.name) {
    const withBank: PlayerProfile = {
      ...profile,
      bankName: profile.bankName || scan.sender.bank || '',
      accountNumber: profile.accountNumber || scan.sender.account,
      accountName: profile.accountName || scan.sender.name,
    };
    if (withBank.accountNumber !== profile.accountNumber || withBank.accountName !== profile.accountName) {
      await savePlayerProfile(withBank, env, ctx);
    }
  }

  const tx: Transaction = {
    id: txId,
    playerId: profile.shortId,
    lineUserId: profile.lineUserId,
    playerName: profile.displayName,
    requestedAmount: scan.amount,
    actualAmount: scan.amount,
    slipRef: scan.refCode,
    status: 'success',
    reviewReason: `Auto-approved via slip scanner. Ref: ${scan.refCode}`,
    timestamp: nowStr,
    type: 'deposit',
    createdAt: Date.now(),
  };
  await addTransaction(tx, env, ctx);

  await deliverPrivateNotice(
    userId,
    replyToken,
    groupId,
    generateSlipCreditedFlex(scan.amount, profile.balance, scan.refCode),
    env,
    profile.displayName,
    ctx
  );
}

// ── Pending Orders & Lookup Helpers ──

/**
 * Cancels all unmatched pending orders from KV_CACHE and KV_ORDERS and refunds creators.
 * Preserves matched orders waiting for flight time settlement.
 */
export async function clearAllPendingOrders(env: Env, ctx?: ExecutionContext): Promise<{ cleared: number }> {
  let clearedCount = 0;
  try {
    const pendingOrders = await getPendingOrdersList(env);

    // 1. Immediately reset PENDING_ORDERS_LIST with empty array in KV_CACHE
    await state(env).put('PENDING_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 });

    // 2. Cancel and refund ONLY pending_match + pending_hold (pre_quote) orders
    for (const item of pendingOrders) {
      if (!item || !item.orderNumber) continue;
      const raw = await env.KV_ORDERS.get(`ORDER_${item.orderNumber}`);
      if (!raw) continue;
      try {
        const order = JSON.parse(raw) as Order;
        if (order.status === 'pending_match' || order.status === 'pending_hold' || order.status === 'refunding') {
          const isRecovering = order.status === 'refunding';
          order.status = 'refunding';
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));

          // Claimed, so a cancel that already paid out (by the player, by the
          // admin, or by an earlier sweep) is skipped instead of paid twice.
          const refund = await refundOrderOnce(order, env, ctx, 'clear_pending');

          order.status = 'cancelled';
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
          if (refund.refunded && !isRecovering) clearedCount++;
        }
      } catch (_) {}
    }

    console.log(`[Worker] clearAllPendingOrders: Cancelled and refunded ${clearedCount} pending unmatched + held pre-quote orders.`);
  } catch (err) {
    console.error('[Worker] clearAllPendingOrders error:', err);
  }
  return { cleared: clearedCount };
}

/**
 * Identity of an order for the purpose of "has this already been refunded?".
 *
 * Order numbers are random 4-digit values that get reused over time (see
 * handleCreateOrder, which only avoids colliding with orders that are pending
 * *right now*), so the number alone is not an identity. `createdAt` is, and
 * every order carries one — including the ones already stored, which is what
 * lets this guard apply to live data without a migration.
 */
function refundClaimKey(order: Order): string {
  return `${order.orderNumber}@${Number(order.createdAt) || 0}`;
}

export interface RefundOutcome {
  /** True only for the caller that actually moved the money. */
  refunded: boolean;
  /** Why nothing was credited. */
  reason?: 'already_refunded' | 'claim_unavailable';
  amount: number;
  creatorCredited: boolean;
  matcherCredited: boolean;
  newCreatorBalance?: number;
}

/**
 * Refund an order AT MOST ONCE, from any cancellation path.
 *
 * Every way an order can be cancelled — the player typing "ยกเลิก", the Admin
 * Console cancel button, clearing the pending board, auto-cancelling held
 * pre-quote orders, voiding the round — funnels through here, and only the
 * caller that wins the Durable Object claim is allowed to credit anybody.
 *
 * Before this existed each path did its own `read status → refund`, against an
 * eventually-consistent KV record. Two paths could both read a cancellable
 * status and both refund, which is exactly how a 100pt order came to credit the
 * player 200pt: the admin cancelled (refunding silently, no notification), and
 * the player's own cancel then sailed through the `pending_match` guard a few
 * seconds later because the admin's write had not propagated to LINE's region.
 *
 * `matcherId` decides whether the matcher is refunded too, which matches what
 * every call site did individually: pending orders have no matcher, so
 * creator-only is automatic, and matched/voided orders refund both sides.
 */
export async function refundOrderOnce(
  order: Order,
  env: Env,
  ctx?: ExecutionContext,
  source = 'unknown'
): Promise<RefundOutcome> {
  const amount = Number(order.amount) || 0;
  const claimKey = refundClaimKey(order);

  const claimed = await state(env).claimExclusive(`REFUND:${claimKey}`, {
    orderNumber: order.orderNumber,
    createdAt: Number(order.createdAt) || 0,
    amount,
    creatorId: order.creatorId || null,
    matcherId: order.matcherId || null,
    source,
    claimedAt: Date.now(),
  });

  if (!claimed) {
    // Either a previous cancellation already refunded this order, or the claim
    // could not be taken (Durable Object unavailable) — in which case we refuse
    // rather than risk paying twice. Either way: no credit.
    return {
      refunded: false,
      reason: 'already_refunded',
      amount,
      creatorCredited: false,
      matcherCredited: false,
    };
  }

  if (!(amount > 0)) {
    return { refunded: true, amount: 0, creatorCredited: false, matcherCredited: false };
  }

  const creatorCredited = order.creatorId
    ? await refundPlayerPoints(order.creatorId, order.creatorLineUserId, amount, env, ctx)
    : false;
  const matcherCredited = order.matcherId
    ? await refundPlayerPoints(order.matcherId, order.matcherLineUserId || undefined, amount, env, ctx)
    : false;

  return { refunded: true, amount, creatorCredited, matcherCredited };
}

/**
 * Safely credits/refunds points to a player profile across USER_${lineId}, USER_${shortId}, and PLAYERS_LIST.
 */
export async function refundPlayerPoints(
  shortId: string,
  lineUserId: string | undefined,
  amount: number,
  env: Env,
  ctx?: ExecutionContext
): Promise<boolean> {
  if (amount <= 0) return true;
  try {
    const rawLine = (await state(env).get(`RAW_LINE_${shortId}`)) || lineUserId || shortId;
    let profileRaw = await state(env).get(`USER_${rawLine}`);
    if (!profileRaw && lineUserId) {
      profileRaw = await state(env).get(`USER_${lineUserId}`);
    }
    if (!profileRaw && shortId) {
      profileRaw = await state(env).get(`USER_${shortId}`);
    }
    if (profileRaw) {
      const p = JSON.parse(profileRaw) as PlayerProfile;
      p.balance = (Number(p.balance) || 0) + amount;
      await savePlayerProfile(p, env, ctx);
      return true;
    }

    // Fallback: search in PLAYERS_LIST
    const listRaw = await state(env).get('PLAYERS_LIST');
    if (listRaw) {
      const list = JSON.parse(listRaw) as any[];
      const p = list.find((x: any) => x.id === shortId || x.shortId === shortId || (lineUserId && (x.lineUserId === lineUserId || x.id === lineUserId)));
      if (p) {
        p.balance = (Number(p.balance) || 0) + amount;
        p.updatedAt = Date.now();
        await state(env).put('PLAYERS_LIST', JSON.stringify(list));
        const effectiveLine = p.lineUserId || rawLine;
        if (effectiveLine) {
          await state(env).put(`USER_${effectiveLine}`, JSON.stringify(p));
        }
        if (shortId) {
          await state(env).put(`USER_${shortId}`, JSON.stringify(p));
        }
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('[Worker] refundPlayerPoints error:', err);
    return false;
  }
}

/**
 * Cancels every PRE-QUOTE order when the round ends without an official quote,
 * and refunds the stake to both parties.
 *
 * Pre-quote orders are matchable before the price is announced, so by the time
 * a round closes without a quote they can be in EITHER state:
 *
 *   * `pending_hold` — created, nobody has taken them yet. Refund the creator.
 *   * `matched`      — taken by another player before the quote arrived. Both
 *                      sides have a stake held and both must be refunded.
 *
 * This previously only looked at the pending index and only for `pending_hold`,
 * so a matched pre-quote order was skipped entirely: neither side was refunded
 * and neither was the order closed. That is money held against an order that
 * could never settle.
 *
 * Deliberately scoped by `betType === 'pre_quote'`, never by status alone: a
 * self-quoted custom-range order is valid with or without an admin quote and
 * must survive this untouched.
 */
export async function cancelHeldPreQuoteOrders(env: Env, ctx?: ExecutionContext): Promise<{ cancelled: number; cancelledOrderNumbers: string[] }> {
  let cancelledCount = 0;
  const cancelledOrderNumbers: string[] = [];
  try {
    const [pendingList, matchedList] = await Promise.all([
      getPendingOrdersList(env),
      getMatchedOrdersList(env),
    ]);

    // Still a pre-quote AND never confirmed by a quote → nobody ever priced it.
    //
    // The `offsetConfirmedAt` test matters as much as the betType one. A matched
    // pre-quote order KEEPS betType 'pre_quote' after its quote lands — that is
    // how it stays identifiable — so keying on betType alone would cancel and
    // refund every pre-quote order in a round that quoted perfectly normally.
    // `offsetConfirmedAt` is stamped by releaseHeldPreQuoteOrders at the moment
    // the quote assigns a real range, so its presence means "running, settle it".
    const isUnquotedPreQuote = (o: any) =>
      Boolean(o) && o.betType === 'pre_quote' && !o.offsetConfirmedAt;
    const candidates: Order[] = [];
    const seen = new Set<string>();
    for (const o of [...pendingList, ...matchedList]) {
      if (!isUnquotedPreQuote(o) || !o.orderNumber || seen.has(o.orderNumber)) continue;
      seen.add(o.orderNumber);
      candidates.push(o);
    }

    const remainingPending = pendingList.filter((o) => !isUnquotedPreQuote(o));
    const remainingMatched = matchedList.filter((o) => !isUnquotedPreQuote(o));

    for (const item of candidates) {
      const raw = await env.KV_ORDERS.get(`ORDER_${item.orderNumber}`);
      if (!raw) continue;
      try {
        const order = JSON.parse(raw) as Order;
        if (order.betType !== 'pre_quote' || order.offsetConfirmedAt) continue;
        if (order.status !== 'pending_hold' && order.status !== 'matched') continue;

        const amt = Number(order.amount) || 0;
        const hadMatcher = Boolean(order.matcherId);

        // Claim first: if the player or the admin already cancelled this order,
        // do not notify them about a refund that is not happening. For a
        // matched order this also credits BOTH sides, exactly once.
        const refund = await refundOrderOnce(order, env, ctx, 'cancel_held_pre_quote');

        order.status = 'cancelled';
        await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
        if (!refund.refunded) continue;
        cancelledCount++;
        cancelledOrderNumbers.push(order.orderNumber);

        // Both parties are owed a refund on a matched pre-quote order, so both
        // hear about it.
        const parties: Array<{ id: string; lineId?: string | null; name?: string | null }> = [
          { id: order.creatorId, lineId: order.creatorLineUserId, name: order.creatorName },
        ];
        if (hadMatcher) {
          parties.push({ id: order.matcherId!, lineId: order.matcherLineUserId, name: order.matcherName });
        }

        await Promise.all(parties.map(async (p) => {
          if (!p.id) return;
          const rawLine = (await state(env).get(`RAW_LINE_${p.id}`)) || p.lineId || p.id;
          const cancelPreQuoteFlex = generateNoticeFlex(
            `🚫 ยกเลิก Order #${order.orderNumber} อัตโนมัติ`,
            `จบรอบดวลโดยไม่มีการประกาศราคาช่างอย่างเป็นทางการ\nระบบคืนแต้ม: +${amt.toLocaleString()} pt เรียบร้อยครับ ✅`,
            'warning'
          );
          await deliverPrivateNotice(
            rawLine,
            undefined,
            order.groupId || null,
            cancelPreQuoteFlex,
            env,
            p.name || undefined
          );
        }));
      } catch (_) {}
    }

    await Promise.all([
      state(env).put('PENDING_ORDERS_LIST', JSON.stringify(remainingPending), { expirationTtl: 1800 }),
      state(env).put('MATCHED_ORDERS_LIST', JSON.stringify(remainingMatched), { expirationTtl: 1800 }),
    ]);
    console.log(`[Worker] cancelHeldPreQuoteOrders: Cancelled + refunded ${cancelledCount} pre-quote orders.`);
  } catch (err) {
    console.error('[Worker] cancelHeldPreQuoteOrders error:', err);
  }
  return { cancelled: cancelledCount, cancelledOrderNumbers };
}

/**
 * Applies the officially released ราคาช่าง band (minVal-maxVal) to all held pre-quote orders:
 *  - Converts pending_hold pre_quote orders to real band ± offset, status -> pending_match
 *  - Re-adds them to the pending board
 *  - Auto-matches same-amount opposite-side pairs, notifying both players via DM.
 * Called from adminBroadcastQuote whenever a price tier is officially released.
 */
export async function releaseHeldPreQuoteOrders(minVal: number, maxVal: number, env: Env, ctx?: ExecutionContext): Promise<{ converted: number; matched: number; confirmedMatched: number }> {
  const bandMin = Number(minVal) || 330;
  const bandMax = Number(maxVal) || 380;
  const pending = await getPendingOrdersList(env);
  const held = pending.filter((o) => o && o.status === 'pending_hold' && o.betType === 'pre_quote');
  const nonHeld = pending.filter((o) => !(o && o.status === 'pending_hold' && o.betType === 'pre_quote'));

  let converted = 0;
  let confirmedMatched = 0;
  const convertedOrders: Order[] = [];

  for (const item of held) {
    const raw = await env.KV_ORDERS.get(`ORDER_${item.orderNumber}`);
    if (!raw) continue;
    try {
      const order = JSON.parse(raw) as Order;
      if (order.status === 'pending_hold' && order.betType === 'pre_quote') {
        const offset = Number(order.offset) || 0;
        order.betType = 'range';
        order.rangeMin = bandMin + offset;
        order.rangeMax = bandMax + offset;
        order.status = 'pending_match';
        await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
        convertedOrders.push(order);
        converted++;
      }
    } catch (_) {}
  }

  // A pre-quote order can already be MATCHED when the quote arrives, because it
  // is matchable before the price is announced. Such an order still holds only
  // an offset — no real range — so it has to be given one now or it can never be
  // settled. It keeps its `pre_quote` betType: that is what
  // cancelHeldPreQuoteOrders looks for, and a matched order must never re-enter
  // the pending board.
  const matchedPreQuote = (await getMatchedOrdersList(env)).filter(
    (o) => o && o.betType === 'pre_quote'
  );
  for (const item of matchedPreQuote) {
    const raw = await env.KV_ORDERS.get(`ORDER_${item.orderNumber}`);
    if (!raw) continue;
    try {
      const order = JSON.parse(raw) as Order;
      if (order.betType !== 'pre_quote') continue;
      const offset = Number(order.offset) || 0;
      order.rangeMin = bandMin + offset;
      order.rangeMax = bandMax + offset;
      order.offsetConfirmedAt = Date.now();
      await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
      confirmedMatched++;
    } catch (_) {}
  }

  // Update PENDING_ORDERS_LIST with newly converted pending_match orders
  const updatedPending = [...convertedOrders, ...nonHeld].slice(0, 300);
  await state(env).put('PENDING_ORDERS_LIST', JSON.stringify(updatedPending), { expirationTtl: 1800 });

  // Auto-match same-amount opposite-side pairs
  const matched = await autoMatchPendingPairs(env, ctx);

  // Notify each converted player that their pre-quote order is now active
  const notifyPromises = convertedOrders.map(async (o) => {
    const rawLine = (await state(env).get(`RAW_LINE_${o.creatorId}`)) || o.creatorLineUserId || o.creatorId;
    const releaseFlex = generateNoticeFlex(
      `🚀 ราคาช่างเปิดแล้ว: ${bandMin}-${bandMax}s`,
      `Order #${o.orderNumber} (${o.amount.toLocaleString()} pt ${o.side === 'low' ? 'ชถ/ต่ำ' : 'ชล/สูง'})\nเปิดลงกระดานรอคู่เรียบร้อย พร้อมจับคู่แล้วครับ 🚀`,
      'success'
    );
    return deliverPrivateNotice(
      rawLine,
      undefined,
      o.groupId || null,
      releaseFlex,
      env,
      o.creatorName
    );
  });
  await Promise.all(notifyPromises);

  console.log(`[Worker] releaseHeldPreQuoteOrders: released ${converted} held pre-quote orders, confirmed ${confirmedMatched} already-matched pre-quote orders, auto-matched ${matched} pairs.`);
  return { converted, matched, confirmedMatched };
}

/**
 * Pairs up pending_match orders of the same amount on opposite sides (low vs high),
 * marks both as matched to each other, refund-agnostic (balances already held),
 * and notifies both players via DM with the match flex.
 */
export async function autoMatchPendingPairs(env: Env, ctx?: ExecutionContext): Promise<number> {
  try {
    const pending = await getPendingOrdersList(env);
    if (pending.length < 2) return 0;

    // Group by amount
    const byAmount = new Map<number, Order[]>();
    for (const o of pending) {
      const key = Number(o.amount);
      if (!byAmount.has(key)) byAmount.set(key, []);
      byAmount.get(key)!.push(o);
    }

    let paired = 0;
    for (const [amount, group] of byAmount) {
      const lows = group.filter((o) => o.side === 'low').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const highs = group.filter((o) => o.side === 'high').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const pairCount = Math.min(lows.length, highs.length);
      if (pairCount === 0) continue;

      for (let i = 0; i < pairCount; i++) {
        const low = lows[i];
        const high = highs[i];
        const matchFlex = generateMatchNotificationFlex(low);
        const lowNotify = (await state(env).get(`RAW_LINE_${low.creatorId}`)) || low.creatorLineUserId || low.creatorId;
        const highNotify = (await state(env).get(`RAW_LINE_${high.creatorId}`)) || high.creatorLineUserId || high.creatorId;

        // Mark low as the primary matched order, high is the matcher
        low.status = 'matched';
        low.matcherId = high.creatorId;
        low.matcherName = high.creatorName;
        low.matcherLineUserId = high.creatorLineUserId;
        low.matchedAt = Date.now();
        low.playerLowId = low.creatorId;
        low.playerLowName = low.creatorName;
        low.playerHighId = high.creatorId;
        low.playerHighName = high.creatorName;

        // High mirrors as matched for settlement bookkeeping (keeping both records)
        high.status = 'matched_paired';
        high.matcherId = low.creatorId;
        high.matcherName = low.creatorName;
        high.matcherLineUserId = low.creatorLineUserId;
        high.matchedAt = Date.now();
        high.playerLowId = low.creatorId;
        high.playerLowName = low.creatorName;
        high.playerHighId = high.creatorId;
        high.playerHighName = high.creatorName;

        await Promise.all([
          env.KV_ORDERS.put(`ORDER_${low.orderNumber}`, JSON.stringify(low)),
          env.KV_ORDERS.put(`ORDER_${high.orderNumber}`, JSON.stringify(high)),
          removeFromPendingOrdersList(low.orderNumber, env),
          removeFromPendingOrdersList(high.orderNumber, env),
          addToMatchedOrdersList(low, env),
          pushToLine(lowNotify, matchFlex, env),
          pushToLine(highNotify, matchFlex, env),
        ]);
        if (ctx) ctx.waitUntil(Promise.resolve());
        paired++;
      }
    }
    console.log(`[Worker] autoMatchPendingPairs: auto-matched ${paired} pairs.`);
    return paired;
  } catch (err) {
    console.error('[Worker] autoMatchPendingPairs error:', err);
    return 0;
  }
}

/**
 * Voids the entire round: cancels BOTH pending_match and matched orders,
 * refunding 100% of points to both creator and matcher.
 */
export async function voidAllRoundOrders(env: Env, ctx?: ExecutionContext): Promise<{ voided: number }> {
  let voidedCount = 0;
  try {
    const [pendingList, matchedList] = await Promise.all([
      getPendingOrdersList(env),
      getMatchedOrdersList(env),
    ]);

    await Promise.all([
      state(env).put('PENDING_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 }),
      state(env).put('MATCHED_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 }),
    ]);

    const allRoundOrders = [...pendingList, ...matchedList];
    const seen = new Set<string>();

    for (const item of allRoundOrders) {
      if (!item || !item.orderNumber || seen.has(item.orderNumber)) continue;
      seen.add(item.orderNumber);

      const raw = await env.KV_ORDERS.get(`ORDER_${item.orderNumber}`);
      if (!raw) continue;
      try {
        const order = JSON.parse(raw) as Order;
        if (order.status === 'pending_match' || order.status === 'matched' || order.status === 'pending_hold' || order.status === 'refunding') {
          const isRecovering = order.status === 'refunding';

          order.status = 'refunding';
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));

          // One claim covers both sides. Refunding creator and matcher inline
          // (as this path used to) meant it could re-pay a cancellation that
          // another path had already settled.
          const refund = await refundOrderOnce(order, env, ctx, 'void_round');

          order.status = 'cancelled';
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
          if (refund.refunded && !isRecovering) voidedCount++;
        }
      } catch (_) {}
    }

    console.log(`[Worker] voidAllRoundOrders: Voided and refunded ${voidedCount} orders 100%.`);
  } catch (err) {
    console.error('[Worker] voidAllRoundOrders error:', err);
  }
  return { voided: voidedCount };
}

export async function getPendingOrdersList(env: Env): Promise<Order[]> {
  try {
    const cached = await state(env).get('PENDING_ORDERS_LIST');
    if (cached !== null) {
      const list = JSON.parse(cached) as Order[];
      return list.filter((o) => o && (o.status === 'pending_match' || o.status === 'pending_hold'));
    }
    // Fallback removed: KV_ORDERS.list is too slow for the hot path.
    // PENDING_ORDERS_LIST is the primary index.
    return [];
  } catch (err) {
    console.error('[Worker] getPendingOrdersList error:', err);
    return [];
  }
}

export async function addToPendingOrdersList(order: Order, env: Env): Promise<void> {
  try {
    const list = await getPendingOrdersList(env);
    const updated = [order, ...list.filter((o) => o.orderNumber !== order.orderNumber)].slice(0, 300);
    await state(env).put('PENDING_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 86400 });
  } catch (err) {
    console.error('[Worker] addToPendingOrdersList error:', err);
  }
}

export async function removeFromPendingOrdersList(orderNo: string, env: Env): Promise<void> {
  try {
    const cleanNo = orderNo.trim().replace(/^#/, '');
    const list = await getPendingOrdersList(env);
    const updated = list.filter((o) => o.orderNumber !== cleanNo);
    await state(env).put('PENDING_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 86400 });
  } catch (err) {
    console.error('[Worker] removeFromPendingOrdersList error:', err);
  }
}

export async function addToMatchedOrdersList(order: Order, env: Env): Promise<void> {
  try {
    const list = await getMatchedOrdersList(env);
    const updated = [order, ...list.filter((o) => o.orderNumber !== order.orderNumber)].slice(0, 300);
    await state(env).put('MATCHED_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 86400 });
  } catch (err) {
    console.error('[Worker] addToMatchedOrdersList error:', err);
  }
}

export async function removeFromMatchedOrdersList(orderNo: string, env: Env): Promise<void> {
  try {
    const cleanNo = orderNo.trim().replace(/^#/, '');
    const list = await getMatchedOrdersList(env);
    const updated = list.filter((o) => o.orderNumber !== cleanNo);
    await state(env).put('MATCHED_ORDERS_LIST', JSON.stringify(updated));
  } catch (err) {
    console.error('[Worker] removeFromMatchedOrdersList error:', err);
  }
}

export async function getMatchedOrdersList(env: Env): Promise<Order[]> {
  try {
    const cached = await state(env).get('MATCHED_ORDERS_LIST');
    return cached ? JSON.parse(cached) : [];
  } catch (err) {
    console.error('[Worker] getMatchedOrdersList error:', err);
    return [];
  }
}

async function resolveOrderNumber(
  inputNo: string | undefined | null,
  excludeCreatorId: string | null,
  env: Env
): Promise<string | null> {
  // If no specific order number passed, find the latest pending open bet
  if (!inputNo || inputNo.trim() === '') {
    const pendingList = await getPendingOrdersList(env);
    if (!pendingList || pendingList.length === 0) return null;
    const candidate = pendingList.find((o) => !excludeCreatorId || o.creatorId !== excludeCreatorId);
    return candidate ? candidate.orderNumber : pendingList[0].orderNumber;
  }

  const cleanNo = inputNo.trim().replace(/^#/, '');

  // 1. Direct KV lookup
  const direct = await env.KV_ORDERS.get(`ORDER_${cleanNo}`);
  if (direct) return cleanNo;

  // 2. Pending list exact match
  const pendingList = await getPendingOrdersList(env);
  const foundPending = pendingList.find((o) => o.orderNumber === cleanNo);
  if (foundPending) return foundPending.orderNumber;

    // 3. Fallback: Scan KV_ORDERS prefix removed for performance.
    return null;

  return null;
}

// ── User Profile, Transactions & Group Helpers ──

/**
 * Choose which of two duplicate player records supplies the balance.
 * Prefers the record with the newer `updatedAt`; falls back to the existing
 * value when timestamps are missing or equal.
 */
function pickNewerBalance(existing: any, incoming: any): number {
  const existingBal = Number(existing?.balance) || 0;
  const incomingBal = Number(incoming?.balance) || 0;
  const hasIncoming = incoming?.balance !== undefined && !Number.isNaN(Number(incoming.balance));
  if (!hasIncoming) return existingBal;

  const existingAt = Number(existing?.updatedAt) || 0;
  const incomingAt = Number(incoming?.updatedAt) || 0;
  // No comparable timestamps on either side: keep prior behaviour (incoming wins).
  if (!existingAt || !incomingAt || incomingAt >= existingAt) return incomingBal;
  return existingBal;
}

export function deduplicatePlayers(list: any[]): any[] {
  if (!Array.isArray(list)) return [];
  const map = new Map<string, any>();

  for (const p of list) {
    if (!p) continue;
    const lineId = (p.lineUserId && String(p.lineUserId).trim().startsWith('U')) ? String(p.lineUserId).trim() : '';
    const shortId = (p.shortId && String(p.shortId).trim().startsWith('PL')) ? String(p.shortId).trim() :
                    (p.id && String(p.id).trim().startsWith('PL')) ? String(p.id).trim() : '';

    // Find if this player already exists under lineId, shortId, or id
    let existingKey: string | null = null;
    for (const [k, item] of map.entries()) {
      const matchLine = lineId && item.lineUserId && item.lineUserId === lineId;
      const matchShort = shortId && (item.shortId === shortId || item.id === shortId);
      const matchId = (p.id && (item.id === p.id || item.shortId === p.id));
      if (matchLine || matchShort || matchId) {
        existingKey = k;
        break;
      }
    }

    const primaryKey = lineId || shortId || p.id || (p.displayName || p.name);
    if (!primaryKey) continue;

    if (existingKey) {
      const existing = map.get(existingKey);
      // Merge records: preserve all non-empty fields, prioritize highest balance or newest
      const merged = {
        ...existing,
        ...p,
        id: shortId || existing.shortId || existing.id || primaryKey,
        shortId: shortId || existing.shortId || existing.id || primaryKey,
        lineUserId: lineId || existing.lineUserId || '',
        name: p.displayName || p.name || existing.displayName || existing.name || 'ผู้เล่น',
        displayName: p.displayName || p.name || existing.displayName || existing.name || 'ผู้เล่น',
        // Balance: the NEWER record wins, not merely the later one in the array.
        // syncWithSheets appends Google Sheets rows after the live KV rows, and
        // that Sheets mirror is written on a throttle, so "last in array" used
        // to let a stale sheet row overwrite the authoritative live balance —
        // making the Admin Console briefly show an old number after an approval.
        balance: pickNewerBalance(existing, p),
        bankName: p.bankName || existing.bankName || '',
        accountNumber: p.accountNumber || p.bankAccount || existing.accountNumber || existing.bankAccount || '',
        bankAccount: p.bankAccount || p.accountNumber || existing.bankAccount || existing.accountNumber || '',
        accountName: p.accountName || existing.accountName || p.displayName || p.name || '',
        registeredAt: existing.registeredAt || p.registeredAt || Date.now(),
        updatedAt: Math.max(existing.updatedAt || 0, p.updatedAt || 0, Date.now()),
      };
      map.set(existingKey, merged);
    } else {
      map.set(primaryKey, {
        ...p,
        id: shortId || p.id || primaryKey,
        shortId: shortId || p.id || primaryKey,
        lineUserId: lineId || p.lineUserId || '',
        name: p.displayName || p.name || 'ผู้เล่น',
        displayName: p.displayName || p.name || 'ผู้เล่น',
        balance: Number(p.balance) || 0,
        bankName: p.bankName || '',
        accountNumber: p.accountNumber || p.bankAccount || '',
        bankAccount: p.bankAccount || p.accountNumber || '',
        accountName: p.accountName || p.displayName || p.name || '',
        registeredAt: p.registeredAt || Date.now(),
        updatedAt: p.updatedAt || Date.now(),
      });
    }
  }
  return Array.from(map.values());
}

export async function getPlayersList(env: Env): Promise<any[]> {
  try {
    const cached = await state(env).get('PLAYERS_LIST');
    let list: any[] = [];
    if (cached) {
      try { list = JSON.parse(cached); } catch (_) {}
    }

    let needsWriteBack = false;
    if (!list || list.length === 0) {
      const scanRes = await state(env).list({ prefix: 'USER_' });
      if (scanRes.keys && scanRes.keys.length > 0) {
        const promises = scanRes.keys.map(k => state(env).get(k.name));
        const raws = await Promise.all(promises);
        list = raws.filter(Boolean).map(r => JSON.parse(r!) as PlayerProfile);
        needsWriteBack = true;
      }
    }

    const dedupedList = deduplicatePlayers(list);
    if (needsWriteBack || dedupedList.length !== list.length) {
      await state(env).put('PLAYERS_LIST', JSON.stringify(dedupedList.slice(-500)));
    }

    const avatars = ['🐉', '🐯', '🦅', '🦁', '🐻', '🐼', '🦊', '🦉'];
    return dedupedList.map((p, idx) => ({
      id: p.shortId || p.id || p.lineUserId,
      shortId: p.shortId || p.id,
      name: p.displayName || p.name || 'ผู้เล่น',
      displayName: p.displayName || p.name || 'ผู้เล่น',
      balance: Number(p.balance) || 0,
      joinDate: p.registeredAt ? new Date(p.registeredAt).toLocaleDateString('th-TH') : '-',
      bankName: p.bankName || '',
      bankAccount: p.accountNumber || p.bankAccount || '',
      accountName: p.accountName || p.displayName || p.name || '',
      isUser: false,
      avatar: avatars[idx % avatars.length],
      lineUserId: p.lineUserId || '',
    }));
  } catch (err) {
    console.error('[Worker] getPlayersList error:', err);
    return [];
  }
}

export async function savePlayerProfile(profile: PlayerProfile, env: Env, ctx?: ExecutionContext): Promise<void> {
  try {
    profile.updatedAt = Date.now();
    const profileJson = JSON.stringify(profile);

    const entry = {
      id: profile.shortId || profile.lineUserId,
      name: profile.displayName || 'ผู้เล่น',
      displayName: profile.displayName || 'ผู้เล่น',
      shortId: profile.shortId,
      lineUserId: profile.lineUserId,
      balance: Number(profile.balance) || 0,
      bankName: profile.bankName || '',
      accountNumber: profile.accountNumber || '',
      bankAccount: profile.accountNumber || '',
      accountName: profile.accountName || profile.displayName || '',
      registeredAt: profile.registeredAt || Date.now(),
      updatedAt: profile.updatedAt,
    };

    // Preferred path: commit USER_* + RAW_LINE_* + PLAYERS_LIST together.
    //
    // This single atomic step is the fix for the two platforms disagreeing.
    // It used to be four separate read-modify-write rounds, so a deposit from
    // LINE OA and an approval from the Admin Console could interleave: the
    // Admin Console read PLAYERS_LIST mid-flight and cached a stale balance,
    // leaving the console and the OA showing different numbers.
    const savedAtomically = await state(env).saveProfile(profile, entry);
    if (!savedAtomically) {
      // Fallback (Durable Object unavailable): original best-effort behaviour.
      const primaryPuts: Promise<any>[] = [];
      if (profile.lineUserId && profile.lineUserId.startsWith('U')) {
        primaryPuts.push(state(env).put(`USER_${profile.lineUserId}`, profileJson));
      }
      if (profile.shortId) {
        primaryPuts.push(state(env).put(`USER_${profile.shortId}`, profileJson));
        if (profile.lineUserId && profile.lineUserId.startsWith('U')) {
          primaryPuts.push(state(env).put(`RAW_LINE_${profile.shortId}`, profile.lineUserId));
        }
      }
      await Promise.all(primaryPuts);

      let list: any[] = [];
      const cached = await state(env).get('PLAYERS_LIST');
      if (cached) {
        try { list = JSON.parse(cached); } catch (_) {}
      }
      const updatedList = deduplicatePlayers([...list, entry]);
      await state(env).put('PLAYERS_LIST', JSON.stringify(updatedList.slice(-500)));
    }

    // Offload sync to Google Sheets in background — throttled to 1 write/min/user
    if (env.GAS_FALLBACK_URL && profile.lineUserId) {
      const gasUrl = env.GAS_FALLBACK_URL;
      const runGasSync = async () => {
        if (!(await isGasSyncThrottled('SAVE', profile.lineUserId, env))) {
          await fetch(gasUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              functionName: 'adminSetPlayerBalance',
              args: [profile.lineUserId, profile.balance, profile.displayName, true],
              apiKey: env.ADMIN_API_KEY,
            }),
          }).catch((e) => console.warn('[Worker] Sheets player balance sync error:', e));
        }
      };
      if (ctx) {
        ctx.waitUntil(runGasSync());
      } else {
        runGasSync().catch(() => {});
      }
    }
  } catch (err) {
    console.error('[Worker] savePlayerProfile error:', err);
  }
}

/**
 * Per-user GAS sync throttle. Google Sheets is a reporting mirror, not the live
 * ledger — the Live platform never reads it for authoritative state, so the hot
 * path is kept off slow (1-6s) GAS round-trips.
 *
 * Window reduced from 60s to 10s. Sheets was previously up to a full minute
 * behind, and `syncWithSheets` merges those rows into the dashboard, so an admin
 * reading the console shortly after an approval could see the pre-approval
 * figure. 10s keeps the mirror current enough to be a faithful audit trail
 * while still absorbing the burst traffic of a betting round.
 *
 * Fail-open by design: if the throttle check itself errors, prefer syncing.
 */
const GAS_SYNC_THROTTLE_SECONDS = 10;

async function isGasSyncThrottled(scope: string, userId: string, env: Env): Promise<boolean> {
  try {
    const key = `GAS_SYNC_${scope}_${userId}`;
    if (await state(env).get(key)) return true;
    await state(env).put(key, '1', { expirationTtl: GAS_SYNC_THROTTLE_SECONDS });
    return false;
  } catch (_) {
    return false;
  }
}

export async function getTransactionsList(env: Env): Promise<Transaction[]> {
  try {
    const cached = await state(env).get('TRANSACTIONS_LIST');
    if (cached) {
      return JSON.parse(cached);
    }
    return [];
  } catch (err) {
    console.error('[Worker] getTransactionsList error:', err);
    return [];
  }
}

/**
 * Record an inbound user message into the CHAT_LOGS dashboard feed.
 * Previously the ONLY chat-log writer was the admin-send path in index.ts —
 * inbound LINE user messages were never logged anywhere, leaving the admin
 * conversation monitor permanently blind under the queue architecture.
 * Mirrors appendChatLog() in index.ts (admin sender) with sender: 'user'.
 */
export async function logUserMessage(
  env: Env,
  log: { timestamp: string; userId: string; displayName: string; sender: string; text: string; type: string }
): Promise<void> {
  try {
    const stored = await state(env).appendChatLog(log);
    if (!stored) {
      const raw = await state(env).get('CHAT_LOGS');
      const logs = raw ? JSON.parse(raw) : [];
      logs.push(log);
      await state(env).put('CHAT_LOGS', JSON.stringify(logs.slice(-100)));
    }
  } catch (err) {
    console.warn('[logUserMessage Error]:', err);
  }
}

export async function addTransaction(tx: Transaction, env: Env, ctx?: ExecutionContext): Promise<void> {
  try {
    // Atomic upsert — a deposit/withdrawal arriving from LINE OA can never be
    // clobbered by a concurrent Admin Console approval on the same ledger.
    const stored = await state(env).upsertTransaction(tx);
    if (!stored) {
      const list = await getTransactionsList(env);
      const updated = [tx, ...list.filter(t => t.id !== tx.id)].slice(0, 100);
      await state(env).put('TRANSACTIONS_LIST', JSON.stringify(updated));
    }

    if (env.GAS_FALLBACK_URL) {
      const syncPromise = fetch(env.GAS_FALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          functionName: 'logTransaction',
          args: [
            tx.playerId,
            tx.playerName,
            tx.requestedAmount,
            tx.actualAmount,
            tx.id,
            tx.status,
            tx.reviewReason,
          ],
          apiKey: env.ADMIN_API_KEY,
        }),
      }).catch((e) => console.warn('[Worker] Sheets tx sync error:', e));
      if (ctx) ctx.waitUntil(syncPromise);
    }
  } catch (err) {
    console.error('[Worker] addTransaction error:', err);
  }
}

export async function getOrCreatePlayerProfile(userId: string, env: Env, ctx?: ExecutionContext): Promise<PlayerProfile> {
  const cacheKey = `USER_${userId}`;
  const shortId = `PL${userId.slice(-6).toUpperCase()}`;

  // 1. Check direct user key and shortId key in parallel
  const [cachedUser, cachedShort] = await Promise.all([
    state(env).get(cacheKey),
    state(env).get(`USER_${shortId}`),
  ]);

  let profile = cachedUser ? (JSON.parse(cachedUser) as PlayerProfile) : null;
  let shortProfile = cachedShort ? (JSON.parse(cachedShort) as PlayerProfile) : null;

  // Cross-reconcile direct user key and shortId key:
  // If one key has a newer updatedAt or higher balance, prioritize the authoritative update
  if (profile || shortProfile) {
    if (!profile) {
      profile = shortProfile!;
    } else if (shortProfile) {
      const shortUpdated = Number(shortProfile.updatedAt) || 0;
      const userUpdated = Number(profile.updatedAt) || 0;
      const shortBal = Number(shortProfile.balance) || 0;
      const userBal = Number(profile.balance) || 0;

      if (shortBal > userBal || shortUpdated > userUpdated) {
        profile = { ...profile, ...shortProfile, lineUserId: userId, shortId, balance: Math.max(shortBal, userBal) };
        // Self-heal direct user cache key immediately
        const healedJson = JSON.stringify(profile);
        if (ctx) {
          ctx.waitUntil(state(env).put(cacheKey, healedJson).catch(() => {}));
        } else {
          state(env).put(cacheKey, healedJson).catch(() => {});
        }
      }
    }

    if (!profile.shortId) profile.shortId = shortId;
    if (!profile.lineUserId) profile.lineUserId = userId;
    return profile;
  }

  // 2. Fallback to PLAYERS_LIST only if profile not yet in direct KV
  let playersListEntry: any = null;
  try {
    const listRaw = await state(env).get('PLAYERS_LIST');
    if (listRaw) {
      const list = JSON.parse(listRaw) as any[];
      playersListEntry = list.find((p: any) => p.lineUserId === userId || p.shortId === shortId || p.id === shortId || p.id === userId) || null;
    }
  } catch (_) {}

  if (playersListEntry) {
    const restoredProfile: PlayerProfile = {
      shortId,
      lineUserId: userId,
      displayName: playersListEntry.name || playersListEntry.displayName || 'ผู้เล่น',
      balance: Number(playersListEntry.balance) || 0,
      bankName: playersListEntry.bankName || '',
      accountNumber: playersListEntry.bankAccount || playersListEntry.accountNumber || '',
      accountName: playersListEntry.accountName || playersListEntry.displayName || playersListEntry.name || 'ผู้เล่น',
      updatedAt: Number(playersListEntry.updatedAt) || Date.now(),
      registeredAt: Number(playersListEntry.registeredAt) || Date.now(),
    };
    await state(env).put(cacheKey, JSON.stringify(restoredProfile));
    await state(env).put(`USER_${shortId}`, JSON.stringify(restoredProfile));
    await state(env).put(`RAW_LINE_${shortId}`, userId);
    return restoredProfile;
  }

  // 3. Truly new player: initialize immediately with fast fallback name (0ms blocking latency!)
  const displayName = `ผู้เล่น #${shortId.slice(-4)}`;
  const newProfile: PlayerProfile = {
    shortId,
    lineUserId: userId,
    displayName,
    balance: 0,
    registeredAt: Date.now(),
    updatedAt: Date.now(),
  };

  await savePlayerProfile(newProfile, env, ctx);

  // Background fetch of real LINE profile name so user is not blocked on 1500ms HTTP call
  if (env.LINE_CHANNEL_ACCESS_TOKEN) {
    const fetchLineProfileTask = async () => {
      try {
        const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
          headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data?.displayName && data.displayName !== displayName) {
            newProfile.displayName = data.displayName;
            await savePlayerProfile(newProfile, env, ctx);
          }
        }
      } catch (_) {}
    };
    if (ctx) {
      ctx.waitUntil(fetchLineProfileTask());
    } else {
      fetchLineProfileTask().catch(() => {});
    }
  }

  return newProfile;
}


async function recordActiveGroup(groupId: string, env: Env): Promise<void> {
  if (!groupId || typeof groupId !== 'string') return;
  const gid = groupId.trim();
  // Valid LINE Group ID starts with 'C' (or room 'R') followed by 32 hex characters
  if (!/^[CR][0-9a-f]{32}$/i.test(gid)) return;

  await state(env).put('ACTIVE_GROUP_ID', gid);
  const existing = await state(env).get(`GROUP_${gid}`);
  if (!existing) {
    await state(env).put(`GROUP_${gid}`, JSON.stringify({
      id: gid,
      firstSeen: Date.now(),
      lastActive: Date.now(),
    }));
  }

  // Ensure group is listed in LINE_GROUPS for discovery and multi-group broadcast
  try {
    const lineGroupsRaw = await state(env).get('LINE_GROUPS');
    let lineGroups = lineGroupsRaw ? JSON.parse(lineGroupsRaw) : [];
    if (!Array.isArray(lineGroups)) lineGroups = [];
    if (!lineGroups.some((g: any) => g.id === groupId)) {
      lineGroups.push({
        id: groupId,
        name: `🚀 กลุ่มดวลสด (#${groupId.slice(-4)})`,
        lastMessage: '',
        timestamp: 'Live',
      });
      await state(env).put('LINE_GROUPS', JSON.stringify(lineGroups));
    }
  } catch (_) {}
}

// ── LINE HTTP Dispatchers ──

async function replyToLine(replyToken: string, payload: any, env: Env, attachQuickReply = false): Promise<boolean> {
  try {
    const processed = attachQuickReply ? attachMainMenuQuickReply(payload) : stripQuickReply(payload);
    let messageObj: any;
    if (typeof processed === 'string') {
      messageObj = { type: 'text', text: processed };
    } else if (processed && processed.type === 'flex') {
      messageObj = processed;
    } else if (processed && (processed.type === 'bubble' || processed.type === 'carousel')) {
      const altText = processed.header?.contents?.[0]?.text || processed.altText || '🚀 Rocket Science';
      messageObj = { type: 'flex', altText, contents: processed };
    } else if (processed && processed.type === 'text') {
      messageObj = processed;
    } else {
      messageObj = { type: 'text', text: String(processed) };
    }

    if (attachQuickReply) {
      if (!messageObj.quickReply || !Array.isArray(messageObj.quickReply.items) || messageObj.quickReply.items.length === 0) {
        messageObj.quickReply = { items: MAIN_MENU_QUICK_REPLY_ITEMS };
      }
    } else {
      // Explicitly delete quickReply if attachQuickReply is false (e.g. Group messages)
      delete messageObj.quickReply;
    }

    const messages = [messageObj];
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[LINE Reply Error] status=${res.status}: ${errBody}`);
      try {
        await state(env).put('LAST_LINE_ERROR', JSON.stringify({
          action: 'replyToLine',
          status: res.status,
          error: errBody,
          replyToken,
          time: new Date().toISOString()
        }));
      } catch (_) {}
      return false;
    }
    try {
      state(env).put('LAST_LINE_SUCCESS', JSON.stringify({
        action: 'replyToLine',
        status: res.status,
        time: new Date().toISOString()
      })).catch(() => {});
    } catch (_) {}
    return true;
  } catch (err: any) {
    console.error('[LINE Reply Exception]:', err?.message || err);
    try {
      await state(env).put('LAST_LINE_ERROR', JSON.stringify({
        action: 'replyToLine',
        status: 'exception',
        error: err?.message || String(err),
        time: new Date().toISOString()
      }));
    } catch (_) {}
    return false;
  }
}

export async function pushToLine(to: string, payload: any, env: Env): Promise<{ success: boolean; code?: number; error?: string }> {
  try {
    const isUserDM = !!(to && to.startsWith('U'));
    const processed = isUserDM ? attachMainMenuQuickReply(payload) : stripQuickReply(payload);
    let messageObj: any;
    if (typeof processed === 'string') {
      messageObj = { type: 'text', text: processed };
    } else if (processed && processed.type === 'flex') {
      messageObj = processed;
    } else if (processed && (processed.type === 'bubble' || processed.type === 'carousel')) {
      const altText = processed.header?.contents?.[0]?.text || processed.altText || '🚀 Rocket Science';
      messageObj = { type: 'flex', altText, contents: processed };
    } else if (processed && processed.type === 'text') {
      messageObj = processed;
    } else {
      messageObj = { type: 'text', text: String(processed) };
    }

    if (isUserDM) {
      if (!messageObj.quickReply || !Array.isArray(messageObj.quickReply.items) || messageObj.quickReply.items.length === 0) {
        messageObj.quickReply = { items: MAIN_MENU_QUICK_REPLY_ITEMS };
      }
    } else {
      // Groups (C...) and Rooms (R...) must NEVER carry floating Quick Reply menus
      delete messageObj.quickReply;
    }

    const messages = [messageObj];
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to, messages }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[LINE Push Error] to=${to} status=${res.status}: ${errBody}`);
      try {
        await state(env).put('LAST_LINE_ERROR', JSON.stringify({
          action: 'pushToLine',
          to,
          status: res.status,
          error: errBody,
          time: new Date().toISOString()
        }));
      } catch (_) {}
      if (res.status === 429 || errBody.includes('monthly limit')) {
        return {
          success: false,
          code: 429,
          error: 'โควต้าส่งข้อความของบัญชี LINE OA ประจำเดือนนี้เต็มแล้ว (300/300 ข้อความ) กรุณาอัปเกรดแพ็กเกจเป็น Basic/Pro ที่ manager.line.biz ครับ',
        };
      }
      if (res.status === 400 && (errBody.includes('Failed to send messages') || errBody.includes('Bad Request'))) {
        return {
          success: false,
          code: 400,
          error: `บอท LINE OA ไม่ได้อยู่ในกลุ่มเป้าหมาย (${to.slice(-6)}) หรือยังไม่ได้เชิญบอทเข้ากลุ่มนี้`,
        };
      }
      return {
        success: false,
        code: res.status,
        error: `LINE API Error (HTTP ${res.status}): ${errBody}`,
      };
    }
    try {
      await state(env).put('LAST_LINE_SUCCESS', JSON.stringify({
        action: 'pushToLine',
        to,
        status: res.status,
        time: new Date().toISOString()
      }));
    } catch (_) {}
    return { success: true, code: 200 };
  } catch (err: any) {
    console.error(`[LINE Push Exception] to=${to}:`, err?.message || err);
    try {
      await state(env).put('LAST_LINE_ERROR', JSON.stringify({
        action: 'pushToLine',
        to,
        status: 'exception',
        error: err?.message || String(err),
        time: new Date().toISOString()
      }));
    } catch (_) {}
    return { success: false, error: err?.message || 'Network exception' };
  }
}

async function deliverPrivateNotice(
  userId: string,
  replyToken: string | undefined,
  groupId: string | null,
  payload: any,
  env: Env,
  displayName?: string,
  ctx?: ExecutionContext
): Promise<void> {
  // Resolve raw LINE userId if PL-shortId was passed
  let targetLineId = userId;
  if (userId && userId.startsWith('PL')) {
    const raw = await state(env).get(`RAW_LINE_${userId}`);
    if (raw) targetLineId = raw;
  }

  // ── 1. If in 1-on-1 private chat with LINE OA (DM) ──
  if (!groupId) {
    const enriched = attachMainMenuQuickReply(payload);
    let replyOk = false;
    if (replyToken) {
      replyOk = await replyToLine(replyToken, enriched, env, true);
    }
    if (!replyOk && targetLineId && targetLineId.startsWith('U')) {
      const res = await pushToLine(targetLineId, enriched, env);
      replyOk = !!(res && res.success);
    }
    try {
      await state(env).put('LAST_DELIVERY_DEBUG', JSON.stringify({
        userId,
        targetLineId,
        hasReplyToken: !!replyToken,
        replyOk,
        payloadType: typeof payload === 'object' ? payload?.type : 'primitive',
        altText: payload?.altText || '',
        time: new Date().toISOString()
      }));
    } catch (_) {}
    return;
  }

  // ── 2. If interaction originated in a LINE Group ──
  // STRICT USER RULE: Any private-related message must ONLY be responded in DM.
  // The LINE Group is reserved exclusively for order matching cards only.
  // Never broadcast personal balance, private notices, cancellations, or error messages into the group.
  if (targetLineId && targetLineId.startsWith('U')) {
    const enriched = attachMainMenuQuickReply(payload);
    const dmPush = pushToLine(targetLineId, enriched, env);
    if (ctx) {
      ctx.waitUntil(dmPush);
    } else {
      dmPush.catch((e) => console.error('[deliverPrivateNotice DM push error]:', e));
    }
  }
}

export async function addToSettledOrdersList(order: Order, env: Env): Promise<void> {
  try {
    const list = await getSettledOrdersList(env);
    const updated = [order, ...list.filter((o) => o.orderNumber !== order.orderNumber)].slice(0, 100);
    await state(env).put('SETTLED_ORDERS_LIST', JSON.stringify(updated));
  } catch (err) {
    console.error('[Worker] addToSettledOrdersList error:', err);
  }
}

export async function getSettledOrdersList(env: Env): Promise<Order[]> {
  try {
    const cached = await state(env).get('SETTLED_ORDERS_LIST');
    return cached ? JSON.parse(cached) : [];
  } catch (err) {
    console.error('[Worker] getSettledOrdersList error:', err);
    return [];
  }
}
