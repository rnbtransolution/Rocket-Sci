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
            ADMIN_USERNAME: 'admin',
            ADMIN_PASSWORD: 'local-test-admin-password',
            ADMIN_SESSION_SECRET: 'local-test-session-secret',
            GAS_FALLBACK_URL: '',
            GAS_PROJECTION_URL: 'https://gas-projection.test/exec',
            PROJECTION_API_KEY: 'local-projection-key',
          },
        },
      },
    },
  },
});
