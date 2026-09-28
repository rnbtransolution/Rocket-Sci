import { Env, LineEvent, Order, PlayerProfile, RocketRound, Transaction } from './types.js';
import { createCoordinatorClient } from './financial/client.js';
import {
  CoordinatorError,
  wholePointsToHundredths,
  type LedgerAccount,
  type LedgerOrder,
} from './financial/types.js';
import {
  generateOrderFlex,
  generateMatchNotificationFlex,
  generateMatchMismatchFlex,
  generateBalanceFlex,
  generatePendingBoardFlex,
  generateRuleGuideFlex,
  generateMainMenuQuickReply,
  attachMainMenuQuickReply,
  stripQuickReply,
  MAIN_MENU_QUICK_REPLY_ITEMS,
  generateDepositFlex,
  generateDepositInvoiceFlex,
  generateWithdrawalFlex,
  generateBankRegistrationFlex,
} from './flexTemplates.js';

function lineEventIdempotencyKey(event: LineEvent, operation: string): string {
  const sourceId = event.source?.userId || event.source?.groupId || event.source?.roomId || 'unknown';
  const eventId = event.webhookEventId
    || event.message?.id
    || `${sourceId}:${event.timestamp}:${event.type}:${event.postback?.data || ''}`;
  return `line:${operation}:${eventId}`;
}

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
 * Cloudflare Worker Queue & Background Event Processor
 * Executes all order validation, atomic balance locking, and LINE API calls with sub-second latency.
 */
export async function processLineEvent(event: LineEvent, env: Env, ctx?: ExecutionContext): Promise<void> {
  if (event.webhookEventId) {
    try {
      if (await env.KV_CACHE.get(`EVT_${event.webhookEventId}`)) return;
    } catch (error) {
      console.warn('[Worker] Webhook dedup lookup failed; coordinator idempotency remains active', error);
    }
  }
  await processLineEventBody(event, env, ctx);
  if (event.webhookEventId) {
    try {
      await env.KV_CACHE.put(`EVT_${event.webhookEventId}`, '1', { expirationTtl: 120 });
    } catch (error) {
      console.warn('[Worker] Webhook dedup marker write failed', error);
    }
  }
}

