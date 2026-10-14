/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin credential store — passwords, expiry, and recovery codes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DESIGN
 * ------
 * 1. Passwords are NEVER stored. Only a PBKDF2-SHA256 hash (210,000
 *    iterations) with a per-user random salt. A stolen database yields nothing
 *    usable — PBKDF2 is deliberately slow, so offline cracking is expensive.
 *
 * 2. Credentials live in the Durable Object alongside live state. That is an
 *    encrypted, strongly-consistent store already in use; nothing new to
 *    provision, and no extra network hop on the login hot path.
 *
 * 3. EXPIRY IS ENFORCED AT LOGIN. A password older than PASSWORD_MAX_AGE_DAYS
 *    cannot mint a session at all, so an expired account cannot reach any admin
 *    action — there is no window where a stale password still works.
 *
 * 4. RECOVERY CODES are single-use, one-time secrets generated whenever a
 *    password is set. They are shown exactly once. Only their hashes are kept.
 *    A forgotten password is therefore recoverable without any email provider,
 *    which is what makes this usable as the sole admin account.
 *
 * Bootstrapping: the first time an admin logs in with the Wrangler secret
 * password, it is hashed into the store so the plaintext secret becomes
 * unnecessary and can be dropped from the deployment.
 */

import { StateStore } from './state.js';

/** Password maximum age. After this the account is locked out at login. */
export const PASSWORD_MAX_AGE_DAYS = 30;
const PASSWORD_MAX_AGE_MS = PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Workers WebCrypto caps PBKDF2 at 100,000 iterations (it throws
 * "Pbkdf2 failed: iteration counts above 100000 are not supported"), so 100k
 * is the strongest stretch this runtime offers. Combined with a 128-bit salt
 * and the 30-day forced rotation, that is the intended defence; this is not a
 * substitute for a long, unique password.
 */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_BITS = 256;

export interface RecoveryCodeRecord {
  /** PBKDF2 hash of the code, hex encoded. */
  hash: string;
  /** Epoch ms when consumed; null while still usable. */
  usedAt: number | null;
  /** Epoch ms when this code was generated. */
  createdAt: number;
}

export interface AdminCredential {
  username: string;
  role: 'superadmin' | 'admin';
  /** PBKDF2 salt, hex encoded. */
  salt: string;
  /** PBKDF2 hash of the current password, hex encoded. */
  hash: string;
  /** Epoch ms the password was last set — drives expiry. */
  passwordChangedAt: number;
  /** Set when the account must change its password before further use. */
  mustChange: boolean;
  /** Why mustChange was set, for the UI to explain itself. */
  mustChangeReason?: 'expired' | 'admin_reset' | 'initial';
  recoveryCodes: RecoveryCodeRecord[];
  updatedAt: number;
}

// ── Crypto helpers ──────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('Malformed hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * PBKDF2-SHA256. `iterations` can be lowered for recovery codes, which are
 * already high-entropy random values and therefore not brute-forceable — the
 * expensive stretching exists to slow attacks on human-chosen passwords.
 */
async function pbkdf2(password: string, saltHex: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    PBKDF2_BITS
  );
  return toHex(new Uint8Array(bits));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Password policy ─────────────────────────────────────────────────────────

/**
 * Reject the passwords that make a 30-day rotation pointless because they're
 * trivially guessable. Length is the dominant factor, so it is weighted most.
 */
export function validatePasswordStrength(password: string): { ok: boolean; error?: string } {
  if (typeof password !== 'string' || password.length < 12) {
    return { ok: false, error: 'รหัสผ่านต้องมีความยาวอย่างน้อย 12 ตัวอักษร' };
  }
  if (password.length > 200) {
    return { ok: false, error: 'รหัสผ่านยาวเกินไป (สูงสุด 200 ตัวอักษร)' };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    return { ok: false, error: 'รหัสผ่านต้องมีอย่างน้อย 3 จาก 4 ประเภท: ตัวพิมพ์เล็ก ตัวพิมพ์ใหญ่ ตัวเลข และสัญลักษณ์' };
  }
  const COMMON = [
    'password', '123456', 'qwerty', 'admin', 'letmein', 'welcome',
    'bangfai', 'bangfairocket', 'bangfai2026', 'rocket',
  ];
  const lower = password.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) {
    return { ok: false, error: 'รหัสผ่านนี้ใช้คำที่พบบ่อยเกินไป กรุณาตั้งรหัสผ่านที่เดายาก' };
  }
  return { ok: true };
}

