import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    env: {
      TG_TOKEN: 'test-token',
      TG_GROUP_ID: '-1001234567890',
    },
  },
});
