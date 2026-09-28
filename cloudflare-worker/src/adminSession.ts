const MAX_SESSION_AGE_MS = 30 * 60 * 1000;

function encode(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function decode(value: string): string {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return encode(String.fromCharCode(...new Uint8Array(signature)));
}

export async function createAdminSession(username: string, secret: string, issuedAt = Date.now()): Promise<{
  token: string;
  expiresAt: number;
}> {
  const expiresAt = issuedAt + MAX_SESSION_AGE_MS;
  const payload = encode(JSON.stringify({ username, issuedAt, expiresAt }));
  return { token: `${payload}.${await sign(payload, secret)}`, expiresAt };
}

export async function verifyAdminSession(
  token: string,
  secret: string,
  expectedUsername?: string,
  now = Date.now(),
): Promise<{ username: string; issuedAt: number; expiresAt: number } | null> {
  try {
    const [payload, signature, ...extra] = token.split('.');
    if (!payload || !signature || extra.length > 0) return null;
    const expected = await sign(payload, secret);
    if (signature.length !== expected.length) return null;
    let mismatch = 0;
    for (let i = 0; i < signature.length; i++) mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    if (mismatch !== 0) return null;
    const parsed = JSON.parse(decode(payload));
    if (
      !parsed ||
      typeof parsed.username !== 'string' ||
      !parsed.username ||
      (expectedUsername !== undefined && parsed.username !== expectedUsername) ||
      !Number.isSafeInteger(parsed.issuedAt) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= parsed.issuedAt ||
      parsed.expiresAt - parsed.issuedAt > MAX_SESSION_AGE_MS ||
      parsed.issuedAt > now ||
      parsed.expiresAt <= now
    ) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export { MAX_SESSION_AGE_MS };