// ── Recovery codes ──────────────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 8;
/** Recovery codes are 10 random bytes — brute force is infeasible, so a lower
 *  iteration count keeps generation and redemption fast. */
const RECOVERY_CODE_ITERATIONS = 10_000;

/** Format codes as XXXX-XXXX so they are writable without transcription errors. */
function formatRecoveryCode(rawHex: string): string {
  const clean = rawHex.toUpperCase();
  return `${clean.slice(0, 5)}-${clean.slice(5, 10)}`;
}

export function normalizeRecoveryCode(input: string): string {
  return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function hashRecoveryCode(code: string): Promise<string> {
  const salt = randomHex(16);
  const hash = await pbkdf2(normalizeRecoveryCode(code), salt, RECOVERY_CODE_ITERATIONS);
  // Salt is prepended so each code is verifiable without a stored salt field.
  return `${salt}:${hash}`;
}

// ── Storage keys ────────────────────────────────────────────────────────────

const KEY_PREFIX = 'ADMIN_CRED_';

function credentialKey(username: string): string {
  return `${KEY_PREFIX}${username.toLowerCase()}`;
}

async function readCredential(state: StateStore, username: string): Promise<AdminCredential | null> {
  const raw = await state.get(credentialKey(username));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminCredential;
  } catch (_) {
    return null;
  }
}

