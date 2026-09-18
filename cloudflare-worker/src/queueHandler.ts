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
  const source = event.source || {};
  const userId = source.userId;
  const groupId = source.groupId || source.roomId || null;
  const isGroup = !!groupId;

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
        await replyToLine(replyToken, `🆔 LINE Group ID: ${groupId}`, env);
      } else {
        await replyToLine(replyToken, '⚠️ คำสั่งนี้ใช้งานได้เฉพาะในกลุ่ม LINE เท่านั้น', env);
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
      // ── Instant-Reply Balance Architecture ──
      // Reply IMMEDIATELY from the KV-cached balance (never block the reply token on
      // a remote Google Sheets call — GAS latency measured 1.3s–6.4s caused LINE to
      // disconnect at ~3s before the reply dispatched, producing silent dead taps).
      // The authoritative Sheets sync then runs in the background; if the authority
      // differs, a corrected balance card is pushed afterwards.
      const balanceFlex = generateBalanceFlex(profile.displayName, profile.balance);
      const bgSync = syncProfileBalanceFromDb(profile, env, ctx)
        .then((synced) => {
          if (synced && synced.balance !== profile.balance) {
            console.log(`[Balance] Background sync corrected balance ${profile.balance} -> ${synced.balance}; pushing correction`);
            return pushToLine(userId, generateBalanceFlex(synced.displayName, synced.balance), env);
          }
        })
        .catch((err) => console.warn('[Balance] Background sync error (non-fatal):', err?.message || err));
      if (ctx) ctx.waitUntil(bgSync);
      await deliverPrivateNotice(userId, replyToken, groupId, balanceFlex, env);
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

    // ── 1.3 Deposit Amount Request (in 1-on-1 private chat: e.g. "1000", "ฝาก 1000", "ฝาก1000") ──
    const pureNumRegex = /^\d+$/;
    const depositTextRegex = /^(?:ฝาก|ฝากเงิน|เติม|เติมเงิน)\s*(\d+)$/;
    let depositAmt: number | null = null;
    if (!isGroup && pureNumRegex.test(clean)) {
      depositAmt = parseInt(clean, 10);
    } else if (depositTextRegex.test(clean)) {
      depositAmt = parseInt(clean.match(depositTextRegex)![1], 10);
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

    // ── 1.6 Withdrawal Execution ("ถอน 500", "ถอน500") ──
    const withdrawAmtRegex = /^(?:ถอน|ถอนเงิน|ถอนยอด)\s*(\d+)$/;
    if (withdrawAmtRegex.test(clean)) {
      const match = clean.match(withdrawAmtRegex)!;
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
      const boardFlex = generatePendingBoardFlex(pendingList);
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
        await replyToLine(replyToken, msg, env);
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
        await replyToLine(replyToken, `🚀 เปิดรอบดวล: ${roundName} (ราคาช่าง 330-380s) เรียบร้อยครับ`, env);
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
        await replyToLine(replyToken, `⛔ ปิดรับดวลรอบ ${roundName} เรียบร้อยแล้วครับ! (ล้างกระดานรอคู่เรียบร้อย 0 แผล)`, env);
      } else {
        await pushToLine(userId, `⛔ ปิดรับดวลรอบ ${roundName} เรียบร้อยแล้วครับ! (ล้างกระดานรอคู่เรียบร้อย 0 แผล)`, env);
      }
      return;
    }

    // ── Fallback for Unrecognized Private Messages ──
    if (!isGroup) {
      const fallbackMsg = `🤖 ได้รับข้อความแล้วครับ 💬\nท่านสามารถพิมพ์ "เมนู" เพื่อเปิดเมนูทำรายการ หรือพิมพ์ "ฝากเงิน", "เช็คยอด", "ถอนเงิน", "กติกา" ได้ทันทีครับ 🚀`;
      await deliverPrivateNotice(userId, replyToken, null, fallbackMsg, env);
      return;
    }
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

  // Deduct balance in memory (held for pre-quote orders until price released)
  profile.balance -= amount;

  const quoteReleased = !!(round && round.quoteReleased === true);
  const isPreQuote = !isCustom && !quoteReleased;

  const orderNumber = Math.floor(1000 + Math.random() * 9000).toString();
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
    status: isPreQuote ? 'pending_hold' : 'pending_match',
    groupId,
    userTypedCmd: text,
    rocketName: round?.name || null,
    offset: isPreQuote ? offsetDelta : undefined,
    createdAt: Date.now(),
  };

  // Send Order Flex to Group Chat immediately (< 150ms)
  const flexCard = generateOrderFlex(newOrder);
  let cardDispatched = false;
  if (replyToken) {
    cardDispatched = await replyToLine(replyToken, flexCard, env);
  }
  if (!cardDispatched && groupId) {
    await pushToLine(groupId, flexCard, env);
  }

  // Persist KV state immediately to guarantee atomic consistency
  await Promise.all([
    savePlayerProfile(profile, env, ctx),
    env.KV_ORDERS.put(`ORDER_${orderNumber}`, JSON.stringify(newOrder)),
    isPreQuote
      ? Promise.resolve()
      : addToPendingOrdersList(newOrder, env),
  ]);

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
    savePlayerProfile(profile, env, ctx),
  ]);

  // Generate match card
  const matchFlex = generateMatchNotificationFlex(order);

  // Group chat isolation: Always push match details to private DM of both players in parallel
  // Do NOT send any match alerts to the LINE group (keeps group clean and quiet)
  const creatorLineId = await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`);
  const matchPromises: Promise<any>[] = [
    pushToLine(userId, matchFlex, env),
    updatePersistence,
  ];
  if (creatorLineId) {
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
  if (order.status !== 'pending_match') {
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
    // 1. Immediately reset PENDING_ORDERS_LIST with empty array in KV_CACHE
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 });

    // 2. Scan and cancel ONLY pending_match + pending_hold (pre_quote) orders, refunding creators
    let cursor: string | undefined = undefined;
    do {
      const listRes: any = await env.KV_ORDERS.list({ prefix: 'ORDER_', limit: 100, cursor });
      if (listRes.keys && listRes.keys.length > 0) {
        for (const k of listRes.keys) {
          const raw = await env.KV_ORDERS.get(k.name);
          if (!raw) continue;
          try {
            const order = JSON.parse(raw) as Order;
            if (order.status === 'pending_match' || order.status === 'pending_hold') {
              order.status = 'cancelled';
              await env.KV_ORDERS.put(k.name, JSON.stringify(order));
              clearedCount++;

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
            }
          } catch (_) {}
        }
      }
      cursor = listRes.list_complete ? undefined : listRes.cursor;
    } while (cursor);

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
    let cursor: string | undefined = undefined;
    do {
      const listRes: any = await env.KV_ORDERS.list({ prefix: 'ORDER_', limit: 100, cursor });
      if (listRes.keys && listRes.keys.length > 0) {
        for (const k of listRes.keys) {
          const raw = await env.KV_ORDERS.get(k.name);
          if (!raw) continue;
          try {
            const order = JSON.parse(raw) as Order;
            if (order.status === 'pending_hold' && order.betType === 'pre_quote') {
              order.status = 'cancelled';
              await env.KV_ORDERS.put(k.name, JSON.stringify(order));
              cancelledCount++;
              const amt = Number(order.amount) || 0;
              const notifyPromise = deliverPrivateNotice(
                order.creatorId,
                undefined,
                order.groupId || null,
                `🚫 Order #${order.orderNumber} ถูกยกเลิกอัตโนมัติ เนื่องจากจบรอบดวลโดยไม่มีการประกาศราคาช่างอย่างเป็นทางการ ✅ (คืนแต้ม ${amt.toLocaleString()} pt)`,
                env
              );
              if (order.creatorId && amt > 0) {
                const rawLine = (await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`)) || order.creatorLineUserId || order.creatorId;
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
      }
      cursor = listRes.list_complete ? undefined : listRes.cursor;
    } while (cursor);
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
  const held: Order[] = [];
  let cursor: string | undefined = undefined;
  do {
    const listRes: any = await env.KV_ORDERS.list({ prefix: 'ORDER_', limit: 100, cursor });
    if (listRes.keys && listRes.keys.length > 0) {
      for (const k of listRes.keys) {
        const raw = await env.KV_ORDERS.get(k.name);
        if (!raw) continue;
        try {
          const order = JSON.parse(raw) as Order;
          if (order.status === 'pending_hold' && order.betType === 'pre_quote') {
            held.push(order);
          }
        } catch (_) {}
      }
    }
    cursor = listRes.list_complete ? undefined : listRes.cursor;
  } while (cursor);

  let converted = 0;
  for (const order of held) {
    const offset = Number(order.offset) || 0;
    order.betType = 'range';
    order.rangeMin = bandMin + offset;
    order.rangeMax = bandMax + offset;
    order.status = 'pending_match';
    await Promise.all([
      env.KV_ORDERS.put(`ORDER_${order.orderNumber}`, JSON.stringify(order)),
      addToPendingOrdersList(order, env),
    ]);
    converted++;
  }

  // Auto-match same-amount opposite-side pairs
  const matched = await autoMatchPendingPairs(env, ctx);

  // Notify each converted player that their pre-quote order is now active
  const notifyPromises = held
    .filter((o) => o.status === 'pending_match')
    .map((o) =>
      deliverPrivateNotice(
        o.creatorId,
        undefined,
        o.groupId || null,
        `✅ ราคาช่างอย่างเป็นทางการแล้ว: ${bandMin}-${bandMax} วิ\n🧾 Order #${o.orderNumber} (${o.amount.toLocaleString()} pt ${o.side === 'low' ? 'ชถ/ต่ำ' : 'ชล/สูง'}) เปิดรอคู่แล้ว พร้อมจับคู่ครับ 🚀`,
        env
      )
    );
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
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 });

    let cursor: string | undefined = undefined;
    do {
      const listRes: any = await env.KV_ORDERS.list({ prefix: 'ORDER_', limit: 100, cursor });
      if (listRes.keys && listRes.keys.length > 0) {
        for (const k of listRes.keys) {
          const raw = await env.KV_ORDERS.get(k.name);
          if (!raw) continue;
          try {
            const order = JSON.parse(raw) as Order;
            if (order.status === 'pending_match' || order.status === 'matched') {
              const wasMatched = order.status === 'matched';
              order.status = 'cancelled';
              await env.KV_ORDERS.put(k.name, JSON.stringify(order));
              voidedCount++;
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
            }
          } catch (_) {}
        }
      }
      cursor = listRes.list_complete ? undefined : listRes.cursor;
    } while (cursor);

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
      return list.filter((o) => o && o.status === 'pending_match' && (o.createdAt || 0) > twoHoursAgo);
    }

    // Fallback: Query KV_ORDERS
    const listRes = await env.KV_ORDERS.list({ prefix: 'ORDER_', limit: 40 });
    if (!listRes.keys || listRes.keys.length === 0) {
      await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify([]), { expirationTtl: 1800 });
      return [];
    }

    const orderPromises = listRes.keys.map((k) => env.KV_ORDERS.get(k.name));
    const rawOrders = await Promise.all(orderPromises);
    const pending: Order[] = [];
    for (const raw of rawOrders) {
      if (!raw) continue;
      try {
        const o = JSON.parse(raw) as Order;
        if (o.status === 'pending_match' && (o.createdAt || 0) > twoHoursAgo) {
          pending.push(o);
        }
      } catch (_) {}
    }

    pending.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify(pending), { expirationTtl: 1800 });
    return pending;
  } catch (err) {
    console.error('[Worker] getPendingOrdersList error:', err);
    return [];
  }
}

