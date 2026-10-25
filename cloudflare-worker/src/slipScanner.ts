import { Env } from './types.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Slip Scanner — read a Thai bank slip and credit the amount it actually shows
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Ported from the Google Apps Script mirror (Code.gs, ~line 1800-2040), which
 * is the battle-tested implementation of exactly this flow. The Worker version
 * existed only as a stub that hardcoded `requestedAmount: 1000` and always
 * escalated to an admin, so the "credit what the slip says" behaviour only ever
 * existed in GAS.
 *
 * The four anti-fraud guards from GAS are preserved verbatim, because they are
 * the reason this is safe to run unattended:
 *
 *   1. No readable reference code  → screenshot / edited / cropped image.
 *   2. Amount missing or zero      → nothing was verified.
 *   3. Duplicate `transRef`        → the same slip submitted twice. Enforced
 *      here with an exclusive Durable Object claim rather than GAS's
 *      `checkIfRefExists` + ScriptLock, which is the same guarantee but also
 *      holds across regions and deployments.
 *   4. Slip older than 24 hours    → stale slip replay.
 *
 * If the API itself is unreachable or the subscription has lapsed, this returns
 * a failure with `escalate: true` so the deposit lands in the Admin Console for
 * manual review instead of the player's money disappearing.
 */

export interface SlipSender {
  bank?: string;
  account?: string;
  name?: string;
}

export type SlipScanResult =
  | {
      ok: true;
      refCode: string;
      amount: number;
      dateTime?: string;
      sender?: SlipSender;
    }
  | {
      ok: false;
      /** Player-facing Thai explanation. */
      message: string;
      /** Admin-facing detail for the review queue. */
      detail: string;
      /** Always true today: every failure is routed to an admin. */
      escalate: true;
      /** True when the API was the problem rather than the slip. */
      apiFailure?: boolean;
    };

const SLIP_API_URL = 'https://connect.slip2go.com/api/verify-slip/qr-base64/info';
/** GAS rejects slips older than this. Kept identical. */
const SLIP_MAX_AGE_HOURS = 24;

function asRecord(v: any): any | null {
  return v && typeof v === 'object' ? v : null;
}

/** Pull the transaction reference out of Slip2Go's several response shapes. */
function extractRefCode(data: any): string {
  if (!data) return '';
  const d = asRecord(data);
  const raw = asRecord(d?.rawSlip);
  return String(
    d?.transRef ||
    raw?.transRef ||
    d?.referenceId ||
    d?.transactionId ||
    raw?.referenceId ||
    ''
  ).trim();
}