async function processLineEventBody(event: LineEvent, env: Env, ctx?: ExecutionContext): Promise<void> {
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
    let displayName = 'ผู้เล่น';
    try {
      const cached = await env.KV_CACHE.get(`USER_${userId}`);
      if (cached) displayName = JSON.parse(cached).displayName || displayName;
    } catch (_) {}
    ctx?.waitUntil(logUserMessage(env, {
      timestamp: evtTime,
      userId,
      displayName,
      sender: 'user',
      text: displayText || '[empty]',
      type: msgType,
    }));
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
        await replyToLine(replyToken, `🆔 LINE Group ID: ${groupId}`, env, false);
      } else {
        await replyToLine(replyToken, '⚠️ คำสั่งนี้ใช้งานได้เฉพาะในกลุ่ม LINE เท่านั้น', env, true);
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
      await deliverPrivateNotice(userId, replyToken, groupId, balanceFlex, env, profile.displayName);
      return;
    }

    // ── 1.1 Main Menu ("เมนู", "เมนูหลัก", "menu", "เริ่ม", "start", "ช่วยเหลือ", "help") ──
    const menuKeywords = ['เมนู', 'เมนูหลัก', 'menu', 'เริ่ม', 'start', 'ช่วยเหลือ', 'help'];
    if (menuKeywords.includes(clean)) {
      if (isGroup) {
        await deliverPrivateNotice(
          userId,
          replyToken,
          groupId,
          '💡 [เมนูระบบดวลส่วนตัว]\nเมนูเช็คยอด เติมเงิน ถอนเงิน สามารถกดทักแชตตรงหา LINE OA เพื่อใช้งานได้ทันทีครับ 🚀\nสำหรับในกลุ่มนี้ พิมพ์ "กระดานดวล" เพื่อดูแผลค้างครับ',
          env
        );
      } else {
        const menuPayload = generateMainMenuQuickReply(profile.displayName, profile.balance);
        await deliverPrivateNotice(userId, replyToken, groupId, menuPayload, env);
      }
      return;
    }

    // ── 1.2 Deposit Intent ("ฝากเงิน", "เติมเงิน", "deposit", "เติมเครดิต", "ฝาก") ──
    const depositKeywords = ['ฝากเงิน', 'เติมเงิน', 'deposit', 'เติมเครดิต', 'ฝาก'];
    if (depositKeywords.includes(clean)) {
      const depositFlex = generateDepositFlex();
      await deliverPrivateNotice(userId, replyToken, groupId, depositFlex, env);
      return;
    }

    // ── 1.3 Deposit Amount Request (in 1-on-1 private chat: e.g. "1000", "1,000", "ฝาก 1000", "ฝาก 1,000 บาท") ──
    const cleanWithoutCommas = clean.replace(/,/g, '');
    const pureNumRegex = /^(\d+)\s*(?:บาท|thb|pt)?$/i;
    const depositTextRegex = /^(?:ฝาก|ฝากเงิน|เติม|เติมเงิน)\s*(\d+)\s*(?:บาท|thb|pt)?$/i;
    let depositAmt: number | null = null;
    if (!isGroup && pureNumRegex.test(cleanWithoutCommas)) {
      const match = cleanWithoutCommas.match(pureNumRegex)!;
      depositAmt = parseInt(match[1], 10);
    } else if (depositTextRegex.test(cleanWithoutCommas)) {
      const match = cleanWithoutCommas.match(depositTextRegex)!;
      depositAmt = parseInt(match[1], 10);
    }

    if (depositAmt !== null) {
      if (depositAmt < 100 || depositAmt > 50000) {
        await deliverPrivateNotice(userId, replyToken, groupId, '⚠️ ยอดฝากขั้นต่ำ 100 บาท สูงสุด 50,000 บาทครับ', env);
        return;
      }
      const idempotencyKey = lineEventIdempotencyKey(event, 'request-deposit');
      const txId = `TX-${idempotencyKey}`;
      await createCoordinatorClient(env).requestDeposit({
        idempotencyKey,
        transactionId: txId,
        playerId: profile.shortId,
        amountHundredths: wholePointsToHundredths(depositAmt, 'deposit amount'),
      });
      const invoiceFlex = generateDepositInvoiceFlex(depositAmt);
      await deliverPrivateNotice(userId, replyToken, groupId, invoiceFlex, env);
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
      await deliverPrivateNotice(
        userId,
        replyToken,
        groupId,
        `✅ บันทึกข้อมูลบัญชีธนาคารเรียบร้อยแล้วครับ!\n🏦 ธนาคาร: ${profile.bankName}\n🔢 เลขบัญชี: ${profile.accountNumber}\n👤 ชื่อ: ${profile.accountName}\n\nท่านสามารถพิมพ์ "ถอน [จำนวน]" เพื่อแจ้งถอนได้ทันทีครับ 💸`,
        env
      );
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
        await deliverPrivateNotice(userId, replyToken, groupId, withdrawFlex, env);
      } else {
        const bankRegFlex = generateBankRegistrationFlex();
        await deliverPrivateNotice(userId, replyToken, groupId, bankRegFlex, env);
      }
      return;
    }

    // ── 1.6 Withdrawal Execution ("ถอน 500", "ถอน 1,000", "ถอน 500 บาท") ──
    const withdrawAmtRegex = /^(?:ถอน|ถอนเงิน|ถอนยอด)\s*(\d+)\s*(?:บาท|thb|pt)?$/i;
    if (withdrawAmtRegex.test(cleanWithoutCommas)) {
      const match = cleanWithoutCommas.match(withdrawAmtRegex)!;
      const withdrawAmt = parseInt(match[1], 10);
      if (withdrawAmt < 100) {
        await deliverPrivateNotice(userId, replyToken, groupId, '⚠️ ยอดถอนขั้นต่ำ 100 pt ครับ', env);
        return;
      }
      if (!profile.bankName || !profile.accountNumber) {
        await deliverPrivateNotice(
          userId,
          replyToken,
          groupId,
          '❌ ท่านยังไม่ได้ลงทะเบียนบัญชีรับเงิน กรุณาพิมพ์:\nบัญชี [ธนาคาร] [เลขบัญชี] [ชื่อ-สกุล]\nเช่น บัญชี กสิกร 0123456789 สมชาย ใจดี',
          env
        );
        return;
      }

      const idempotencyKey = lineEventIdempotencyKey(event, 'request-withdrawal');
      const txId = `WD-${idempotencyKey}`;
      const coordinator = createCoordinatorClient(env);
      try {
        await coordinator.requestWithdrawal({
          idempotencyKey,
          transactionId: txId,
          playerId: profile.shortId,
          amountHundredths: wholePointsToHundredths(withdrawAmt, 'withdrawal amount'),
          bankName: profile.bankName,
          accountNumber: profile.accountNumber,
          accountName: profile.accountName || profile.displayName,
        });
      } catch (error) {
        if (!(error instanceof CoordinatorError)) throw error;
        const currentBalance = (await coordinator.getAccount(profile.shortId))?.balanceHundredths || 0;
        const message = error.code === 'INSUFFICIENT_FUNDS'
          ? `⚠️ แต้มคงเหลือไม่พอครับ (มี ${currentBalance / 100} pt ต้องการถอน ${withdrawAmt} pt)`
          : error.message;
        await deliverPrivateNotice(userId, replyToken, groupId, message, env);
        return;
      }
      const updatedAccount = await coordinator.getAccount(profile.shortId);
      profile.balance = (updatedAccount?.balanceHundredths || 0) / 100;

      await deliverPrivateNotice(
        userId,
        replyToken,
        groupId,
        `💸 ส่งคำขอถอนเงิน ${withdrawAmt.toLocaleString()} pt เรียบร้อยแล้วครับ!\nเข้าบัญชี: ${profile.bankName} ${profile.accountNumber} (${profile.accountName || profile.displayName})\nแต้มคงเหลือ: ${profile.balance.toLocaleString()} pt\nแอดมินกำลังดำเนินการโอนเงินให้ครับ 🙏`,
        env
      );
      return;
    }

    // ── 1.1 Live Betting Board ("กระดานดวล", "แผลค้าง", "เปิดรอคู่", "รอคู่", "กระดาน", "board") ──
    const boardRegex = /^(?:📊\s*)?(กระดานดวล|แผลค้าง|เปิดรอคู่|รอคู่|กระดาน|board)$/i;
    if (boardRegex.test(clean) || boardRegex.test(text)) {
      const pendingList = await getPendingOrdersList(env);
      const openMatches = pendingList.filter((o) => o && o.status === 'pending_match');
      const boardFlex = generatePendingBoardFlex(openMatches);
      // Strictly deliver board to private message to keep group chat quiet and clean
      await deliverPrivateNotice(userId, replyToken, groupId, boardFlex, env);
      return;
    }

    // ── 1.2 Rule Guide ("กติกา", "rule", "rules", "วิธีเล่น", "คู่มือ") ──
    const ruleRegex = /^(?:📖\s*)?(กติกา|rule|rules|วิธีเล่น|คู่มือ)$/i;
    if (ruleRegex.test(clean) || ruleRegex.test(text)) {
      const ruleFlex = generateRuleGuideFlex();
      await deliverPrivateNotice(userId, replyToken, groupId, ruleFlex, env);
      return;
    }

    // ── 1.3 Admin/System Command: Clear Board & Cache ("ล้างกระดาน", "เคลียร์แผล", "ล้างแคช", "clearboard") ──
    const clearRegex = /^(?:🧹\s*)?(ล้างกระดาน|เคลียร์กระดาน|ล้างแผล|เคลียร์แผล|ล้างแคช|เคลียร์แคช|clearboard|resetboard|clearcache)$/i;
    if (clearRegex.test(clean) || clearRegex.test(text)) {
      const res = await clearAllPendingOrders(env);
      const msg = `🧹 ล้างกระดานดวลสดและเคลียร์แคชเรียบร้อยแล้วครับ! (ลบทั้งหมด ${res.cleared} รายการ, กระดานว่าง 0 แผล)`;
      if (replyToken) {
        await replyToLine(replyToken, msg, env, !isGroup);
      } else {
        await pushToLine(userId, msg, env);
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
          await deliverPrivateNotice(
            userId,
            replyToken,
            groupId,
            '⚠️ ไม่พบแผลดวลค้างของคุณที่สามารถยกเลิกได้ครับ\n(หรือพิมพ์ "ยกเลิก [เลข Order]" เช่น "ยกเลิก 518947")',
            env
          );
          return;
        }
      }

      const cancelRes = await cancelOrder(
        targetNo,
        profile,
        lineEventIdempotencyKey(event, 'cancel-order'),
        env,
      );
      await deliverPrivateNotice(userId, replyToken, groupId, cancelRes.message, env);
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
          const exists = await createCoordinatorClient(env).getOrder(numStr);
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

      await handleMatchOrder(
        targetOrderNo,
        matchAmt,
        profile,
        userId,
        groupId,
        replyToken,
        lineEventIdempotencyKey(event, 'match-order'),
        env,
        ctx,
      );
      return;
    }

    // ── 4. Order Creation Formulas (e.g. "ล500", "ชล500", "ถ1000", "330-380ล500") ──
    const betRegex = /^(?:([+-]?\d+)?\s*)?(ชล|ชถ|ชย|ชต|ย|ถ|ล|สูง|ต่ำ|ยั่ง|ถอย|ไล่)\s*(\d+)(?:\s*(?:pt|แต้ม))?$/i;
    const rangeBetRegex = /^(\d+)[-/](\d+)(ชล|ชถ|ชย|ชต|ย|ถ|ล|สูง|ต่ำ)\s*(\d+)?$/i;

    if (betRegex.test(text) || rangeBetRegex.test(text)) {
      if (!isGroup) {
        await deliverPrivateNotice(
          userId,
          replyToken,
          null,
          '⚠️ การเปิดแผลดวลสามารถทำได้เฉพาะในกลุ่ม LINE เท่านั้นครับ 🚀\n(กรุณาส่งคำสั่งเปิดแผลในกลุ่มดวลครับ)',
          env
        );
        return;
      }

      await handleCreateOrder(
        text,
        betRegex,
        rangeBetRegex,
        profile,
        userId,
        groupId,
        replyToken,
        lineEventIdempotencyKey(event, 'create-order'),
        env,
      );
      return;
    }

    // ── 5. Admin Commands (e.g. "เปิด [ชื่อ]", "ปิดรอบ") ──
    const openRoundRegex = /^(เปิด|เปิดรอบ|รอบ)\s*(.+)$/;
    if (openRoundRegex.test(text)) {
      const match = text.match(openRoundRegex);
      const roundName = match ? match[2].trim() : 'รอบดวลสด';
      const idempotencyKey = lineEventIdempotencyKey(event, 'open-round');
      const openedRound = await createCoordinatorClient(env).openRound({
        idempotencyKey,
        roundId: `round-${idempotencyKey}`,
        name: roundName,
      });
      await Promise.all([
        getPendingOrdersList(env),
        getMatchedOrdersList(env),
      ]);
      await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify({
        roundId: openedRound.roundId,
        name: roundName,
        targetMin: 330,
        targetMax: 380,
        status: 'ACTIVE',
        isChotoy: false,
        quoteReleased: false,
        updatedAt: Date.now(),
      }));
      if (replyToken) {
        await replyToLine(replyToken, `🚀 เปิดรอบดวล: ${roundName} (ราคาช่าง 330-380s) เรียบร้อยครับ`, env, !isGroup);
      }
      return;
    }

    if (clean === 'ปิดรอบ' || clean === 'ปิดรับดวล' || clean === 'ล็อครอบ' || clean === '3-2-go' || clean === '32go') {
      const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
      let roundName = 'รอบดวลสด';
      if (roundStr) {
        const round = JSON.parse(roundStr) as RocketRound;
        if (!round.roundId) throw new Error('Active round is missing its coordinator ID');
        await createCoordinatorClient(env).closeRound({
          idempotencyKey: lineEventIdempotencyKey(event, 'close-round'),
          roundId: round.roundId,
        });
        round.status = 'CLOSED';
        roundName = round.name;
        await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));
      }
      await getPendingOrdersList(env);
      if (replyToken) {
        await replyToLine(replyToken, `⛔ ปิดรับดวลรอบ ${roundName} เรียบร้อยแล้วครับ! (ล้างกระดานรอคู่เรียบร้อย 0 แผล)`, env, !isGroup);
      } else {
        await pushToLine(userId, `⛔ ปิดรับดวลรอบ ${roundName} เรียบร้อยแล้วครับ! (ล้างกระดานรอคู่เรียบร้อย 0 แผล)`, env);
      }
      return;
    }

    // ── Fallback for Unrecognized Private Messages ──
    if (!isGroup) {
      const fallbackMsg = `🤖 ได้รับข้อความแล้วครับ 💬\nท่านสามารถแตะเลือกทำรายการ เช็คยอด, ฝากเงิน, ถอนเงิน หรือกติกาจากปุ่มด้านล่างได้ทันทีครับ 👇`;
      await deliverPrivateNotice(userId, replyToken, null, fallbackMsg, env);
      return;
    }
  }

  // ── Follow Event (User Adds or Unblocks Bot) ──
  if (event.type === 'follow' && userId) {
    const profile = await getOrCreatePlayerProfile(userId, env, ctx);
    const welcomeMsg = `🚀 ยินดีต้อนรับคุณ ${profile.displayName} สู่ระบบดวล Rocket Science!\n\nท่านสามารถแตะเมนูด้านล่างเพื่อ เช็คยอด, ฝากเงิน, ถอนเงิน หรือดูกติกาได้ตลอดเวลาครับ 👇`;
    await deliverPrivateNotice(userId, event.replyToken, null, welcomeMsg, env);
    return;
  }

  // ── Image Message Handler (Slip Upload) ──
  if (event.type === 'message' && event.message?.type === 'image' && userId) {
    const profile = await getOrCreatePlayerProfile(userId, env, ctx);
    const replyToken = event.replyToken;
    const idempotencyKey = lineEventIdempotencyKey(event, 'request-deposit-slip');
    const txId = `TX-${idempotencyKey}`;
    await createCoordinatorClient(env).requestDeposit({
      idempotencyKey,
      transactionId: txId,
      playerId: profile.shortId,
      amountHundredths: wholePointsToHundredths(1000, 'deposit amount'),
    });
    await env.KV_CACHE.put(`TX_META_${txId}`, JSON.stringify({ slipRef: event.message.id }));
    const msg = `✅ ได้รับรูปสลิปโอนเงินเรียบร้อยแล้วครับ! (รหัสรายการ: #${txId})\nระบบได้ส่งให้แอดมินตรวจสอบยอดเงินเข้าบัญชีเรียบร้อย เมื่อตรวจสอบสำเร็จแต้มจะเข้าทันทีครับ 🙏`;
    await deliverPrivateNotice(userId, replyToken, groupId, msg, env);
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
      await handleMatchOrder(
        orderNo,
        amount || undefined,
        profile,
        userId,
        groupId,
        event.replyToken,
        lineEventIdempotencyKey(event, 'match-order'),
        env,
        ctx,
      );
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
  groupId: string,
  replyToken: string | undefined,
  idempotencyKey: string,
  env: Env,
): Promise<void> {
  let side: 'low' | 'high' = 'low';
  let amount = 500;
  let rangeMin = 330;
  let rangeMax = 380;
  let isCustom = false;
  let offsetDelta = 0;

  // Check if round is closed
  const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
  const round = roundStr ? (JSON.parse(roundStr) as RocketRound) : null;
  if (round && round.status !== 'ACTIVE') {
    await deliverPrivateNotice(userId, replyToken, groupId, '⛔ ปิดรับออเดอร์แล้ว⛔️\nกรุณารอรอบถัดไปครับ', env);
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
    amount = parseInt(match[3], 10) || 500;
    if (match && match[1]) {
      const rawOffset = match[1].replace('+', '');
      offsetDelta = parseInt(rawOffset, 10) || 0;
      if (![5, -5, 10, -10].includes(offsetDelta)) {
        await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ การปรับราคาช่างรองรับเฉพาะ +/-5 และ +/-10 วินาทีเท่านั้นครับ (เช่น +5ชล, -5ชถ, +10ชล, -10ชถ)`, env);
        return;
      }
    }
  }

  if (amount < 50 || amount > 50000) {
    await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ ยอดดวลต้องอยู่ระหว่าง 50 ถึง 50,000 pt ครับ (คุณระบุ ${amount} pt)`, env);
    return;
  }

  if (isCustom) {
    if (rangeMin >= rangeMax) {
      await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ ระบุช่วงเวลาจากต่ำไปสูงเท่านั้นครับ เช่น 300-350 (คุณระบุ ${rangeMin}-${rangeMax})`, env);
      return;
    }
    if (rangeMax - rangeMin > 50) {
      const diff = rangeMax - rangeMin;
      await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ ช่วงราคาต้องห่างกันไม่เกิน 50 วินาทีครับ (คุณระบุ ${rangeMin}-${rangeMax} ห่าง ${diff} วิ)`, env);
      return;
    }
  }

  const coordinator = createCoordinatorClient(env);
  const account = await coordinator.getAccount(profile.shortId);
  if (!account) throw new Error(`Financial account ${profile.shortId} is missing`);
  profile.balance = account.balanceHundredths / 100;
  if (profile.balance < amount) {
    const needed = amount - profile.balance;
    const msg = `⚠️ แต้มไม่พอครับ (มี ${profile.balance.toLocaleString()} pt | ขาด ${needed.toLocaleString()} pt)\n💡 พิมพ์ "ฝากเงิน" ในแชตนี้เพื่อเติมเครดิตได้เลยครับ 🚀`;
    await deliverPrivateNotice(userId, replyToken, groupId, msg, env);
    return;
  }

  if (!round?.roundId) {
    await deliverPrivateNotice(userId, replyToken, groupId, '⛔ ยังไม่มีรอบดวลที่เปิดรับคำสั่งครับ กรุณารอแอดมินเปิดรอบใหม่', env);
    return;
  }

  const quoteReleased = !!(round && round.quoteReleased === true);
  const isPreQuote = !isCustom && !quoteReleased;
  let orderRecord: LedgerOrder;
  try {
    orderRecord = await coordinator.createOrder({
      idempotencyKey,
      roundId: round.roundId,
      creatorId: profile.shortId,
      creatorName: profile.displayName,
      side,
      stakeHundredths: wholePointsToHundredths(amount, 'stake'),
      betType: isPreQuote ? 'pre_quote' : isCustom ? 'custom_range' : 'range',
      rangeMin: isPreQuote ? offsetDelta : isCustom ? rangeMin : (round.targetMin + offsetDelta),
      rangeMax: isPreQuote ? offsetDelta : isCustom ? rangeMax : (round.targetMax + offsetDelta),
      rangeOffset: isPreQuote ? offsetDelta : 0,
      groupId,
    });
  } catch (error) {
    if (!(error instanceof CoordinatorError)) throw error;
    const currentBalance = (await coordinator.getAccount(profile.shortId))?.balanceHundredths || 0;
    const message = error.code === 'INSUFFICIENT_FUNDS'
      ? `⚠️ แต้มไม่พอครับ (มี ${(currentBalance / 100).toLocaleString()} pt | ต้องการ ${amount.toLocaleString()} pt)`
      : error.message;
    await deliverPrivateNotice(userId, replyToken, groupId, message, env);
    return;
  }
  const newOrder: Order = {
    ...await mapCoordinatorOrder(orderRecord, env),
    creatorLineUserId: profile.lineUserId,
    userTypedCmd: text,
    rocketName: round.name,
    offset: isPreQuote ? offsetDelta : undefined,
  };
  await env.KV_ORDERS.put(`ORDER_${newOrder.orderNumber}`, JSON.stringify(newOrder));
  await addToPendingOrdersList(newOrder, env);

  // 6. Send Order Flex to Group Chat
  const flexCard = generateOrderFlex(newOrder);
  let cardDispatched = false;
  if (replyToken) {
    cardDispatched = await replyToLine(replyToken, flexCard, env, false);
  }
  if (!cardDispatched && groupId) {
    await pushToLine(groupId, flexCard, env);
  }

  if (isPreQuote) {
    await deliverPrivateNotice(userId, replyToken, groupId, `⏳ Order #${newOrder.orderNumber} ถูกถืออยู่รอราคาช่างครับ (จำนวน ${amount.toLocaleString()} pt)\nเมื่อแอดมินเปิดราคาช่างอย่างเป็นทางการ ระบบจะจับคู่ดวลให้อัตโนมัติครับ 🚀`, env);
  }
}

