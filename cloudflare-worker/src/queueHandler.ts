import { Env, LineEvent, Order, PlayerProfile, RocketRound, Transaction } from './types.js';
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
  // ── Cross-Path Dedup Guard ──
  // Every webhook event is processed inline (sub-100ms reply path) AND mirrored
  // to the Queue for the background consumer. Without this guard both paths
  // executed the full handler: double replies, double balance writes, double
  // order records. First executor wins (inline normally); the queue copy acks.
  if (event.webhookEventId) {
    const dedupKey = `EVT_${event.webhookEventId}`;
    try {
      if (await env.KV_CACHE.get(dedupKey)) return;
      await env.KV_CACHE.put(dedupKey, '1', { expirationTtl: 120 });
    } catch (_) { /* fail-open: prefer processing over dropping */ }
  }

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
      const txId = `TX${Math.floor(100000 + Math.random() * 900000)}`;
      const nowStr = new Date().toLocaleTimeString('th-TH', { hour12: false });
      const newTx: Transaction = {
        id: txId,
        playerId: profile.shortId,
        playerName: profile.displayName,
        requestedAmount: depositAmt,
        actualAmount: 0,
        slipRef: '',
        status: 'escalated',
        reviewReason: 'รอผู้ใช้แนบสลิปโอนเงิน',
        timestamp: nowStr,
        type: 'deposit',
        createdAt: Date.now(),
      };
      await addTransaction(newTx, env, ctx);
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
      if (profile.balance < withdrawAmt) {
        await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ แต้มคงเหลือไม่พอครับ (มี ${profile.balance} pt ต้องการถอน ${withdrawAmt} pt)`, env);
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

      profile.balance -= withdrawAmt;
      await savePlayerProfile(profile, env, ctx);

      const txId = `WD${Math.floor(100000 + Math.random() * 900000)}`;
      const nowStr = new Date().toLocaleTimeString('th-TH', { hour12: false });
      const newTx: Transaction = {
        id: txId,
        playerId: profile.shortId,
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

      const cancelRes = await cancelOrder(targetNo, profile, env, ctx);
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

      await handleCreateOrder(text, betRegex, rangeBetRegex, profile, userId, groupId, replyToken, env, ctx);
      return;
    }

    // ── 5. Admin Commands (e.g. "เปิด [ชื่อ]", "ปิดรอบ") ──
    const openRoundRegex = /^(เปิด|เปิดรอบ|รอบ)\s*(.+)$/;
    if (openRoundRegex.test(text)) {
      const match = text.match(openRoundRegex);
      const roundName = match ? match[2].trim() : 'รอบดวลสด';
      await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify({
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
        round.status = 'CLOSED';
        roundName = round.name;
        await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));
      }
      // Also clear pending unmatched orders so board resets cleanly for next round
      await clearAllPendingOrders(env);
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
    const txId = `TX${Math.floor(100000 + Math.random() * 900000)}`;
    const nowStr = new Date().toLocaleTimeString('th-TH', { hour12: false });
    const newTx: Transaction = {
      id: txId,
      playerId: profile.shortId,
      playerName: profile.displayName,
      requestedAmount: 1000,
      actualAmount: 0,
      slipRef: event.message.id,
      status: 'escalated',
      reviewReason: 'แนบรูปสลิปโอนเงิน - รอแอดมินตรวจสอบยอด',
      timestamp: nowStr,
      type: 'deposit',
      createdAt: Date.now(),
    };
    await addTransaction(newTx, env, ctx);
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
  groupId: string,
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

  // Check if round is closed
  const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
  const round = roundStr ? (JSON.parse(roundStr) as RocketRound) : null;
  if (round && round.status === 'CLOSED') {
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

  if (profile.balance < amount) {
    const needed = amount - profile.balance;
    const msg = `⚠️ แต้มไม่พอครับ (มี ${profile.balance.toLocaleString()} pt | ขาด ${needed.toLocaleString()} pt)\n💡 พิมพ์ "ฝากเงิน" ในแชตนี้เพื่อเติมเครดิตได้เลยครับ 🚀`;
    await deliverPrivateNotice(userId, replyToken, groupId, msg, env);
    return;
  }

  // 1. Determine if this is a pre-quote order
  const quoteReleased = !!(round && round.quoteReleased === true);
  const isPreQuote = !isCustom && !quoteReleased;
  const orderNumber = Math.floor(1000 + Math.random() * 9000).toString();

  // 2. Create Order in PRE_CHARGE state first to prevent "ghost charges"
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
    status: 'PRE_CHARGE',
    groupId,
    userTypedCmd: text,
    rocketName: round?.name || null,
    offset: isPreQuote ? offsetDelta : undefined,
    createdAt: Date.now(),
  };

  // Persist PRE_CHARGE order immediately
  await env.KV_ORDERS.put(`ORDER_${orderNumber}`, JSON.stringify(newOrder));

  // 3. Deduct balance
  profile.balance -= amount;
  await savePlayerProfile(profile, env, ctx);

  // 4. Finalize Order status
  newOrder.status = isPreQuote ? 'pending_hold' : 'pending_match';
  await env.KV_ORDERS.put(`ORDER_${orderNumber}`, JSON.stringify(newOrder));

  // 5. Update index (tracks both pending_match and pending_hold pre-quote orders)
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
    await deliverPrivateNotice(userId, replyToken, groupId, `⏳ Order #${orderNumber} ถูกถืออยู่รอราคาช่างครับ (จำนวน ${amount.toLocaleString()} pt)\nเมื่อแอดมินเปิดราคาช่างอย่างเป็นทางการ ระบบจะจับคู่ดวลให้อัตโนมัติครับ 🚀`, env);
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
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(orderNo, errorMsg, 'พิมพ์ "ต <เลข order>" เพื่อรับแผลที่ยังว่างอยู่ครับ'), env);
    return;
  }

  const orderRaw = await env.KV_ORDERS.get(`ORDER_${resolvedNo}`);
  if (!orderRaw) {
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, `ไม่พบแผล Order #${resolvedNo} ในระบบครับ`, 'พิมพ์ "ต <เลข order>" เพื่อลองรับแผลอื่นครับ'), env);
    return;
  }

  const order = JSON.parse(orderRaw) as Order;
  if (order.status !== 'pending_match') {
    const reason = order.status === 'matched' ? 'แผลนี้มีคู่ดวลแล้วครับ' : 'แผลนี้ถูกยกเลิกไปแล้วครับ';
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, reason, 'พิมพ์ "กระดานดวล" เพื่อดูแผลที่ยังว่างอยู่ครับ'), env);
    return;
  }

  if (order.creatorId === profile.shortId) {
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, 'คุณไม่สามารถรับแผลดวลของตัวเองได้ครับ', 'เลือกแผลของผู้เล่นอื่นเพื่อเปิดการดวลครับ'), env);
    return;
  }

  const effectiveAmt = matchAmt || order.amount;
  if (profile.balance < effectiveAmt) {
    const needed = effectiveAmt - profile.balance;
    const msg = `แต้มไม่พอรับแผลครับ (มี ${profile.balance.toLocaleString()} pt | ขาด ${needed.toLocaleString()} pt)`;
    await deliverPrivateNotice(userId, replyToken, groupId, generateMatchMismatchFlex(resolvedNo, msg, 'พิมพ์ "ฝากเงิน" ในแชตนี้เพื่อเติมเครดิตครับ 🚀'), env);
    return;
  }

  // Deduct matcher balance BEFORE saving
  profile.balance -= effectiveAmt;

  // Update order status in KV
  order.status = 'matched';
  order.matcherId = profile.shortId;
  order.matcherName = profile.displayName;
  order.matchedAt = Date.now();

  const updatePersistence = Promise.all([
    env.KV_ORDERS.put(`ORDER_${resolvedNo}`, JSON.stringify(order)),
    removeFromPendingOrdersList(resolvedNo, env),
    addToMatchedOrdersList(order, env),
    savePlayerProfile(profile, env, ctx),
  ]);

  // Generate match card
  const matchFlex = generateMatchNotificationFlex(order);

  // Match notification: reply to group if requested via group, and push to DM of both players
  const creatorLineId = (await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`)) || order.creatorLineUserId;
  const matchPromises: Promise<any>[] = [updatePersistence];
  
  if (replyToken) {
    matchPromises.push(replyToLine(replyToken, matchFlex, env, !groupId));
  } else {
    matchPromises.push(pushToLine(userId, matchFlex, env));
  }

  if (creatorLineId && creatorLineId !== userId) {
    matchPromises.push(pushToLine(creatorLineId, matchFlex, env));
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
): Promise<{ success: boolean; message: string }> {
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

  // 1. Mark order cancelled in KV_ORDERS & remove from pending list
  order.status = 'cancelled';
  await Promise.all([
    env.KV_ORDERS.put(`ORDER_${resolvedNo}`, JSON.stringify(order)),
    removeFromPendingOrdersList(resolvedNo, env),
  ]);

  // 2. Refund balance directly to the creator's profile
  profile.balance += order.amount;
  await savePlayerProfile(profile, env, ctx);

  return {
    success: true,
    message: `✅ ยกเลิก Order #${resolvedNo} เรียบร้อยแล้วครับ!\n💰 คืนแต้ม: +${order.amount.toLocaleString()} pt\n💎 แต้มคงเหลือปัจจุบัน: ${profile.balance.toLocaleString()} pt 🚀`,
  };
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
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 });

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

          // Refund creator
          if (order.creatorId && Number(order.amount) > 0) {
            const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`)) || order.creatorLineUserId || order.creatorId;
            const profileRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
            if (profileRaw) {
              const p = JSON.parse(profileRaw) as PlayerProfile;
              p.balance = (Number(p.balance) || 0) + Number(order.amount);
              await savePlayerProfile(p, env, ctx);
            }
          }

          order.status = 'cancelled';
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
          if (!isRecovering) clearedCount++;
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
 * Cancels ONLY held pre-quote orders (pending_hold) created while ราคาช่าง was unreleased.
 * Refunds creators and notifies them via DM. Used when a round ends without an official quote.
 */
export async function cancelHeldPreQuoteOrders(env: Env, ctx?: ExecutionContext): Promise<{ cancelled: number }> {
  let cancelledCount = 0;
  try {
    const pendingList = await getPendingOrdersList(env);
    const heldOrders = pendingList.filter((o) => o && o.status === 'pending_hold' && o.betType === 'pre_quote');
    const remainingOrders = pendingList.filter((o) => !(o && o.status === 'pending_hold' && o.betType === 'pre_quote'));

    for (const item of heldOrders) {
      if (!item || !item.orderNumber) continue;
      const raw = await env.KV_ORDERS.get(`ORDER_${item.orderNumber}`);
      if (!raw) continue;
      try {
        const order = JSON.parse(raw) as Order;
        if (order.status === 'pending_hold' && order.betType === 'pre_quote') {
          order.status = 'cancelled';
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
          cancelledCount++;
          const amt = Number(order.amount) || 0;
          const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`)) || order.creatorLineUserId || order.creatorId;
          const notifyPromise = deliverPrivateNotice(
            rawLine,
            undefined,
            order.groupId || null,
            `🚫 Order #${order.orderNumber} ถูกยกเลิกอัตโนมัติ เนื่องจากจบรอบดวลโดยไม่มีการประกาศราคาช่างอย่างเป็นทางการ ✅ (คืนแต้ม ${amt.toLocaleString()} pt)`,
            env,
            order.creatorName
          );
          if (rawLine && amt > 0) {
            const profileRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
            if (profileRaw) {
              const p = JSON.parse(profileRaw) as PlayerProfile;
              p.balance = (Number(p.balance) || 0) + amt;
              await savePlayerProfile(p, env, ctx);
            }
          }
          await notifyPromise;
        }
      } catch (_) {}
    }

    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify(remainingOrders), { expirationTtl: 1800 });
    console.log(`[Worker] cancelHeldPreQuoteOrders: Cancelled + refunded ${cancelledCount} held pre-quote orders.`);
  } catch (err) {
    console.error('[Worker] cancelHeldPreQuoteOrders error:', err);
  }
  return { cancelled: cancelledCount };
}

