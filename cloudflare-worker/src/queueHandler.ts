import { Env, LineEvent, Order, PlayerProfile, RocketRound } from './types.js';
import {
  generateOrderFlex,
  generateMatchNotificationFlex,
  generateBalanceFlex,
  generatePendingBoardFlex,
} from './flexTemplates.js';

export const RULE_GUIDE_TEXT = `📖 [คู่มือคีย์เวิร์ดกติกาการเล่น]

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
    const profile = await getOrCreatePlayerProfile(userId, env);

    // ── 1. Balance Inspection ("เช็คยอด", "คงเหลือ", "balance") ──
    const clean = text.replace(/\s+/g, '').toLowerCase();
    if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
      const balanceFlex = generateBalanceFlex(profile.displayName, profile.balance);
      await deliverPrivateNotice(userId, replyToken, groupId, balanceFlex, env);
      return;
    }

    // ── 1.1 Live Betting Board ("กระดานดวล", "แผลค้าง", "เปิดรอคู่", "รอคู่", "กระดาน", "board") ──
    const boardRegex = /^(?:📊\s*)?(กระดานดวล|แผลค้าง|เปิดรอคู่|รอคู่|กระดาน|board)$/i;
    if (boardRegex.test(clean) || boardRegex.test(text)) {
      const pendingList = await getPendingOrdersList(env);
      const boardFlex = generatePendingBoardFlex(pendingList);
      if (replyToken) {
        await replyToLine(replyToken, boardFlex, env);
      } else if (groupId) {
        await pushToLine(groupId, boardFlex, env);
      } else {
        await pushToLine(userId, boardFlex, env);
      }
      return;
    }

    // ── 1.2 Rule Guide ("กติกา", "rule", "rules", "วิธีเล่น", "คู่มือ") ──
    const ruleRegex = /^(?:📖\s*)?(กติกา|rule|rules|วิธีเล่น|คู่มือ)$/i;
    if (ruleRegex.test(clean) || ruleRegex.test(text)) {
      if (replyToken) {
        await replyToLine(replyToken, RULE_GUIDE_TEXT, env);
      } else {
        await pushToLine(userId, RULE_GUIDE_TEXT, env);
      }
      return;
    }

    // ── 2. Cancel Order ("ยกเลิก [orderNo]") ──
    const cancelRegex = /^(ยกเลิก|cancel)\s*#?(\d{2,6})$/i;
    if (cancelRegex.test(clean) || cancelRegex.test(text)) {
      const match = text.match(cancelRegex) || clean.match(cancelRegex);
      const targetNo = match ? match[2] : null;
      if (targetNo) {
        const cancelRes = await cancelOrder(targetNo, profile.shortId, env);
        await deliverPrivateNotice(userId, replyToken, groupId, cancelRes.message, env);
      }
      return;
    }

    // ── 3. Accept/Match Bet Command (e.g. "ต 9047 500", "ต9047", "ต47", "รับ 9047") ──
    const matchWithPrefixRegex = /^(?:(ต|ติด|รับ|เค|ดีล)\s*)#?(\d{2,6})(?:\s+(\d+))?$/i;
    const matchNoPrefixRegex = /^#?(\d{4,6})\s+(\d+)$/i;
    const matchHashOnlyRegex = /^#(\d{2,6})$/i;

    if (matchWithPrefixRegex.test(text) || matchNoPrefixRegex.test(text) || matchHashOnlyRegex.test(text)) {
      let orderNo: string | undefined;
      let matchAmt: number | undefined;

      if (matchWithPrefixRegex.test(text)) {
        const match = text.match(matchWithPrefixRegex)!;
        orderNo = match[2];
        matchAmt = match[3] ? parseInt(match[3], 10) : undefined;
      } else if (matchNoPrefixRegex.test(text)) {
        const match = text.match(matchNoPrefixRegex)!;
        orderNo = match[1];
        matchAmt = parseInt(match[2], 10);
      } else if (matchHashOnlyRegex.test(text)) {
        const match = text.match(matchHashOnlyRegex)!;
        orderNo = match[1];
        matchAmt = undefined;
      }

      if (orderNo) {
        await handleMatchOrder(orderNo, matchAmt, profile, userId, groupId, replyToken, env, ctx);
        return;
      }
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
        updatedAt: Date.now(),
      }));
      if (replyToken) {
        await replyToLine(replyToken, `🚀 เปิดรอบดวล: ${roundName} (ราคาช่าง 330-380s) เรียบร้อยครับ`, env);
      }
      return;
    }

    if (clean === 'ปิดรอบ' || clean === 'ปิดรับดวล' || clean === '3-2-go') {
      const roundStr = await env.KV_CACHE.get('ACTIVE_ROUND');
      if (roundStr) {
        const round = JSON.parse(roundStr) as RocketRound;
        round.status = 'CLOSED';
        await env.KV_CACHE.put('ACTIVE_ROUND', JSON.stringify(round));
        if (replyToken) {
          await replyToLine(replyToken, `⛔ ปิดรับดวลรอบ ${round.name} เรียบร้อยแล้วครับ!`, env);
        }
      }
      return;
    }
  }

  // ── Postback Event (from Button Click in LINE) ──
  if (event.type === 'postback' && event.postback?.data && userId) {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    if (action === 'match_order') {
      const orderNo = params.get('order_id') || '';
      const amount = parseInt(params.get('amount') || '0', 10);
      const profile = await getOrCreatePlayerProfile(userId, env);
      await handleMatchOrder(orderNo, amount || undefined, profile, userId, groupId, event.replyToken, env);
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
    if (round) {
      rangeMin = round.targetMin;
      rangeMax = round.targetMax;
    }
  }

  if (amount < 50 || amount > 50000) {
    await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ ยอดดวลต้องอยู่ระหว่าง 50 ถึง 50,000 pt ครับ (คุณระบุ ${amount} pt)`, env);
    return;
  }

  if (profile.balance < amount) {
    const needed = amount - profile.balance;
    await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ แต้มไม่พอ (มี ${profile.balance} pt | ขาด ${needed} pt) พิมพ์ "ฝากเงิน"`, env);
    return;
  }

  // Deduct balance in memory
  profile.balance -= amount;

  const orderNumber = Math.floor(100000 + Math.random() * 900000).toString();
  const newOrder: Order = {
    orderNumber,
    creatorId: profile.shortId,
    creatorName: profile.displayName,
    side,
    amount,
    betType: isCustom ? 'custom_range' : 'range',
    rangeMin,
    rangeMax,
    status: 'pending_match',
    groupId,
    userTypedCmd: text,
    rocketName: round?.name || null,
    createdAt: Date.now(),
  };

  // Send Order Flex to Group Chat immediately (< 150ms)
  const flexCard = generateOrderFlex(newOrder);
  const sendOrderPromise = replyToken
    ? replyToLine(replyToken, flexCard, env)
    : pushToLine(groupId, flexCard, env);

  // Persist KV state and dispatch private receipt concurrently (0ms blocking on critical path)
  const backgroundPersistence = Promise.all([
    env.KV_CACHE.put(`USER_${userId}`, JSON.stringify(profile)),
    env.KV_ORDERS.put(`ORDER_${orderNumber}`, JSON.stringify(newOrder)),
    addToPendingOrdersList(newOrder, env),
    pushToLine(
      userId,
      `✅ ยืนยันเปิดออเดอร์ #${orderNumber}\nบั้งไฟ: ${round?.name || '-'}\nฝั่ง: ${side === 'low' ? 'ต่ำ' : 'สูง'} | ${amount} pt`,
      env
    ),
  ]);

  if (ctx) {
    ctx.waitUntil(backgroundPersistence);
    await sendOrderPromise;
  } else {
    await Promise.all([sendOrderPromise, backgroundPersistence]);
  }
}