async function addToPendingOrdersList(order: Order, env: Env): Promise<void> {
  try {
    const list = await getPendingOrdersList(env);
    const updated = [order, ...list.filter((o) => o.orderNumber !== order.orderNumber)].slice(0, 30);
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 1800 });
  } catch (err) {
    console.error('[Worker] addToPendingOrdersList error:', err);
  }
}

async function removeFromPendingOrdersList(orderNo: string, env: Env): Promise<void> {
  try {
    const cleanNo = orderNo.trim().replace(/^#/, '');
    const list = await getPendingOrdersList(env);
    const updated = list.filter((o) => o.orderNumber !== cleanNo);
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 1800 });
  } catch (err) {
    console.error('[Worker] removeFromPendingOrdersList error:', err);
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

  // 3. Scan KV_ORDERS prefix
  try {
    const listRes = await env.KV_ORDERS.list({ prefix: 'ORDER_', limit: 50 });
    for (const k of listRes.keys) {
      const rawNo = k.name.replace(/^ORDER_/, '');
      if (rawNo === cleanNo) {
        return rawNo;
      }
    }
  } catch (_) {}

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
          args: [profile.lineUserId, profile.balance],
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
    balance: 0, // Real balance is synced from the authoritative Sheets DB below, never a fabricated demo value
    registeredAt: Date.now(),
    updatedAt: Date.now(),
  };

  // The Google Sheets database is the single source of truth for credit balances.
  // Before caching a fresh profile, pull the player's real balance from the DB so a
  // zero-credit player is never reported / synchronized as 1,000 pts.
  // Bounded by a 3s timeout so a slow/cold GAS call can never block the LINE reply.
  if (env.GAS_FALLBACK_URL) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const syncRes = await fetch(`${env.GAS_FALLBACK_URL}?action=getDashboardData&_t=${Date.now()}`, {
        signal: controller.signal,
      });
      if (syncRes.ok) {
        const syncJson: any = await syncRes.json();
        if (syncJson && syncJson.success !== false && Array.isArray(syncJson?.data?.players ?? syncJson?.players)) {
          const dash = syncJson?.data || syncJson;
          const players: any[] = dash.players;
          const match = players.find(
            (p: any) => p && (p.lineUserId === userId || p.id === newProfile.shortId)
          );
          if (match) {
            newProfile.balance = Number(match.balance) || 0;
            if (match.name) newProfile.displayName = match.name;
          }
        }
      }
    } catch (err) {
      console.warn('[Worker] getOrCreatePlayerProfile balance sync error:', err);
    } finally {
      clearTimeout(timer);
    }
  }

  await savePlayerProfile(newProfile, env, ctx);
  return newProfile;
}

