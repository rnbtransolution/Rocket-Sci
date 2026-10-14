/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin session tokens
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS REPLACES THE PREVIOUS DESIGN
 * -------------------------------------
 * The Admin Console used to hold the long-lived `ADMIN_API_KEY` itself and send
 * it on every request. That key was read from `import.meta.env.VITE_ADMIN_API_KEY`,
 * which Vite inlines into the JavaScript bundle at BUILD time — so the "secret"
 * was served to every anonymous visitor in the page source. Anyone could copy it
 * and perform any admin action, including Factory Reset.
 *
 * The fix separates the two concerns:
 *   • The password stays server-side (Wrangler secret) and is only ever used to
 *     authenticate a login.
 *   • The browser receives a short-lived, signed, scoped token that is useless if
 *     stolen on its own — it cannot be used to authenticate a new session, and it
 *     expires on its own without needing a server-side session store.
 *
 * The token is HMAC-SHA256 signed with SESSION_SECRET, which is independent of
 * ADMIN_API_KEY. Rotating the admin password therefore does not invalidate live
 * sessions, and vice versa.
 *
 * Format: base64url(payload).base64url(signature)
 */

const TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8 hours — one working shift.

export type AdminRole = 'superadmin' | 'admin';

/**
 * What a session is permitted to do.
 *
 * `full`   — normal admin access.
 * `reset`  — may ONLY change/reset a password and read its status.
 *
 * A password that has expired blocks ordinary admin actions. Without a
 * restricted scope there would be no way back in to fix it, since the operator
 * cannot perform any action — including the password change that would clear
 * the block. So expiry mints a `reset` session instead of refusing outright.
 */
export type SessionScope = 'full' | 'reset';

export interface SessionClaims {
  /** Username the session belongs to. */
  sub: string;
  role: AdminRole;
  scope: SessionScope;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

/** Constant-time string comparison — avoids leaking the value via timing. */
export function timingSafeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still walk a bounded number of characters so length alone is not a
    // fast-path oracle, then report mismatch.
    let diff = 1;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0 && false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Issue a signed session token for a successfully-authenticated admin. */
export async function issueSessionToken(
  username: string,
  role: AdminRole,
  secret: string,
  ttlSeconds: number = TOKEN_TTL_SECONDS,
  scope: SessionScope = 'full'
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    sub: username,
    role,
    scope,
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = base64UrlEncode(await hmac(secret, payload));
  return `${payload}.${signature}`;
}

/**
 * Verify a session token.
 * Returns the claims on success, or null if the token is malformed, forged,
 * expired, or was signed with a different secret.
 */
export async function verifySessionToken(
  token: string,
  secret: string
): Promise<SessionClaims | null> {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;

  let expected: Uint8Array;
  try {
    expected = await hmac(secret, payload);
  } catch (_) {
    return null;
  }

  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(signature);
  } catch (_) {
    return null;
  }

  if (provided.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  if (diff !== 0) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch (_) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!claims || typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (claims.role !== 'superadmin' && claims.role !== 'admin') return null;
  // Tokens issued before scopes existed default to full access; an unknown
  // scope value is rejected rather than trusted.
  if (claims.scope !== 'full' && claims.scope !== 'reset') return null;

  return claims;
}

/**
 * Login throttle policy. The counters themselves live in the Durable Object
 * (`rateLimit`) rather than in this module: an isolate-scoped Map resets on
 * every cold start and deployment, which an attacker triggers for free by
 * simply waiting or forcing a redeploy.
 */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Compute a fixed-window decision from a stored counter. */
export function evaluateRateLimit(
  entry: { count: number; resetAt: number } | null | undefined,
  now: number = Date.now()
): { decision: RateLimitDecision; next: { count: number; resetAt: number } } {
  if (!entry || entry.resetAt <= now) {
    return {
      decision: { allowed: true, retryAfterSeconds: 0 },
      next: { count: 1, resetAt: now + WINDOW_MS },
    };
  }
  const count = entry.count + 1;
  const next = { count, resetAt: entry.resetAt };
  if (count > MAX_ATTEMPTS) {
    return {
      decision: { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) },
      next,
    };
  }
  return { decision: { allowed: true, retryAfterSeconds: 0 }, next };
}