import { beforeAll, expect, it } from 'vitest';
import { fetchMock, SELF } from 'cloudflare:test';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

it('returns the health response without contacting external services', async () => {
  const response = await SELF.fetch('https://worker.test/');

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
});