async function handleMatchOrder(
  orderNo: string | undefined,
  matchAmt: number | undefined,
  profile: PlayerProfile,
  userId: string,
  groupId: string | null,
  replyToken: string | undefined,
  idempotencyKey: string,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  const resolvedNo = await resolveOrderNumber(orderNo, profile.shortId, env);
  if (!resolvedNo) {
    const errorMsg = orderNo
      ? `ไม่พบแผล Order #${orderNo} ในระบบครับ`
      : 'ขณะนี้ไม่มีแผลที่เปิดรอคู่ในระบบครับ 🚀\n(ท่านสามารถพิมพ์ ชล หรือ ชถ ในกลุ่มดวล เพื่อเปิดแผลใหม่ได้ครับ)';
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(orderNo, errorMsg, 'พิมพ์ "ต <เลข order>" เพื่อรับแผลที่ยังว่างอยู่ครับ'), env);
    return;
  }

  const coordinator = createCoordinatorClient(env);
  const orderRecord = await coordinator.getOrder(resolvedNo);
  if (!orderRecord) {
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, `ไม่พบแผล Order #${resolvedNo} ในระบบครับ`, 'พิมพ์ "ต <เลข order>" เพื่อลองรับแผลอื่นครับ'), env);
    return;
  }

  const order = await mapCoordinatorOrder(orderRecord, env);
  if (order.status !== 'pending_match') {
    const reason = order.status === 'matched' ? 'แผลนี้มีคู่ดวลแล้วครับ' : 'แผลนี้ถูกยกเลิกไปแล้วครับ';
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, reason, 'พิมพ์ "กระดานดวล" เพื่อดูแผลที่ยังว่างอยู่ครับ'), env);
    return;
  }

  if (order.creatorId === profile.shortId) {
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, 'คุณไม่สามารถรับแผลดวลของตัวเองได้ครับ', 'เลือกแผลของผู้เล่นอื่นเพื่อเปิดการดวลครับ'), env);
    return;
  }

  const effectiveAmt = matchAmt ?? order.amount;
  let committedOrder: LedgerOrder;
  try {
    committedOrder = await coordinator.matchOrder({
      idempotencyKey,
      orderNumber: resolvedNo,
      matcherId: profile.shortId,
      matcherName: profile.displayName,
      stakeHundredths: wholePointsToHundredths(effectiveAmt, 'stake'),
    });
  } catch (error) {
    if (!(error instanceof CoordinatorError)) throw error;
    const message = error.code === 'INSUFFICIENT_FUNDS'
      ? `แต้มไม่พอรับแผลครับ (ยอดคงเหลือปัจจุบัน ${((await coordinator.getAccount(profile.shortId))?.balanceHundredths || 0) / 100} pt)`
      : error.code === 'STAKE_MISMATCH'
        ? `ยอดรับแผลต้องเท่ากับ ${order.amount.toLocaleString()} pt ครับ`
        : error.message;
    await deliverPrivateNotice(
      userId,
      replyToken,
      groupId,
      generateMatchMismatchFlex(resolvedNo, message, 'พิมพ์ "กระดานดวล" เพื่อดูแผลที่ยังว่างอยู่ครับ'),
      env,
    );
    return;
  }
  const committed = await mapCoordinatorOrder(committedOrder, env);
  await env.KV_ORDERS.put(`ORDER_${resolvedNo}`, JSON.stringify(committed));
  await removeFromPendingOrdersList(resolvedNo, env);
  await addToMatchedOrdersList(committed, env);

  // Generate match card
  const matchFlex = generateMatchNotificationFlex(committed);

  // Match notification: reply to group if requested via group, and push to DM of both players
  const creatorLineId = committed.creatorLineUserId
    || (await env.KV_CACHE.get(`RAW_LINE_${committed.creatorId}`));
  const notifyPromises: Promise<unknown>[] = [
    pushToLine(userId, matchFlex, env),
  ];
  if (creatorLineId && creatorLineId !== userId) notifyPromises.push(pushToLine(creatorLineId, matchFlex, env));
  if (ctx) ctx.waitUntil(Promise.all(notifyPromises));
  else await Promise.all(notifyPromises);
}