/**
 * Re-sync a player's credit balance with the authoritative Google Sheets database.
 * The DB is the single source of truth; a stale KV cache must never overshadow an
 * admin-set balance (e.g. a player zeroed out in the DB but still cached at 1,000).
 * Returns the (possibly in-place updated) profile with the authoritative balance.
 *
 * NOTE: guarded by a 3s hard timeout so a cold/slow GAS call can never block the
 * LINE reply — if the DB can't be reached, the cached balance is returned as-is.
 */
export async function syncProfileBalanceFromDb(
  profile: PlayerProfile,
  env: Env,
  ctx?: ExecutionContext
): Promise<PlayerProfile> {
  if (!env.GAS_FALLBACK_URL) return profile;
  // Throttle: max 1 Sheets read per user per 60s. The instant reply already went
  // out from KV cache; this background correction does not need to be real-time.
  if (await isGasSyncThrottled('BAL', profile.lineUserId, env)) return profile;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const _t0 = Date.now();
  try {
    const syncRes = await fetch(`${env.GAS_FALLBACK_URL}?action=getDashboardData&_t=${Date.now()}`, {
      signal: controller.signal,
    });
    if (!syncRes.ok) {
      console.warn(`[Balance] Sync HTTP ${syncRes.status} after ${Date.now() - _t0}ms — keeping cached balance ${profile.balance}`);
      return profile;
    }
    const syncJson: any = await syncRes.json();
    if (!syncJson || syncJson.success === false) return profile; // Failed read — keep cached value
    const dash = syncJson?.data || syncJson;
    if (!Array.isArray(dash?.players)) return profile; // Corrupt / partial payload — never zero a player on bad data
    const players: any[] = dash.players;
    // ── Empty-Ledger Guard ──
    // The authority ledger must never be trusted when it contains ZERO players.
    // An empty sheet means the DB was never populated (or was wiped) — treating it
    // as truth would zero out every player's KV-cached balance (observed live:
    // getDashboardData returned players:[] and silently zeroed a 1,000 pt account).
    // In that state the KV cache is the freshest surviving copy of the ledger and
    // is authoritative until the DB is repopulated.
    if (players.length === 0) {
      console.warn(`[Balance] Authority ledger EMPTY (${Date.now() - _t0}ms) — keeping cached balance ${profile.balance}`);
      return profile;
    }
    const match = players.find(
      (p: any) => p && (p.lineUserId === profile.lineUserId || p.id === profile.shortId)
    );
    // DB is the single source of truth. A successful, non-cached DB read that does
    // NOT contain this player means the account has no credited balance (0) — never
    // report a stale KV demo value (e.g. the old hardcoded 1,000) for a solo account.
    if (!match) {
      if (profile.balance !== 0) {
        profile.balance = 0;
        profile.updatedAt = Date.now();
        await savePlayerProfile(profile, env, ctx);
      }
      return profile;
    }

    const dbBalance = Number(match.balance) || 0;
    const dbName = match.name || profile.displayName;
    if (dbBalance !== profile.balance || dbName !== profile.displayName) {
      profile.balance = dbBalance;
      profile.displayName = dbName;
      profile.updatedAt = Date.now();
      await savePlayerProfile(profile, env, ctx);
    }
  } catch (err) {
    console.warn('[Worker] syncProfileBalanceFromDb error:', err);
  } finally {
    clearTimeout(timer);
  }
  return profile;
}

