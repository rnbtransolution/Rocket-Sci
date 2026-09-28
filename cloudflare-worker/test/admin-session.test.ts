import { expect, it } from 'vitest';
import worker from '../src/index';
import { createAdminSession } from '../src/adminSession';

const now = 1_700_000_000_000;
const config = {
  ADMIN_USERNAME: 'operator',
  ADMIN_PASSWORD: 'correct-password',
  ADMIN_SESSION_SECRET: 'session-signing-secret',
  ADMIN_API_KEY: 'legacy-key',
};

function kv() {
  return {
    get: async () => null,
    put: async () => undefined,
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://worker.test/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function call(body: unknown, headers: Record<string, string> = {}, env = config) {
  return worker.fetch(request(body, headers), {
    ...env,
    KV_CACHE: kv(),
    KV_ORDERS: kv(),
  } as never, {} as never);
}

it('logs in with configured two-field credentials and returns an expiring token', async () => {
  const response = await call({ functionName: 'adminLogin', args: ['operator', 'correct-password'] });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    data: {
      success: true,
      username: 'operator',
      token: expect.any(String),
      expiresAt: expect.any(Number),
    },
  });
  expect(JSON.stringify(body)).not.toContain('legacy-key');
});

it('rejects missing or incomplete Worker authentication configuration', async () => {
  for (const missing of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']) {
    const env = { ...config, [missing]: '' };
    const response = await call(
      { functionName: 'adminLogin', args: ['operator', 'correct-password'] },
      {},
      env,
    );
    expect(response.status).toBe(503);
  }
});

it('rejects wrong credentials', async () => {
  const response = await call({ functionName: 'adminLogin', args: ['operator', 'wrong-password'] });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ data: { success: false } });
});

it('rejects tampered, expired, and incorrectly shaped session tokens', async () => {
  const expired = await createAdminSession('operator', config.ADMIN_SESSION_SECRET, now - 31 * 60 * 1000);
  const wrongPayload = await createAdminSession('other', config.ADMIN_SESSION_SECRET, now);
  const tokens = [
    'not-a-token',
    `${wrongPayload.token.slice(0, -1)}${wrongPayload.token.endsWith('a') ? 'b' : 'a'}`,
    expired.token,
  ];
  for (const token of tokens) {
    const response = await call(
      { functionName: 'getDashboardData' },
      { authorization: `Bearer ${token}` },
    );
    expect(response.status).toBe(401);
  }
});

it('rejects unauthenticated dashboard and admin RPC requests', async () => {
  for (const functionName of ['getDashboardData', 'adminOpenRound']) {
    const response = await call({ functionName, args: [] });
    expect(response.status).toBe(401);
  }
});

it('keeps health and login public', async () => {
  const health = await worker.fetch(new Request('https://worker.test/health'), config as never, {} as never);
  expect(health.status).toBe(200);
  const login = await call({ functionName: 'adminLogin', args: ['operator', 'correct-password'] });
  expect(login.status).toBe(200);
});