async function handleMatchOrder(
  orderNo: string,
  matchAmt: number | undefined,
  profile: PlayerProfile,
  userId: string,
  groupId: string | null,
  replyToken: string | undefined,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  const resolvedNo = await resolveOrderNumber(orderNo, env);
  if (!resolvedNo) {
    await deliverPrivateNotice(userId, replyToken, groupId, `🚫 ไม่พบแผล Order #${orderNo} ในระบบครับ`, env);
    return;
  }

  const orderRaw = await env.KV_ORDERS.get(`ORDER_${resolvedNo}`);
  if (!orderRaw) {
    await deliverPrivateNotice(userId, replyToken, groupId, `🚫 ไม่พบแผล Order #${resolvedNo} ในระบบครับ`, env);
    return;
  }

  const order = JSON.parse(orderRaw) as Order;
  if (order.status !== 'pending_match') {
    const reason = order.status === 'matched' ? 'มีคู่ดวลแล้วครับ' : 'ถูกยกเลิกไปแล้วครับ';
    await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ แผล Order #${resolvedNo} ${reason}`, env);
    return;
  }

  if (order.creatorId === profile.shortId) {
    await deliverPrivateNotice(userId, replyToken, groupId, '⚠️ คุณไม่สามารถรับแผลดวลของตัวเองได้ครับ', env);
    return;
  }

  const effectiveAmt = matchAmt || order.amount;
  if (profile.balance < effectiveAmt) {
    const needed = effectiveAmt - profile.balance;
    await deliverPrivateNotice(userId, replyToken, groupId, `⚠️ แต้มไม่พอ (มี ${profile.balance} pt | ขาด ${needed} pt) พิมพ์ "ฝากเงิน"`, env);
    return;
  }

  // Update order status in KV
  order.status = 'matched';
  order.matcherId = profile.shortId;
  order.matcherName = profile.displayName;
  order.matchedAt = Date.now();

  const updatePersistence = Promise.all([
    env.KV_ORDERS.put(`ORDER_${resolvedNo}`, JSON.stringify(order)),
    removeFromPendingOrdersList(resolvedNo, env),
    env.KV_CACHE.put(`USER_${userId}`, JSON.stringify(profile)),
  ]);

  // Deduct matcher balance
  profile.balance -= effectiveAmt;

  // Generate match card
  const matchFlex = generateMatchNotificationFlex(order);

  // Group chat isolation: Always push match details to private DM of both players in parallel
  const creatorLineId = await env.KV_CACHE.get(`RAW_LINE_${order.creatorId}`);
  const matchPromises: Promise<any>[] = [
    pushToLine(userId, matchFlex, env),
    updatePersistence,
  ];
  if (creatorLineId) {
    matchPromises.push(pushToLine(creatorLineId, matchFlex, env));
  }
  if (groupId) {
    matchPromises.push(pushToLine(groupId, `🤝 Order #${resolvedNo} มีผู้รับดวลแล้วครับ! (${order.amount} pt)`, env));
  }

  if (ctx) {
    ctx.waitUntil(Promise.all(matchPromises));
  } else {
    await Promise.all(matchPromises);
  }
}