async function cancelOrder(
  orderNo: string,
  profile: PlayerProfile,
  idempotencyKey: string,
  env: Env,
): Promise<{ success: boolean; message: string }> {
  const resolvedNo = await resolveOrderNumber(orderNo, null, env);
  if (!resolvedNo) return { success: false, message: `🚫 ไม่พบแผล Order #${orderNo}` };

  const coordinator = createCoordinatorClient(env);
  const orderRecord = await coordinator.getOrder(resolvedNo);
  if (!orderRecord) return { success: false, message: `🚫 ไม่พบแผล Order #${resolvedNo}` };
  const order = await mapCoordinatorOrder(orderRecord, env);
  if (order.creatorId !== profile.shortId) {
    return { success: false, message: '⚠️ คุณไม่ใช่เจ้าของแผลนี้ครับ' };
  }
  if (order.status !== 'pending_match' && order.status !== 'pending_hold') {
    return { success: false, message: `⚠️ แผล Order #${resolvedNo} อยู่ในสถานะ ${order.status} ไม่สามารถยกเลิกได้ครับ` };
  }

  let cancelled: LedgerOrder;
  try {
    cancelled = await coordinator.cancelOrder({
      idempotencyKey,
      orderNumber: resolvedNo,
      actorId: profile.shortId,
    });
  } catch (error) {
    if (!(error instanceof CoordinatorError)) throw error;
    return { success: false, message: `⚠️ ยกเลิก Order #${resolvedNo} ไม่สำเร็จ: ${error.message}` };
  }
  const updated = await mapCoordinatorOrder(cancelled, env);
  await env.KV_ORDERS.put(`ORDER_${resolvedNo}`, JSON.stringify(updated));
  await removeFromPendingOrdersList(resolvedNo, env);
  const account = await coordinator.getAccount(profile.shortId);
  const balance = (account?.balanceHundredths || 0) / 100;

  return {
    success: true,
    message: `✅ ยกเลิก Order #${resolvedNo} เรียบร้อยแล้วครับ!\n💰 คืนแต้ม: +${order.amount.toLocaleString()} pt\n💎 แต้มคงเหลือปัจจุบัน: ${balance.toLocaleString()} pt 🚀`,
  };
}