async function recordActiveGroup(groupId: string, env: Env): Promise<void> {
  await env.KV_CACHE.put('ACTIVE_GROUP_ID', groupId);
  const existing = await env.KV_CACHE.get(`GROUP_${groupId}`);
  if (!existing) {
    await env.KV_CACHE.put(`GROUP_${groupId}`, JSON.stringify({
      id: groupId,
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

async function replyToLine(replyToken: string, payload: any, env: Env): Promise<boolean> {
  try {
    let messageObj: any;
    if (typeof payload === 'string') {
      messageObj = { type: 'text', text: payload };
    } else if (payload && payload.type === 'flex') {
      messageObj = payload;
    } else if (payload && (payload.type === 'bubble' || payload.type === 'carousel')) {
      const altText = payload.header?.contents?.[0]?.text || payload.altText || '🚀 Rocket Science';
      messageObj = { type: 'flex', altText, contents: payload };
    } else if (payload && payload.type === 'text') {
      messageObj = payload;
    } else {
      messageObj = { type: 'text', text: String(payload) };
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
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[LINE Reply Exception]:', err?.message || err);
    return false;
  }
}

export async function pushToLine(to: string, payload: any, env: Env): Promise<{ success: boolean; code?: number; error?: string }> {
  try {
    let messageObj: any;
    if (typeof payload === 'string') {
      messageObj = { type: 'text', text: payload };
    } else if (payload && payload.type === 'flex') {
      messageObj = payload;
    } else if (payload && (payload.type === 'bubble' || payload.type === 'carousel')) {
      const altText = payload.header?.contents?.[0]?.text || payload.altText || '🚀 Rocket Science';
      messageObj = { type: 'flex', altText, contents: payload };
    } else if (payload && payload.type === 'text') {
      messageObj = payload;
    } else {
      messageObj = { type: 'text', text: String(payload) };
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
    return { success: true, code: 200 };
  } catch (err: any) {
    console.error(`[LINE Push Exception] to=${to}:`, err?.message || err);
    return { success: false, error: err?.message || 'Network exception' };
  }
}

async function deliverPrivateNotice(
  userId: string,
  replyToken: string | undefined,
  groupId: string | null,
  payload: any,
  env: Env
): Promise<void> {
  const _t0 = Date.now();
  // 1. If in 1-on-1 private chat with LINE OA:
  if (!groupId) {
    // Keep the floating main-menu Quick Reply visible after every private reply,
    // not only after the "เมนู" command.
    const enriched = attachMainMenuQuickReply(payload);
    if (replyToken) {
      const sent = await replyToLine(replyToken, enriched, env);
      if (sent) return;
    }
    await pushToLine(userId, enriched, env);
    return;
  }

  // 2. If interaction originated in a LINE Group:
  // Strictly isolate private notices (balance errors, cancellation receipts, deposit info)
  // to the user's private LINE chat so the group chat remains 100% clean and quiet.
  // The private DM message also carries the floating main-menu Quick Reply so the
  // user can keep acting without re-invoking "เมนู".
  await pushToLine(userId, attachMainMenuQuickReply(payload), env);
}