/**
 * Applies the officially released ราคาช่าง band (minVal-maxVal) to all held pre-quote orders:
 *  - Converts pending_hold pre_quote orders to real band ± offset, status -> pending_match
 *  - Re-adds them to the pending board
 *  - Auto-matches same-amount opposite-side pairs, notifying both players via DM.
 * Called from adminBroadcastQuote whenever a price tier is officially released.
 */
export async function releaseHeldPreQuoteOrders(minVal: number, maxVal: number, env: Env, ctx?: ExecutionContext): Promise<{ converted: number; matched: number }> {
  const bandMin = Number(minVal) || 330;
  const bandMax = Number(maxVal) || 380;
  const pending = await getPendingOrdersList(env);
  const held = pending.filter((o) => o && o.status === 'pending_hold' && o.betType === 'pre_quote');
  const nonHeld = pending.filter((o) => !(o && o.status === 'pending_hold' && o.betType === 'pre_quote'));

  let converted = 0;
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

  // Update PENDING_ORDERS_LIST with newly converted pending_match orders
  const updatedPending = [...convertedOrders, ...nonHeld].slice(0, 300);
  await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify(updatedPending), { expirationTtl: 1800 });

  // Auto-match same-amount opposite-side pairs
  const matched = await autoMatchPendingPairs(env, ctx);

  // Notify each converted player that their pre-quote order is now active
  const notifyPromises = convertedOrders.map(async (o) => {
    const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${o.creatorId}`)) || o.creatorLineUserId || o.creatorId;
    return deliverPrivateNotice(
      rawLine,
      undefined,
      o.groupId || null,
      `✅ ราคาช่างอย่างเป็นทางการแล้ว: ${bandMin}-${bandMax} วิ\n🧾 Order #${o.orderNumber} (${o.amount.toLocaleString()} pt ${o.side === 'low' ? 'ชถ/ต่ำ' : 'ชล/สูง'}) เปิดรอคู่แล้ว พร้อมจับคู่ครับ 🚀`,
      env,
      o.creatorName
    );
  });
  await Promise.all(notifyPromises);

  console.log(`[Worker] releaseHeldPreQuoteOrders: released ${converted} held pre-quote orders, auto-matched ${matched} pairs.`);
  return { converted, matched };
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
        const lowNotify = (await env.KV_CACHE.get(`RAW_LINE_${low.creatorId}`)) || low.creatorLineUserId || low.creatorId;
        const highNotify = (await env.KV_CACHE.get(`RAW_LINE_${high.creatorId}`)) || high.creatorLineUserId || high.creatorId;

        // Mark low as the primary matched order, high is the matcher
        low.status = 'matched';
        low.matcherId = high.creatorId;
        low.matcherName = high.creatorName;
        low.matchedAt = Date.now();

        // High mirrors as matched for settlement bookkeeping (keeping both records)
        high.status = 'matched';
        high.matcherId = low.creatorId;
        high.matcherName = low.creatorName;
        high.matchedAt = Date.now();

        await Promise.all([
          env.KV_ORDERS.put(`ORDER_${low.orderNumber}`, JSON.stringify(low)),
          env.KV_ORDERS.put(`ORDER_${high.orderNumber}`, JSON.stringify(high)),
          removeFromPendingOrdersList(low.orderNumber, env),
          removeFromPendingOrdersList(high.orderNumber, env),
          addToMatchedOrdersList(low, env),
          addToMatchedOrdersList(high, env),
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
      env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 }),
      env.KV_CACHE.put('MATCHED_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 }),
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
          const wasMatched = order.status === 'matched' || (order.matcherId && order.status === 'refunding');
          const isRecovering = order.status === 'refunding';

          order.status = 'refunding';
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));

          const amt = Number(order.amount) || 0;

          // Refund creator
          if (order.creatorId && amt > 0) {
            const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`)) || order.creatorLineUserId || order.creatorId;
            const cpRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
            if (cpRaw) {
              const cp = JSON.parse(cpRaw) as PlayerProfile;
              cp.balance = (Number(cp.balance) || 0) + amt;
              await savePlayerProfile(cp, env, ctx);
            }
          }

          // Refund matcher if matched
          if (wasMatched && order.matcherId && amt > 0) {
            const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${order.matcherId}`)) || order.matcherId;
            const mpRaw = await env.KV_CACHE.get(`USER_${rawLine}`);
            if (mpRaw) {
              const mp = JSON.parse(mpRaw) as PlayerProfile;
              mp.balance = (Number(mp.balance) || 0) + amt;
              await savePlayerProfile(mp, env, ctx);
            }
          }

          order.status = 'cancelled';
          await env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order));
          if (!isRecovering) voidedCount++;
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
    const cached = await env.KV_CACHE.get('PENDING_ORDERS_LIST');
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    if (cached !== null) {
      const list = JSON.parse(cached) as Order[];
      return list.filter((o) => o && (o.status === 'pending_match' || o.status === 'pending_hold') && (o.createdAt || 0) > twoHoursAgo);
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
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 86400 });
  } catch (err) {
    console.error('[Worker] addToPendingOrdersList error:', err);
  }
}