// ── Pending Orders & Lookup Helpers ──

/**
 * Cancels all unmatched pending orders from KV_CACHE and KV_ORDERS and refunds creators.
 * Preserves matched orders waiting for flight time settlement.
 */
export async function clearAllPendingOrders(env: Env, ctx?: ExecutionContext): Promise<{ cleared: number }> {
  const coordinator = createCoordinatorClient(env);
  const pending = await coordinator.getOrdersByStatus(['pending_match', 'pending_hold']);
  let clearedCount = 0;
  const cancelledOrders: LedgerOrder[] = [];
  for (const order of pending) {
    try {
      await coordinator.cancelOrder({
        idempotencyKey: `clear-pending:${order.orderNumber}`,
        orderNumber: order.orderNumber,
        actorId: order.creatorId,
      });
      const cancelled = await coordinator.getOrder(order.orderNumber);
      if (cancelled) cancelledOrders.push(cancelled);
      clearedCount++;
    } catch (error) {
      if (!(error instanceof CoordinatorError) || error.code !== 'INVALID_STATE') throw error;
    }
  }
  const mappedCancelledOrders = await mapCoordinatorOrders(cancelledOrders, env);
  await Promise.all(mappedCancelledOrders.map((order) =>
    env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order))
  ));
  await getPendingOrdersList(env);
  return { cleared: clearedCount };
}

/**
 * Persists the official quote in the coordinator before updating projections and notifying players.
 */
export async function releaseHeldPreQuoteOrders(
  roundId: string,
  idempotencyKey: string,
  minVal: number,
  maxVal: number,
  env: Env,
  ctx?: ExecutionContext,
): Promise<{ converted: number; matched: number }> {
  const released = await createCoordinatorClient(env).releaseQuote({
    idempotencyKey,
    roundId,
    targetMin: minVal,
    targetMax: maxVal,
  });
  const matched = await autoMatchPendingPairs(env, ctx);
  await getPendingOrdersList(env);
  await getMatchedOrdersList(env);
  const releasedOrders = await Promise.all(released.releasedOrderNumbers.map(async (orderNo) => {
    const ledgerOrder = await createCoordinatorClient(env).getOrder(orderNo);
    if (!ledgerOrder) throw new Error(`Released order ${orderNo} is missing from the coordinator`);
    return ledgerOrder;
  }));
  const convertedOrders = await mapCoordinatorOrders(releasedOrders, env);
  await Promise.all(convertedOrders.map((order) =>
    env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order))
  ));
  const notifications = convertedOrders.map(async (order) => {
    const rawLine = order.creatorLineUserId
      || (await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`))
      || order.creatorId;
    return deliverPrivateNotice(
      rawLine,
      undefined,
      order.groupId || null,
      order.status === 'matched'
        ? `✅ ราคาช่างอย่างเป็นทางการแล้ว: ${order.rangeMin}-${order.rangeMax} วิ\n🧾 Order #${order.orderNumber} มีคู่ดวลแล้วครับ 🚀`
        : `✅ ราคาช่างอย่างเป็นทางการแล้ว: ${order.rangeMin}-${order.rangeMax} วิ\n🧾 Order #${order.orderNumber} (${order.amount.toLocaleString()} pt ${order.side === 'low' ? 'ชถ/ต่ำ' : 'ชล/สูง'}) เปิดรอคู่แล้ว พร้อมจับคู่ครับ 🚀`,
      env,
      order.creatorName,
    );
  });
  if (ctx) ctx.waitUntil(Promise.all(notifications));
  else await Promise.all(notifications);
  return { converted: released.releasedOrderNumbers.length, matched };
}

