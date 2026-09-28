import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            LINE_CHANNEL_SECRET: 'local-test-secret',
            LINE_CHANNEL_ACCESS_TOKEN: 'local-test-token',
            ADMIN_API_KEY: 'local-test-admin-key',
            GAS_FALLBACK_URL: '',
          },
        },
      },
    },
  },
});