async function removeFromPendingOrdersList(orderNo: string, env: Env): Promise<void> {
  try {
    const cleanNo = orderNo.trim().replace(/^#/, '');
    const list = await getPendingOrdersList(env);
    const updated = list.filter((o) => o.orderNumber !== cleanNo);
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 86400 });
  } catch (err) {
    console.error('[Worker] removeFromPendingOrdersList error:', err);
  }
}

export async function addToMatchedOrdersList(order: Order, env: Env): Promise<void> {
  try {
    const list = await getMatchedOrdersList(env);
    const updated = [order, ...list.filter((o) => o.orderNumber !== order.orderNumber)].slice(0, 300);
    await env.KV_CACHE.put('MATCHED_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 86400 });
  } catch (err) {
    console.error('[Worker] addToMatchedOrdersList error:', err);
  }
}

export async function removeFromMatchedOrdersList(orderNo: string, env: Env): Promise<void> {
  try {
    const cleanNo = orderNo.trim().replace(/^#/, '');
    const list = await getMatchedOrdersList(env);
    const updated = list.filter((o) => o.orderNumber !== cleanNo);
    await env.KV_CACHE.put('MATCHED_ORDERS_LIST', JSON.stringify(updated));
  } catch (err) {
    console.error('[Worker] removeFromMatchedOrdersList error:', err);
  }
}

export async function getMatchedOrdersList(env: Env): Promise<Order[]> {
  try {
    const cached = await env.KV_CACHE.get('MATCHED_ORDERS_LIST');
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

export async function getPlayersList(env: Env): Promise<any[]> {
  try {
    const cached = await env.KV_CACHE.get('PLAYERS_LIST');
    let list: PlayerProfile[] = [];
    if (cached) {
      try { list = JSON.parse(cached); } catch (_) {}
    }

    if (!list || list.length === 0) {
      const scanRes = await env.KV_CACHE.list({ prefix: 'USER_' });
      if (scanRes.keys && scanRes.keys.length > 0) {
        const promises = scanRes.keys.map(k => env.KV_CACHE.get(k.name));
        const raws = await Promise.all(promises);
        list = raws.filter(Boolean).map(r => JSON.parse(r!) as PlayerProfile);
        if (list.length > 0) {
          await env.KV_CACHE.put('PLAYERS_LIST', JSON.stringify(list));
        }
      }
    }

    const avatars = ['🐉', '🐯', '🦅', '🦁', '🐻', '🐼', '🦊', '🦉'];
    return list.map((p, idx) => ({
      id: p.shortId || p.lineUserId,
      name: p.displayName || 'ผู้เล่น',
      balance: Number(p.balance) || 0,
      joinDate: p.registeredAt ? new Date(p.registeredAt).toLocaleDateString('th-TH') : '-',
      bankName: p.bankName || '',
      bankAccount: p.accountNumber || '',
      accountName: p.accountName || p.displayName || '',
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
    const cacheKey = `USER_${profile.lineUserId}`;
    await env.KV_CACHE.put(cacheKey, JSON.stringify(profile));
    if (profile.shortId) {
      await env.KV_CACHE.put(`RAW_LINE_${profile.shortId}`, profile.lineUserId);
    }

    let list: PlayerProfile[] = [];
    const cached = await env.KV_CACHE.get('PLAYERS_LIST');
    if (cached) {
      try { list = JSON.parse(cached); } catch (_) {}
    }
    const idx = list.findIndex(p => p.lineUserId === profile.lineUserId || (profile.shortId && p.shortId === profile.shortId));
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...profile };
    } else {
      list.push(profile);
    }
    // Cap the list document to keep the KV value well under the 25MB limit
    await env.KV_CACHE.put('PLAYERS_LIST', JSON.stringify(list.slice(-500)));

    // Offload sync to Google Sheets in background — throttled to 1 write/min/user
    // so bet-storm balance writes never pile up on slow GAS execution.
    if (env.GAS_FALLBACK_URL && !(await isGasSyncThrottled('SAVE', profile.lineUserId, env))) {
      const syncPromise = fetch(env.GAS_FALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          functionName: 'adminSetPlayerBalance',
          args: [profile.lineUserId, profile.balance, profile.displayName, true],
          apiKey: env.ADMIN_API_KEY,
        }),
      }).catch((e) => console.warn('[Worker] Sheets player balance sync error:', e));
      if (ctx) ctx.waitUntil(syncPromise);
    }
  } catch (err) {
    console.error('[Worker] savePlayerProfile error:', err);
  }
}

/**
 * Per-user GAS sync throttle (60s window). Google Sheets is a reporting mirror,
 * not the live ledger — during bet storms this keeps the hot path completely off
 * slow (1-6s) GAS round-trips, capping Sheets load at 1 call/user/minute.
 * Fail-open by design: if the throttle check itself errors, prefer syncing.
 */
async function isGasSyncThrottled(scope: string, userId: string, env: Env): Promise<boolean> {
  try {
    const key = `GAS_SYNC_${scope}_${userId}`;
    if (await env.KV_CACHE.get(key)) return true;
    await env.KV_CACHE.put(key, '1', { expirationTtl: 60 });
    return false;
  } catch (_) {
    return false;
  }
}

export async function getTransactionsList(env: Env): Promise<Transaction[]> {
  try {
    const cached = await env.KV_CACHE.get('TRANSACTIONS_LIST');
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
    const raw = await env.KV_CACHE.get('CHAT_LOGS');
    const logs = raw ? JSON.parse(raw) : [];
    logs.push(log);
    await env.KV_CACHE.put('CHAT_LOGS', JSON.stringify(logs.slice(-100)));
  } catch (err) {
    console.warn('[logUserMessage Error]:', err);
  }
}

export async function addTransaction(tx: Transaction, env: Env, ctx?: ExecutionContext): Promise<void> {
  try {
    const list = await getTransactionsList(env);
    const updated = [tx, ...list.filter(t => t.id !== tx.id)].slice(0, 100);
    await env.KV_CACHE.put('TRANSACTIONS_LIST', JSON.stringify(updated));

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
  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as PlayerProfile;
  }

  // Fetch LINE user display name via Messaging API
  let displayName = 'ผู้เล่น';
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data?.displayName) displayName = data.displayName;
    }
  } catch (_) {}

  const shortId = `PL${userId.slice(-6).toUpperCase()}`;
  const newProfile: PlayerProfile = {
    shortId,
    lineUserId: userId,
    displayName,
    balance: 0,
    registeredAt: Date.now(),
    updatedAt: Date.now(),
  };

  await savePlayerProfile(newProfile, env, ctx);
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
  try {
    const list = await getSettledOrdersList(env);
    const updated = [order, ...list.filter((o) => o.orderNumber !== order.orderNumber)].slice(0, 100);
    await env.KV_CACHE.put('SETTLED_ORDERS_LIST', JSON.stringify(updated));
  } catch (err) {
    console.error('[Worker] addToSettledOrdersList error:', err);
  }
}

export async function getSettledOrdersList(env: Env): Promise<Order[]> {
  try {
    const cached = await env.KV_CACHE.get('SETTLED_ORDERS_LIST');
    return cached ? JSON.parse(cached) : [];
  } catch (err) {
    console.error('[Worker] getSettledOrdersList error:', err);
    return [];
  }
}