export async function autoMatchPendingPairs(env: Env, ctx?: ExecutionContext): Promise<number> {
  const coordinator = createCoordinatorClient(env);
  const pending = await coordinator.getOrdersByStatus(['pending_match']);
  const groups = new Map<string, LedgerOrder[]>();
  for (const order of pending) {
    const key = `${order.roundId}:${order.stakeHundredths}`;
    const group = groups.get(key) || [];
    group.push(order);
    groups.set(key, group);
  }

  let matchedCount = 0;
  for (const group of groups.values()) {
    const lows = group.filter((order) => order.side === 'low').sort((a, b) => a.createdAt - b.createdAt);
    const availableHighs = group
      .filter((order) => order.side === 'high')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const low of lows) {
      const highIndex = availableHighs.findIndex((order) => order.creatorId !== low.creatorId);
      if (highIndex < 0) continue;
      const [high] = availableHighs.splice(highIndex, 1);
      let primary: LedgerOrder;
      try {
        primary = await coordinator.autoMatchOrders({
          idempotencyKey: `auto-match:${low.orderNumber}:${high.orderNumber}`,
          orderNumber: low.orderNumber,
          counterpartOrderNumber: high.orderNumber,
        });
      } catch (error) {
        if (
          error instanceof CoordinatorError &&
          (error.code === 'INVALID_STATE' || error.code === 'STAKE_MISMATCH')
        ) continue;
        throw error;
      }
      const counterpart = await coordinator.getOrder(high.orderNumber);
      if (!counterpart) throw new Error(`Auto-matched counterpart ${high.orderNumber} is missing`);
      const [primaryOrder, counterpartOrder] = await mapCoordinatorOrders([primary, counterpart], env);
      await Promise.all([
        env.KV_ORDERS.put(`ORDER_${low.orderNumber}`, JSON.stringify(primaryOrder)),
        env.KV_ORDERS.put(`ORDER_${high.orderNumber}`, JSON.stringify(counterpartOrder)),
      ]);
      const flex = generateMatchNotificationFlex(primaryOrder);
      const lowLine = primaryOrder.creatorLineUserId || low.creatorId;
      const highLine = counterpartOrder.creatorLineUserId || high.creatorId;
      const notifications = [
        pushToLine(lowLine, flex, env),
        pushToLine(highLine, flex, env),
      ];
      if (ctx) ctx.waitUntil(Promise.all(notifications));
      else await Promise.all(notifications);
      matchedCount++;
    }
  }
  await Promise.all([getPendingOrdersList(env), getMatchedOrdersList(env)]);
  return matchedCount;
}

/**
 * Voids the active round through the coordinator and refreshes order projections.
 */
export async function voidAllRoundOrders(env: Env, ctx?: ExecutionContext): Promise<{ voided: number }> {
  const rawRound = await env.KV_CACHE.get('ACTIVE_ROUND');
  if (!rawRound) return { voided: 0 };
  const round = JSON.parse(rawRound) as RocketRound;
  if (!round.roundId) throw new Error('Active round is missing its coordinator ID');
  const before = await createCoordinatorClient(env).getOrdersByStatus([
    'pending_hold',
    'pending_match',
    'matched',
  ]);
  const roundOrders = before.filter((order) => order.roundId === round.roundId);
  const result = await createCoordinatorClient(env).voidRound({
    idempotencyKey: `void-round:${round.roundId}`,
    roundId: round.roundId,
  });
  round.status = 'CLOSED';
  round.updatedAt = Date.now();
  await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));
  const refundedOrders = await Promise.all(result.refundedOrderNumbers.map(async (orderNo) => {
    const order = await createCoordinatorClient(env).getOrder(orderNo);
    return order;
  }));
  const mappedRefundedOrders = await mapCoordinatorOrders(
    refundedOrders.filter((order): order is LedgerOrder => order !== null),
    env,
  );
  await Promise.all(mappedRefundedOrders.map((order) =>
    env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order))
  ));
  await Promise.all([
    getPendingOrdersList(env),
    getMatchedOrdersList(env),
  ]);
  return { voided: Math.min(roundOrders.length, refundedOrders.length) };
}

export async function getPendingOrdersList(env: Env): Promise<Order[]> {
  const client = createCoordinatorClient(env);
  const orders = await client.getOrdersByStatus(['pending_match', 'pending_hold']);
  const mapped = await mapCoordinatorOrders(orders, env);
  await writeOrderProjection(env, 'PENDING_ORDERS_LIST', orders);
  return mapped;
}

export async function addToPendingOrdersList(order: Order, env: Env): Promise<void> {
  await refreshOrderProjection(env, 'PENDING_ORDERS_LIST', ['pending_match', 'pending_hold']);
}