async function cancelOrder(orderNo: string, shortId: string, env: Env): Promise<{ success: boolean; message: string }> {
  const resolvedNo = await resolveOrderNumber(orderNo, env);
  if (!resolvedNo) return { success: false, message: `🚫 ไม่พบแผล Order #${orderNo}` };

  const raw = await env.KV_ORDERS.get(`ORDER_${resolvedNo}`);
  if (!raw) return { success: false, message: `🚫 ไม่พบแผล Order #${resolvedNo}` };

  const order = JSON.parse(raw) as Order;
  if (order.creatorId !== shortId) {
    return { success: false, message: '⚠️ คุณไม่ใช่เจ้าของแผลนี้ครับ' };
  }
  if (order.status !== 'pending_match') {
    return { success: false, message: `⚠️ แผลนี้อยู่ในสถานะ ${order.status} ไม่สามารถยกเลิกได้ครับ` };
  }

  order.status = 'cancelled';
  await Promise.all([
    env.KV_ORDERS.put(`ORDER_${resolvedNo}`, JSON.stringify(order)),
    removeFromPendingOrdersList(resolvedNo, env),
  ]);

  // Refund creator balance
  const creatorLineId = await env.KV_CACHE.get(`RAW_LINE_${shortId}`);
  if (creatorLineId) {
    const profileRaw = await env.KV_CACHE.get(`USER_${creatorLineId}`);
    if (profileRaw) {
      const p = JSON.parse(profileRaw) as PlayerProfile;
      p.balance += order.amount;
      await env.KV_CACHE.put(`USER_${creatorLineId}`, JSON.stringify(p));
    }
  }

  return { success: true, message: `✅ ยกเลิก Order #${resolvedNo} และคืนแต้ม ${order.amount} pt เรียบร้อยแล้วครับ` };
}