/** Slip2Go returns the amount as a number, a string, or `{ amount: n }`. */
function extractAmount(data: any): number {
  if (!data) return 0;
  const d = asRecord(data);
  const raw = asRecord(d?.rawSlip);

  const candidates = [d?.amount, d?.amountInSlip, raw?.amount, raw?.amountInSlip];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const obj = asRecord(c);
    const n = Number(obj ? obj.amount : c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function extractDateTime(data: any): string {
  if (!data) return '';
  const d = asRecord(data);
  const raw = asRecord(d?.rawSlip);
  return String(
    d?.dateTime || raw?.date || raw?.transDate || d?.date || d?.transDate || ''
  ).trim();
}

/** The payer, which doubles as the player's bank details for a future withdrawal. */
function extractSender(data: any): SlipSender | undefined {
  if (!data) return undefined;
  const d = asRecord(data);
  const raw = asRecord(d?.rawSlip);
  const sender = asRecord(d?.sender) || asRecord(raw?.sender);
  if (!sender) return undefined;

  const bank = asRecord(sender.bank);
  const account = asRecord(sender.account);
  const accountBank = asRecord(account?.bank);

  const out: SlipSender = {
    bank: String(bank?.abbr || bank?.name || bank?.id || '').trim() || undefined,
    account: String(accountBank?.account || account?.value || account?.number || '').trim() || undefined,
    name: String(account?.name || sender.name || '').trim() || undefined,
  };
  return out.bank || out.account ? out : undefined;
}

/**
 * Download the slip image from LINE's content endpoint.
 * The message id is enough; no extra API call is needed to get the URL.
 */
async function downloadSlipImage(messageId: string, env: Env): Promise<{ base64: string; mimeType: string } | null> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;

  const metaRes = await fetch(`https://api.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  }).catch(() => null);
  if (!metaRes || !metaRes.ok) return null;

  const buffer = await metaRes.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) return null;

  const mimeType = (metaRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { base64: btoa(binary), mimeType };
}

/**
 * Read a slip image and return what it proves, or why it cannot be trusted.
 * Never throws — every failure mode is returned so the caller can escalate.
 */
export async function scanSlipImage(messageId: string, env: Env): Promise<SlipScanResult> {
  if (!env.SLIP_API_KEY) {
    return {
      ok: false,
      escalate: true,
      apiFailure: true,
      message: 'ระบบสแกนสลิปอัตโนมัติยังไม่เปิดใช้งาน\nส่งให้แอดมินตรวจแล้ว รอสักครู่',
      detail: 'SLIP_API_KEY is not configured on the Worker',
    };
  }

  const image = await downloadSlipImage(messageId, env);
  if (!image) {
    return {
      ok: false,
      escalate: true,
      apiFailure: true,
      message: 'ดาวน์โหลดรูปสลิปไม่ได้\nส่งสลิปใหม่อีกครั้ง หรือรอแอดมินตรวจ',
      detail: `Could not download LINE message content for ${messageId}`,
    };
  }

  const endpoint = env.SLIP_API_URL || SLIP_API_URL;
  const dataUri = `data:${image.mimeType};base64,${image.base64}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLIP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: { imageBase64: dataUri } }),
    });
  } catch (err: any) {
    return {
      ok: false,
      escalate: true,
      apiFailure: true,
      message: 'ระบบตรวจสลิปขัดข้อง\nส่งให้แอดมินตรวจแล้ว รอสักครู่',
      detail: `Slip API connectivity failure: ${err?.message || String(err)}`,
    };
  }

  const responseText = await response.text().catch(() => '');

  if (!response.ok) {
    let detail = responseText.slice(0, 300) || `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(responseText);
      detail = parsed?.error?.message || parsed?.message || detail;
    } catch { /* keep the raw text */ }

    // Bangkok Bank publishes transfers late; that is a bank-side delay, not a
    // bad slip. GAS has a dedicated message for it, and it is worth keeping —
    // it stops a temporary outage looking like the player's mistake.
    const isBangkokPending = /Bangkok Bank/i.test(detail) && /pending/i.test(detail);
    const isExpired = response.status === 403 || /expired|SERVICE_EXPIRED/i.test(detail);

    return {
      ok: false,
      escalate: true,
      apiFailure: true,
      message: isBangkokPending
        ? 'ธนาคารกรุงเทพอัปเดตข้อมูลช้ากว่าปกติ ระบบยังตรวจสลิปไม่ได้\nส่งให้แอดมินแล้ว จะเติมเครดิตโดยเร็ว'
        : isExpired
          ? 'ระบบสแกนสลิปอัตโนมัติอยู่ระหว่างปรับปรุง\nส่งให้แอดมินตรวจแล้ว'
          : `ระบบตรวจสลิปขัดข้อง (HTTP ${response.status})\nส่งให้แอดมินตรวจแล้ว`,
      detail: `Slip API HTTP ${response.status}: ${detail}`,
    };
  }

  let payload: any;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return {
      ok: false,
      escalate: true,
      apiFailure: true,
      message: 'อ่านผลตรวจสลิปไม่สำเร็จ\nส่งให้แอดมินตรวจแล้ว',
      detail: `Slip API returned non-JSON: ${responseText.slice(0, 200)}`,
    };
  }

  const data = asRecord(payload?.data);
  const isSuccess =
    payload?.code === '200000' ||
    payload?.success === true ||
    Boolean(data && (data.transRef || data.referenceId || data.transactionId));

  if (!isSuccess) {
    const apiMessage = String(payload?.message || payload?.error?.message || '').trim();
    const unreadable = payload?.code === '200500' || /QR|อ่านไม่|ไม่พบข้อมูลสลิป/i.test(apiMessage);
    return {
      ok: false,
      escalate: true,
      message: unreadable
        ? 'สแกนสลิปไม่ผ่าน: ไม่พบข้อมูลในระบบธนาคาร หรือ QR ไม่ชัด\nส่งให้แอดมินตรวจแล้ว'
        : `สแกนสลิปไม่ผ่าน: ${apiMessage || 'ยืนยันสลิปนี้ไม่ได้'}\nส่งให้แอดมินตรวจแล้ว`,
      detail: `Slip API check failed: ${apiMessage || JSON.stringify(payload).slice(0, 200)}`,
    };
  }

  // GUARD 1 — a genuine bank slip always carries a transaction reference.
  const refCode = extractRefCode(data);
  if (!refCode) {
    return {
      ok: false,
      escalate: true,
      message:
        'สลิปไม่มีรหัสอ้างอิงธุรกรรม อาจเป็นภาพแคปหน้าจอหรือถูกตัดต่อ\nส่งสลิปจากแอปธนาคารโดยตรง',
      detail: 'Slip has no transaction reference code (screenshot or edited image)',
    };
  }

  // GUARD 2 — nothing to credit means nothing was verified.
  const amount = extractAmount(data);
  if (!(amount > 0)) {
    return {
      ok: false,
      escalate: true,
      message: 'ไม่พบยอดเงินในสลิป\nส่งให้แอดมินตรวจเป็นกรณีพิเศษ',
      detail: `Slip ${refCode} has no verifiable amount`,
    };
  }

  // GUARD 4 — a slip from last week is a replay, not a deposit.
  const dateTime = extractDateTime(data);
  if (dateTime) {
    const slipDate = new Date(dateTime);
    if (!Number.isNaN(slipDate.getTime())) {
      const ageHours = (Date.now() - slipDate.getTime()) / (60 * 60 * 1000);
      if (ageHours > SLIP_MAX_AGE_HOURS) {
        return {
          ok: false,
          escalate: true,
          message: `สลิปหมดอายุ (วันที่ ${dateTime})\nรับเฉพาะสลิปที่โอนภายใน ${SLIP_MAX_AGE_HOURS} ชั่วโมง`,
          detail: `Stale slip rejected: ${dateTime} is older than ${SLIP_MAX_AGE_HOURS}h`,
        };
      }
    }
  }

  return { ok: true, refCode, amount, dateTime: dateTime || undefined, sender: extractSender(data) };
}

export const SLIP_GUARD_MAX_AGE_HOURS = SLIP_MAX_AGE_HOURS;