async function removeFromPendingOrdersList(orderNo: string, env: Env): Promise<void> {
  const cleanNo = orderNo.trim().replace(/^#/, '');
  const client = createCoordinatorClient(env);
  const orders = await client.getOrdersByStatus(['pending_match', 'pending_hold']);
  await writeOrderProjection(env, 'PENDING_ORDERS_LIST', orders.filter((order) => order.orderNumber !== cleanNo));
}

export async function addToMatchedOrdersList(order: Order, env: Env): Promise<void> {
  await refreshOrderProjection(env, 'MATCHED_ORDERS_LIST', ['matched']);
}

export async function removeFromMatchedOrdersList(orderNo: string, env: Env): Promise<void> {
  const cleanNo = orderNo.trim().replace(/^#/, '');
  const client = createCoordinatorClient(env);
  const orders = await client.getOrdersByStatus(['matched']);
  await writeOrderProjection(env, 'MATCHED_ORDERS_LIST', orders.filter((order) => order.orderNumber !== cleanNo));
}

export async function getMatchedOrdersList(env: Env): Promise<Order[]> {
  const client = createCoordinatorClient(env);
  const orders = await client.getOrdersByStatus(['matched']);
  const mapped = await mapCoordinatorOrders(orders, env);
  await writeOrderProjection(env, 'MATCHED_ORDERS_LIST', orders);
  return mapped;
}

async function getSettledCoordinatorOrders(env: Env): Promise<LedgerOrder[]> {
  return createCoordinatorClient(env).getOrdersByStatus(['settled']);
}

async function refreshOrderProjection(
  env: Env,
  key: 'PENDING_ORDERS_LIST' | 'MATCHED_ORDERS_LIST' | 'SETTLED_ORDERS_LIST',
  statuses: LedgerOrder['status'][],
): Promise<void> {
  const orders = await createCoordinatorClient(env).getOrdersByStatus(statuses);
  await writeOrderProjection(env, key, orders);
}

async function writeOrderProjection(
  env: Env,
  key: 'PENDING_ORDERS_LIST' | 'MATCHED_ORDERS_LIST' | 'SETTLED_ORDERS_LIST',
  orders: LedgerOrder[],
): Promise<void> {
  try {
    await env.KV_CACHE.put(key, JSON.stringify(orders.slice(0, 250).map((order) => order.orderNumber)), {
      expirationTtl: 30 * 24 * 60 * 60,
    });
  } catch (error) {
    console.error(`[Worker] Failed to update ${key} projection after coordinator commit`, error);
  }
}

export async function mapCoordinatorOrder(order: LedgerOrder, env: Env): Promise<Order> {
  return (await mapCoordinatorOrders([order], env))[0];
}

export async function mapCoordinatorOrders(orders: LedgerOrder[], env: Env): Promise<Order[]> {
  if (orders.length === 0) return [];
  const playerIds = [...new Set(orders.flatMap((order) =>
    order.matcherId ? [order.creatorId, order.matcherId] : [order.creatorId]
  ))];
  const coordinator = createCoordinatorClient(env);
  const accountPages = await Promise.all(
    Array.from({ length: Math.ceil(playerIds.length / 500) }, (_, page) =>
      coordinator.getAccounts(playerIds.slice(page * 500, (page + 1) * 500))
    ),
  );
  const accounts = new Map(accountPages.flat().map((account) => [account.playerId, account]));
  return orders.map((order) => {
    const creator = accounts.get(order.creatorId);
    const winnerName = order.winnerSide === 'draw' || !order.winnerSide
      ? '-'
      : (order.winnerSide === order.side ? order.creatorName : order.matcherName) || '-';
    return {
      orderNumber: order.orderNumber,
      creatorId: order.creatorId,
      creatorName: order.creatorName,
      creatorLineUserId: creator?.lineUserId ?? undefined,
      matcherId: order.matcherId,
      matcherName: order.matcherName,
      side: order.side,
      amount: order.stakeHundredths / 100,
      betType: order.betType,
      rangeMin: order.rangeMin,
      rangeMax: order.rangeMax,
      offset: order.rangeOffset,
      status: order.status,
      groupId: order.groupId,
      createdAt: order.createdAt,
      matchedAt: order.matchedAt,
      winnerSide: order.winnerSide ?? undefined,
      winnerName,
      finalTime: order.finalSeconds,
      settledAt: order.settledAt ?? undefined,
    };
  });
}

async function resolveOrderNumber(
  inputNo: string | undefined | null,
  excludeCreatorId: string | null,
  env: Env
): Promise<string | null> {
  const client = createCoordinatorClient(env);
  if (!inputNo || inputNo.trim() === '') {
    const pendingList = await client.getOrdersByStatus(['pending_match']);
    if (pendingList.length === 0) return null;
    const candidate = pendingList.find((o) => !excludeCreatorId || o.creatorId !== excludeCreatorId);
    return (candidate || pendingList[0]).orderNumber;
  }

  const cleanNo = inputNo.trim().replace(/^#/, '');
  return await client.getOrder(cleanNo) ? cleanNo : null;
}

// ── User Profile, Transactions & Group Helpers ──

export async function getPlayersList(env: Env): Promise<any[]> {
  const snapshot = await createCoordinatorClient(env).getSnapshot();
  const avatars = ['🐉', '🐯', '🦅', '🦁', '🐻', '🐼', '🦊', '🦉'];
  const players = snapshot.accounts.filter((account) => account.kind === 'player' && account.active);
  return await Promise.all(players.map(async (account, idx) => {
    const cached = account.lineUserId
      ? await env.KV_CACHE.get(`USER_${account.lineUserId}`)
      : null;
    const profile = cached ? JSON.parse(cached) as PlayerProfile : null;
    return {
      id: account.playerId,
      name: profile?.displayName || account.displayName || 'ผู้เล่น',
      balance: account.balanceHundredths / 100,
      joinDate: profile?.registeredAt
        ? new Date(profile.registeredAt).toLocaleDateString('th-TH')
        : '-',
      bankName: profile?.bankName || '',
      bankAccount: profile?.accountNumber || '',
      accountName: profile?.accountName || profile?.displayName || account.displayName,
      isUser: false,
      avatar: avatars[idx % avatars.length],
      lineUserId: account.lineUserId || '',
    };
  }));
}

export async function savePlayerProfile(profile: PlayerProfile, env: Env, ctx?: ExecutionContext): Promise<void> {
  const account = await createCoordinatorClient(env).getAccount(profile.shortId);
  if (!account) {
    throw new Error(`Cannot save metadata for unknown financial account ${profile.shortId}`);
  }
  const metadata: PlayerProfile = {
    ...profile,
    balance: account.balanceHundredths / 100,
    updatedAt: Date.now(),
  };
  await env.KV_CACHE.put(`USER_${profile.lineUserId}`, JSON.stringify(metadata));
  if (profile.shortId) {
    await env.KV_CACHE.put(`RAW_LINE_${profile.shortId}`, profile.lineUserId);
  }
}

export async function getTransactionsList(env: Env): Promise<Transaction[]> {
  const snapshot = await createCoordinatorClient(env).getSnapshot();
  const transactions = await Promise.all(snapshot.transactions.map(async (transaction): Promise<Transaction> => {
    const metadata = await env.KV_CACHE.get(`TX_META_${transaction.transactionId}`);
    const profile = metadata ? JSON.parse(metadata) as { slipRef?: string } : null;
    return {
      id: transaction.transactionId,
      playerId: transaction.playerId,
      playerName: snapshot.accounts.find((account) => account.playerId === transaction.playerId)?.displayName || '',
      requestedAmount: transaction.requestedAmountHundredths / 100,
      actualAmount: (transaction.actualAmountHundredths ?? 0) / 100,
      slipRef: profile?.slipRef || '',
      status: transaction.status === 'pending'
        ? 'escalated'
        : transaction.status === 'approved'
          ? 'success'
          : 'rejected',
      reviewReason: transaction.reason || undefined,
      timestamp: new Date(transaction.createdAt).toLocaleTimeString('th-TH', { hour12: false }),
      type: transaction.type === 'withdrawal' ? 'withdraw' : 'deposit',
      createdAt: transaction.createdAt,
    };
  }));
  return transactions.sort((left, right) => right.createdAt - left.createdAt);
}

/** Record an inbound user message into the dashboard chat feed. */
export async function logUserMessage(
  env: Env,
  log: { timestamp: string; userId: string; displayName: string; sender: string; text: string; type: string }
): Promise<void> {
  try {
    const raw = await env.KV_CACHE.get('CHAT_LOGS');
    const logs = raw ? JSON.parse(raw) : [];
    logs.push(log);
    await env.KV_CACHE.put('CHAT_LOGS', JSON.stringify(logs.slice(-100)));
  } catch (err) {
    console.warn('[logUserMessage Error]:', err);
  }
}

export async function getOrCreatePlayerProfile(userId: string, env: Env, ctx?: ExecutionContext): Promise<PlayerProfile> {
  const cacheKey = `USER_${userId}`;
  const coordinator = createCoordinatorClient(env);
  const cached = await env.KV_CACHE.get(cacheKey);
  const cachedProfile = cached ? JSON.parse(cached) as PlayerProfile : null;
  const proposedShortId = cachedProfile?.shortId || `PL${userId.slice(-6).toUpperCase()}`;
  const existingAccount = await coordinator.getAccount(proposedShortId)
    || await coordinator.getAccountByLineUserId(userId);
  const shortId = existingAccount?.playerId || proposedShortId;
  if (existingAccount) {
    const profile: PlayerProfile = {
      ...(cachedProfile || {}),
      shortId,
      lineUserId: userId,
      displayName: cachedProfile?.displayName || existingAccount.displayName,
      balance: existingAccount.balanceHundredths / 100,
      registeredAt: cachedProfile?.registeredAt || existingAccount.createdAt,
      updatedAt: existingAccount.updatedAt,
    };
    await env.KV_CACHE.put(cacheKey, JSON.stringify(profile));
    await env.KV_CACHE.put(`RAW_LINE_${shortId}`, userId);
    return profile;
  }

  // Fetch LINE user display name via Messaging API
  let displayName = cachedProfile?.displayName || 'ผู้เล่น';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data?.displayName) displayName = data.displayName;
    }
  } catch (_) {}

  const newProfile: PlayerProfile = {
    shortId,
    lineUserId: userId,
    displayName,
    balance: 0,
    registeredAt: Date.now(),
    updatedAt: Date.now(),
  };

  const account = await coordinator.createPlayer({
    idempotencyKey: `line-register:${userId}`,
    playerId: shortId,
    lineUserId: userId,
    displayName,
    openingBalanceHundredths: 0,
  });
  newProfile.balance = account.balanceHundredths / 100;
  await env.KV_CACHE.put(cacheKey, JSON.stringify(newProfile));
  await env.KV_CACHE.put(`RAW_LINE_${shortId}`, userId);
  return newProfile;
}


