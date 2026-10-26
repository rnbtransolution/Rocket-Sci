/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Second-factor PIN for irreversible operations (Factory Reset, voiding a round)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 * ---------------
 * `resetGoogleSheetsDatabase` deletes every player profile, balance,
 * transaction, chat log and bet record. It is irreversible and there is no
 * backup: the Apps Script mirror is unreachable, so the Durable Object is the
 * only copy. It was previously guarded by a Super Admin role check plus a
 * single `window.confirm` — and `window.confirm` is advisory only. Anything
 * that can drive the admin portal (a stray click, a stale tab, a mistyped
 * automation) can drive the dialog too, and the data is gone.
 *
 * DESIGN
 * ------
 * 1. The PIN is verified SERVER-SIDE, inside the RPC that performs the reset.
 *    A client-side dialog protects nothing: anyone who can call `/api/run` can
 *    call it directly, so the dialog is a speed bump and the PIN is the lock.
 *
 * 2. Stored as PBKDF2-SHA256 with a per-install random salt, never plaintext —
 *    the same treatment passwords get in `credentials.ts`, and for the same
 *    reason: a leaked state dump should not hand over the PIN.
 *
 * 3. Fails CLOSED. If the PIN has never been set, or cannot be read, the reset
 *    is refused. It does not fall back to "no PIN configured means no PIN
 *    required", because that fallback is exactly the state in which a single
 *    stray click destroys the database.
 *
 * 4. Compares in constant time, so a wrong PIN cannot be discovered one digit
 *    at a time by timing.
 *
 * This is deliberately a *second* factor, not a replacement for the role check:
 * a leaked Super Admin session still cannot wipe production without also
 * knowing the PIN, and a shoulder-surfed PIN still cannot wipe it without a
 * valid Super Admin session.
 */

import { StateStore } from './state.js';

const PIN_KEY = 'DANGER_PIN';
const PBKDF2_ITERATIONS = 100_000; // Workers WebCrypto ceiling; see credentials.ts.
const BITS = 256;

/** Longest PIN accepted. Digits only — this is typed on a phone keypad or a portal modal. */
const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 12;

/** Brute-force throttle: consecutive failures allowed before a cool-off. */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

interface PinRecord {
  hash: string;
  salt: string;
  updatedAt: number;
}

interface LockoutRecord {
  failures: number;
  lockedUntil: number;
}

const LOCKOUT_KEY = 'DANGER_PIN_LOCKOUT';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function pbkdf2(pin: string, saltHex: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    BITS
  );
  return toHex(new Uint8Array(bits));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Strip spaces and separators so "123 456" verifies against "123456". */
function normalisePin(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < MIN_PIN_LENGTH || digits.length > MAX_PIN_LENGTH) return null;
  return digits;
}

export interface PinValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate PIN *shape* only. Called by the RPC that sets it, so an unusable
 * value is rejected up front rather than locking the operator out later.
 */
export function validatePinFormat(input: unknown): PinValidation {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'กรุณากรอก PIN' };
  }
  const digits = input.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) {
    return { ok: false, error: 'PIN ต้องเป็นตัวเลขเท่านั้น' };
  }
  if (digits.length < MIN_PIN_LENGTH) {
    return { ok: false, error: `PIN ต้องมีอย่างน้อย ${MIN_PIN_LENGTH} หลัก` };
  }
  if (digits.length > MAX_PIN_LENGTH) {
    return { ok: false, error: `PIN ต้องไม่เกิน ${MAX_PIN_LENGTH} หลัก` };
  }
  const COMMON = ['0000', '1111', '1234', '4321', '9999', '000000', '123456', '111111'];
  if (COMMON.includes(digits)) {
    return { ok: false, error: 'PIN นี้ใช้ง่ายเกินไป กรุณาตั้งค่าใหม่' };
  }
  return { ok: true };
}

