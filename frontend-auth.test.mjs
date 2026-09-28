import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SESSION_AGE_MS,
  clearStoredAdminSession,
  getStoredAdminSession,
  isValidLoginSession,
  requireAdminToken,
} from './frontendAuth.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    snapshot: () => Object.fromEntries(values),
  };
}

test('rejects expired login responses and accepts only future sessions within 30 minutes', () => {
  const now = 1_000_000;
  assert.equal(isValidLoginSession({
    success: true,
    token: 'expired',
    expiresAt: now,
    username: 'admin',
  }, now), false);
  assert.equal(isValidLoginSession({
    success: true,
    token: 'valid',
    expiresAt: now + MAX_SESSION_AGE_MS,
    username: 'admin',
  }, now), true);
  assert.equal(isValidLoginSession({
    success: true,
    token: 'too-long',
    expiresAt: now + MAX_SESSION_AGE_MS + 1,
    username: 'admin',
  }, now), false);
});

test('reads valid stored sessions and clears invalid or expired state', () => {
  const now = 2_000_000;
  const valid = storage({
    rocket_admin_auth: 'true',
    rocket_admin_user: 'admin',
    rocket_admin_token: 'token',
    rocket_admin_expires_at: String(now + 1000),
  });
  assert.deepEqual(getStoredAdminSession(valid, now), {
    username: 'admin',
    token: 'token',
    expiresAt: now + 1000,
  });

  for (const invalid of [
    { rocket_admin_auth: 'true', rocket_admin_user: 'admin', rocket_admin_token: 'token', rocket_admin_expires_at: String(now - 1) },
    { rocket_admin_auth: 'true', rocket_admin_user: 'admin', rocket_admin_token: '', rocket_admin_expires_at: String(now + 1000) },
  ]) {
    const store = storage(invalid);
    assert.equal(getStoredAdminSession(store, now), null);
    assert.deepEqual(store.snapshot(), {});
  }
});

test('clears username, token, expiry, and auth flag', () => {
  const store = storage({
    rocket_admin_auth: 'true',
    rocket_admin_user: 'admin',
    rocket_admin_token: 'token',
    rocket_admin_expires_at: '123',
  });
  clearStoredAdminSession(store);
  assert.deepEqual(store.snapshot(), {});
});

test('denies protected calls without a token but allows admin login', () => {
  assert.throws(() => requireAdminToken(null, 'getDashboardData'), /admin session token/i);
  assert.throws(() => requireAdminToken('', 'saveOpenBet'), /admin session token/i);
  assert.equal(requireAdminToken(null, 'adminLogin'), null);
  assert.equal(requireAdminToken('token', 'adminLogin'), 'token');
});
