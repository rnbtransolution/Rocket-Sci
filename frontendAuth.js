export const MAX_SESSION_AGE_MS = 30 * 60 * 1000;

const SESSION_KEYS = [
  'rocket_admin_auth',
  'rocket_admin_user',
  'rocket_admin_token',
  'rocket_admin_expires_at',
];

export function isValidLoginSession(session, now = Date.now()) {
  const expiresAt = Number(session?.expiresAt);
  return Boolean(
    session?.success &&
    typeof session.token === 'string' &&
    session.token &&
    Number.isFinite(expiresAt) &&
    expiresAt > now &&
    expiresAt <= now + MAX_SESSION_AGE_MS
  );
}

export function clearStoredAdminSession(storage) {
  for (const key of SESSION_KEYS) storage?.removeItem(key);
}

export function getStoredAdminSession(storage, now = Date.now()) {
  const token = storage?.getItem('rocket_admin_token');
  const username = storage?.getItem('rocket_admin_user');
  const expiresAt = Number(storage?.getItem('rocket_admin_expires_at'));
  if (
    typeof token === 'string' &&
    token &&
    typeof username === 'string' &&
    username &&
    Number.isFinite(expiresAt) &&
    expiresAt > now &&
    expiresAt <= now + MAX_SESSION_AGE_MS
  ) {
    return { username, token, expiresAt };
  }
  clearStoredAdminSession(storage);
  return null;
}

const PUBLIC_FUNCTIONS = new Set(['adminLogin', 'health']);

export function requireAdminToken(token, functionName) {
  if (PUBLIC_FUNCTIONS.has(functionName)) return token || null;
  if (typeof token !== 'string' || !token) {
    throw new Error('Valid admin session token required');
  }
  return token;
}