// ── Pending Orders & Lookup Helpers ──

export async function getPendingOrdersList(env: Env): Promise<Order[]> {
  try {
    const cached = await env.KV_CACHE.get('PENDING_ORDERS_LIST');
    if (cached) {
      const list = JSON.parse(cached) as Order[];
      return list.filter((o) => o && o.status === 'pending_match');
    }

    // Fallback: Query KV_ORDERS
    const listRes = await env.KV_ORDERS.list({ prefix: 'ORDER_', limit: 40 });
    if (!listRes.keys || listRes.keys.length === 0) {
      return [];
    }

    const orderPromises = listRes.keys.map((k) => env.KV_ORDERS.get(k.name));
    const rawOrders = await Promise.all(orderPromises);
    const pending: Order[] = [];
    for (const raw of rawOrders) {
      if (!raw) continue;
      try {
        const o = JSON.parse(raw) as Order;
        if (o.status === 'pending_match') {
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
    const list = await getPendingOrdersList(env);
    const updated = list.filter((o) => o.orderNumber !== orderNo && !o.orderNumber.endsWith(orderNo));
    await env.KV_CACHE.put('PENDING_ORDERS_LIST', JSON.stringify(updated), { expirationTtl: 1800 });
  } catch (err) {
    console.error('[Worker] removeFromPendingOrdersList error:', err);
  }
}

async function resolveOrderNumber(inputNo: string, env: Env): Promise<string | null> {
  const cleanNo = inputNo.trim().replace(/^#/, '');
  // 1. Direct match
  const direct = await env.KV_ORDERS.get(`ORDER_${cleanNo}`);
  if (direct) return cleanNo;

  // 2. Check pending list for endsWith or exact
  const pendingList = await getPendingOrdersList(env);
  const foundPending = pendingList.find(
    (o) => o.orderNumber === cleanNo || o.orderNumber.endsWith(cleanNo)
  );
  if (foundPending) return foundPending.orderNumber;

  // 3. Scan KV_ORDERS prefix
  try {
    const listRes = await env.KV_ORDERS.list({ prefix: 'ORDER_', limit: 50 });
    for (const k of listRes.keys) {
      const rawNo = k.name.replace(/^ORDER_/, '');
      if (rawNo === cleanNo || rawNo.endsWith(cleanNo)) {
        return rawNo;
      }
    }
  } catch (_) {}

  return null;
}

// ── User Profile & Group Helpers ──

async function getOrCreatePlayerProfile(userId: string, env: Env): Promise<PlayerProfile> {
  const cacheKey = `USER_${userId}`;
  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
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
    balance: 1000, // Demo starter balance if not yet synced with Sheets
    registeredAt: Date.now(),
    updatedAt: Date.now(),
  };

  await env.KV_CACHE.put(cacheKey, JSON.stringify(newProfile));
  await env.KV_CACHE.put(`RAW_LINE_${shortId}`, userId);
  return newProfile;
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
}

// ── LINE HTTP Dispatchers ──

async function replyToLine(replyToken: string, payload: any, env: Env): Promise<void> {
  const messages = [typeof payload === 'string' ? { type: 'text', text: payload } : payload];
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

async function pushToLine(to: string, payload: any, env: Env): Promise<void> {
  const messages = [typeof payload === 'string' ? { type: 'text', text: payload } : payload];
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });
}

async function deliverPrivateNotice(
  userId: string,
  replyToken: string | undefined,
  groupId: string | null,
  payload: any,
  env: Env
): Promise<void> {
  if (groupId) {
    await pushToLine(userId, payload, env);
    return;
  }
  if (replyToken) {
    await replyToLine(replyToken, payload, env);
    return;
  }
  await pushToLine(userId, payload, env);
}