/** Whether a PIN has been configured. Never throws — a read failure means "no". */
export async function isPinConfigured(state: StateStore): Promise<boolean> {
  try {
    const raw = await state.get(PIN_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as PinRecord;
    return Boolean(parsed?.hash && parsed?.salt);
  } catch {
    return false;
  }
}

/** Set or replace the PIN. Caller is responsible for authorising the change. */
export async function setDangerPin(state: StateStore, pin: string): Promise<void> {
  const check = validatePinFormat(pin);
  if (!check.ok) throw new Error(check.error);

  const digits = pin.replace(/[\s-]/g, '');
  const salt = randomHex(16);
  const hash = await pbkdf2(digits, salt, PBKDF2_ITERATIONS);
  await state.put(PIN_KEY, JSON.stringify({ hash, salt, updatedAt: Date.now() } satisfies PinRecord));
  // A new PIN clears any throttle left over from the old one.
  await state.delete(LOCKOUT_KEY).catch(() => {});
}

async function readLockout(state: StateStore): Promise<LockoutRecord> {
  try {
    const raw = await state.get(LOCKOUT_KEY);
    if (!raw) return { failures: 0, lockedUntil: 0 };
    const parsed = JSON.parse(raw) as LockoutRecord;
    return { failures: Number(parsed?.failures) || 0, lockedUntil: Number(parsed?.lockedUntil) || 0 };
  } catch {
    return { failures: 0, lockedUntil: 0 };
  }
}

export type PinVerdict =
  | { ok: true }
  | { ok: false; code: 'not_configured' | 'invalid' | 'locked_out' | 'malformed'; error: string; retryAfterMs?: number };

/**
 * Verify a presented PIN against the stored one.
 *
 * Fails closed on every uncertain path — unset, unreadable, malformed — because
 * every one of those states would otherwise mean "the reset is unprotected".
 */
export async function verifyDangerPin(state: StateStore, presented: unknown): Promise<PinVerdict> {
  const digits = normalisePin(presented);
  if (!digits) {
    return { ok: false, code: 'malformed', error: 'PIN ไม่ถูกต้อง' };
  }

  const lock = await readLockout(state);
  if (lock.lockedUntil > Date.now()) {
    const retryAfterMs = lock.lockedUntil - Date.now();
    const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
    return {
      ok: false,
      code: 'locked_out',
      error: `ใส่ PIN ผิดหลายครั้งเกินไป กรุณารอ ${minutes} นาทีแล้วลองใหม่`,
      retryAfterMs,
    };
  }

  let record: PinRecord | null = null;
  try {
    const raw = await state.get(PIN_KEY);
    if (raw) record = JSON.parse(raw) as PinRecord;
  } catch {
    record = null;
  }

  if (!record?.hash || !record?.salt) {
    return {
      ok: false,
      code: 'not_configured',
      error: 'ยังไม่ได้ตั้ง PIN ยืนยัน — กรุณาตั้งค่าในหัวข้อ “ความปลอดภัย” ก่อนใช้งาน',
    };
  }

  let candidate: string;
  try {
    candidate = await pbkdf2(digits, record.salt, PBKDF2_ITERATIONS);
  } catch {
    return { ok: false, code: 'invalid', error: 'ตรวจสอบ PIN ไม่สำเร็จ' };
  }

  if (timingSafeEqualHex(candidate, record.hash)) {
    // Correct PIN clears the failure count.
    await state.delete(LOCKOUT_KEY).catch(() => {});
    return { ok: true };
  }

  const failures = lock.failures + 1;
  const lockedUntil = failures >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0;
  await state
    .put(LOCKOUT_KEY, JSON.stringify({ failures, lockedUntil } satisfies LockoutRecord))
    .catch(() => {});

  if (lockedUntil > 0) {
    return {
      ok: false,
      code: 'locked_out',
      error: `ใส่ PIN ผิด ${failures} ครั้ง ระบบล็อกชั่วคราว 5 นาที`,
      retryAfterMs: LOCKOUT_MS,
    };
  }
  return {
    ok: false,
    code: 'invalid',
    error: `PIN ไม่ถูกต้อง (เหลืออีก ${MAX_ATTEMPTS - failures} ครั้ง)`,
    retryAfterMs: 0,
  };
}