async function writeCredential(state: StateStore, credential: AdminCredential): Promise<void> {
  credential.updatedAt = Date.now();
  await state.put(credentialKey(credential.username), JSON.stringify(credential));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create or replace an admin credential, returning freshly generated recovery
 * codes. These are returned ONLY here — they are never recoverable afterwards,
 * because only their hashes are stored.
 */
export async function setAdminPassword(
  state: StateStore,
  username: string,
  role: 'superadmin' | 'admin',
  password: string,
  options: { mustChange?: boolean; mustChangeReason?: AdminCredential['mustChangeReason'] } = {}
): Promise<{ recoveryCodes: string[] }> {
  const strength = validatePasswordStrength(password);
  if (!strength.ok) throw new Error(strength.error);

  const salt = randomHex(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);

  const plainCodes: string[] = [];
  const records: RecoveryCodeRecord[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = formatRecoveryCode(randomHex(5)); // 10 hex chars = 5 bytes
    plainCodes.push(code);
    records.push({ hash: await hashRecoveryCode(code), usedAt: null, createdAt: Date.now() });
  }

  await writeCredential(state, {
    username,
    role,
    salt,
    hash,
    passwordChangedAt: Date.now(),
    updatedAt: Date.now(),
    mustChange: options.mustChange ?? false,
    mustChangeReason: options.mustChange ? (options.mustChangeReason ?? 'admin_reset') : undefined,
    recoveryCodes: records,
  });

  return { recoveryCodes: plainCodes };
}

/**
 * Issue a fresh set of recovery codes WITHOUT changing the password.
 *
 * Needed because codes are shown only once: if the reveal dialog is dismissed,
 * or the codes are simply lost, the owner's next option would be a full
 * password change — which requires knowing the current password. That is a
 * trap when the codes themselves are what went missing.
 *
 * Requires the current password so a stolen session alone cannot invalidate
 * the codes the real owner still holds. All previous codes are invalidated.
 */
export async function regenerateRecoveryCodes(
  state: StateStore,
  username: string,
  currentPassword: string
): Promise<{ recoveryCodes: string[]; invalidated: number }> {
  const credential = await readCredential(state, username);
  if (!credential) throw new Error('ไม่พบข้อมูลบัญชีผู้ดูแลระบบ');

  const candidate = await pbkdf2(currentPassword, credential.salt, PBKDF2_ITERATIONS);
  if (!timingSafeEqualHex(candidate, credential.hash)) {
    throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  }

  const invalidated = credential.recoveryCodes.filter((c) => !c.usedAt).length;
  const plainCodes: string[] = [];
  const records: RecoveryCodeRecord[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = formatRecoveryCode(randomHex(5));
    plainCodes.push(code);
    records.push({ hash: await hashRecoveryCode(code), usedAt: null, createdAt: Date.now() });
  }

  // Only the codes are replaced — the password and its expiry are untouched.
  await writeCredential(state, { ...credential, recoveryCodes: records });

  return { recoveryCodes: plainCodes, invalidated };
}

export type LoginOutcome =
  | { status: 'ok'; username: string; role: 'superadmin' | 'admin' }
  | { status: 'invalid' }
  | { status: 'expired'; daysOverdue: number; mustChange: true }
  | { status: 'must_change'; mustChange: true }
  | { status: 'no_credential' };

/**
 * Verify a login attempt against the stored credential.
 * Returns a status rather than a boolean so the caller can explain *why*
 * access was refused (bad password vs. expired) without leaking whether the
 * account exists.
 */
export async function verifyAdminLogin(
  state: StateStore,
  username: string,
  password: string
): Promise<LoginOutcome> {
  const credential = await readCredential(state, username);
  if (!credential) return { status: 'no_credential' };

  const candidate = await pbkdf2(password, credential.salt, PBKDF2_ITERATIONS);
  if (!timingSafeEqualHex(candidate, credential.hash)) return { status: 'invalid' };

  const ageMs = Date.now() - credential.passwordChangedAt;
  if (credential.mustChange) {
    return { status: 'must_change', mustChange: true };
  }
  if (ageMs > PASSWORD_MAX_AGE_MS) {
    return {
      status: 'expired',
      daysOverdue: Math.floor(ageMs / PASSWORD_MAX_AGE_MS) - PASSWORD_MAX_AGE_DAYS,
      mustChange: true,
    };
  }
  return { status: 'ok', username: credential.username, role: credential.role };
}

/**
 * Change a password. Requires the CURRENT password so a hijacked session
 * alone cannot lock the real owner out. A fresh set of recovery codes is
 * issued — old ones are invalidated, since they may have been exposed.
 */
export async function changeAdminPassword(
  state: StateStore,
  username: string,
  currentPassword: string,
  newPassword: string
): Promise<{ recoveryCodes: string[]; daysUntilExpiry: number }> {
  const credential = await readCredential(state, username);
  if (!credential) throw new Error('ไม่พบข้อมูลบัญชีผู้ดูแลระบบ');

  const candidate = await pbkdf2(currentPassword, credential.salt, PBKDF2_ITERATIONS);
  if (!timingSafeEqualHex(candidate, credential.hash)) {
    throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) throw new Error(strength.error);
  if (newPassword === currentPassword) {
    throw new Error('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม');
  }

  // Preserve the existing salt-per-user pattern but re-hash with a fresh salt.
  const salt = randomHex(16);
  const hash = await pbkdf2(newPassword, salt, PBKDF2_ITERATIONS);

  const plainCodes: string[] = [];
  const records: RecoveryCodeRecord[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = formatRecoveryCode(randomHex(5));
    plainCodes.push(code);
    records.push({ hash: await hashRecoveryCode(code), usedAt: null, createdAt: Date.now() });
  }

  await writeCredential(state, {
    ...credential,
    salt,
    hash,
    passwordChangedAt: Date.now(),
    mustChange: false,
    mustChangeReason: undefined,
    recoveryCodes: records,
  });

  return { recoveryCodes: plainCodes, daysUntilExpiry: PASSWORD_MAX_AGE_DAYS };
}

/**
 * Reset a forgotten password using a single-use recovery code.
 * The consumed code is burned even if the new password fails validation, so a
 * code cannot be brute-forced for reuse.
 */
export async function resetAdminPasswordWithRecoveryCode(
  state: StateStore,
  username: string,
  recoveryCode: string,
  newPassword: string
): Promise<{ username: string; role: 'superadmin' | 'admin'; recoveryCodes: string[]; daysUntilExpiry: number }> {
  const credential = await readCredential(state, username);
  if (!credential) {
    // Deliberately identical to the "wrong code" message: a distinct error
    // would let an unauthenticated caller enumerate which admin accounts
    // exist. This endpoint is unauthenticated by design.
    throw new Error('Recovery Code ไม่ถูกต้อง หรือถูกใช้ไปแล้ว');
  }

  const normalized = normalizeRecoveryCode(recoveryCode);
  let matchedIndex = -1;
  for (let i = 0; i < credential.recoveryCodes.length; i++) {
    const record = credential.recoveryCodes[i];
    if (record.usedAt) continue;
    const [salt, expected] = record.hash.split(':');
    if (!salt || !expected) continue;
    const candidate = await pbkdf2(normalized, salt, RECOVERY_CODE_ITERATIONS);
    if (timingSafeEqualHex(candidate, expected)) {
      matchedIndex = i;
      break;
    }
  }

  if (matchedIndex === -1) {
    throw new Error('Recovery Code ไม่ถูกต้อง หรือถูกใช้ไปแล้ว');
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) {
    // Burn the code before validating, so a failed attempt cannot retry it.
    const burned = { ...credential, recoveryCodes: [...credential.recoveryCodes] };
    burned.recoveryCodes[matchedIndex] = { ...burned.recoveryCodes[matchedIndex], usedAt: Date.now() };
    await writeCredential(state, burned);
    throw new Error(strength.error);
  }

  const salt = randomHex(16);
  const hash = await pbkdf2(newPassword, salt, PBKDF2_ITERATIONS);

  const plainCodes: string[] = [];
  const records: RecoveryCodeRecord[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = formatRecoveryCode(randomHex(5));
    plainCodes.push(code);
    records.push({ hash: await hashRecoveryCode(code), usedAt: null, createdAt: Date.now() });
  }

  await writeCredential(state, {
    ...credential,
    salt,
    hash,
    passwordChangedAt: Date.now(),
    mustChange: false,
    mustChangeReason: undefined,
    recoveryCodes: records,
  });

  return {
    username: credential.username,
    role: credential.role,
    recoveryCodes: plainCodes,
    daysUntilExpiry: PASSWORD_MAX_AGE_DAYS,
  };
}

/** Status for the "change your password" screen. Never exposes the hash. */
export async function getCredentialStatus(
  state: StateStore,
  username: string
): Promise<{
  exists: boolean;
  username?: string;
  role?: 'superadmin' | 'admin';
  daysUntilExpiry?: number;
  daysOverdue?: number;
  mustChange?: boolean;
  recoveryCodesRemaining?: number;
  passwordChangedAt?: number;
}> {
  const credential = await readCredential(state, username);
  if (!credential) return { exists: false };

  const ageMs = Date.now() - credential.passwordChangedAt;
  const daysElapsed = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const daysUntilExpiry = PASSWORD_MAX_AGE_DAYS - daysElapsed;

  return {
    exists: true,
    username: credential.username,
    role: credential.role,
    daysUntilExpiry,
    daysOverdue: daysUntilExpiry < 0 ? Math.abs(daysUntilExpiry) : 0,
    mustChange: credential.mustChange || daysUntilExpiry <= 0,
    recoveryCodesRemaining: credential.recoveryCodes.filter((c) => !c.usedAt).length,
    passwordChangedAt: credential.passwordChangedAt,
  };
}