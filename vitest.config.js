import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{mjs,js,ts}'],
    testTimeout: 30000,
  },
});