async function recordActiveGroup(groupId: string, env: Env): Promise<void> {
  if (!groupId || typeof groupId !== 'string') return;
  const gid = groupId.trim();
  // Valid LINE Group ID starts with 'C' (or room 'R') followed by 32 hex characters
  if (!/^[CR][0-9a-f]{32}$/i.test(gid)) return;

  await env.KV_CACHE.put('ACTIVE_GROUP_ID', gid);
  const existing = await env.KV_CACHE.get(`GROUP_${gid}`);
  if (!existing) {
    await env.KV_CACHE.put(`GROUP_${gid}`, JSON.stringify({
      id: gid,
      firstSeen: Date.now(),
      lastActive: Date.now(),
    }));
  }

  // Ensure group is listed in LINE_GROUPS for discovery and multi-group broadcast
  try {
    const lineGroupsRaw = await env.KV_CACHE.get('LINE_GROUPS');
    let lineGroups = lineGroupsRaw ? JSON.parse(lineGroupsRaw) : [];
    if (!Array.isArray(lineGroups)) lineGroups = [];
    if (!lineGroups.some((g: any) => g.id === groupId)) {
      lineGroups.push({
        id: groupId,
        name: `🚀 กลุ่มดวลสด (#${groupId.slice(-4)})`,
        lastMessage: '',
        timestamp: 'Live',
      });
      await env.KV_CACHE.put('LINE_GROUPS', JSON.stringify(lineGroups));
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
        await env.KV_CACHE.put('LAST_LINE_ERROR', JSON.stringify({
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
      await env.KV_CACHE.put('LAST_LINE_SUCCESS', JSON.stringify({
        action: 'replyToLine',
        status: res.status,
        time: new Date().toISOString()
      }));
    } catch (_) {}
    return true;
  } catch (err: any) {
    console.error('[LINE Reply Exception]:', err?.message || err);
    try {
      await env.KV_CACHE.put('LAST_LINE_ERROR', JSON.stringify({
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
        await env.KV_CACHE.put('LAST_LINE_ERROR', JSON.stringify({
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
      await env.KV_CACHE.put('LAST_LINE_SUCCESS', JSON.stringify({
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
      await env.KV_CACHE.put('LAST_LINE_ERROR', JSON.stringify({
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
  displayName?: string
): Promise<void> {
  // Resolve raw LINE userId if PL-shortId was passed
  let targetLineId = userId;
  if (userId && userId.startsWith('PL')) {
    const raw = await env.KV_CACHE.get(`RAW_LINE_${userId}`);
    if (raw) targetLineId = raw;
  }

  // 1. If in 1-on-1 private chat with LINE OA:
  if (!groupId) {
    const enriched = attachMainMenuQuickReply(payload);
    let replyOk = false;
    if (replyToken) {
      replyOk = await replyToLine(replyToken, enriched, env, true);
    }
    let pushOk = false;
    if (!replyOk && targetLineId && targetLineId.startsWith('U')) {
      const res = await pushToLine(targetLineId, enriched, env);
      pushOk = !!(res && res.success);
    }
    try {
      await env.KV_CACHE.put('LAST_DELIVERY_DEBUG', JSON.stringify({
        userId,
        targetLineId,
        hasReplyToken: !!replyToken,
        replyOk,
        pushOk,
        payloadType: typeof payload === 'object' ? payload?.type : 'primitive',
        altText: payload?.altText || '',
        time: new Date().toISOString()
      }));
    } catch (_) {}
    return;
  }

  // 2. If interaction originated in a LINE Group:
  // Attempt private delivery via DM for players who have friended the bot
  let pushSuccess = false;
  if (targetLineId && targetLineId.startsWith('U')) {
    // pushToLine for 'U...' will automatically attachMainMenuQuickReply in the private DM
    const res = await pushToLine(targetLineId, payload, env);
    pushSuccess = !!(res && res.success);
  }

  // If DM push failed (e.g. user hasn't added the bot as friend) OR if replyToken is available:
  // Provide an instant inline response in the group so the bot is never silent.
  // CRITICAL: This response is delivered in the LINE GROUP, so quickReply MUST be stripped!
  if (!pushSuccess && replyToken) {
    let summaryText = typeof payload === 'string' ? payload : (payload.altText || payload.text || '⚠️ ไม่สามารถทำรายการได้ครับ');
    if (displayName) {
      summaryText = `📢 @${displayName}\n${summaryText}`;
    }
    await replyToLine(replyToken, stripQuickReply(summaryText), env, false);
  }
}

export async function addToSettledOrdersList(order: Order, env: Env): Promise<void> {
  await refreshOrderProjection(env, 'SETTLED_ORDERS_LIST', ['settled']);
}

export async function getSettledOrdersList(env: Env): Promise<Order[]> {
  const orders = await getSettledCoordinatorOrders(env);
  await writeOrderProjection(env, 'SETTLED_ORDERS_LIST', orders);
  return mapCoordinatorOrders(orders, env);
}
