import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // DB-backed tests do real round trips against a local Postgres.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    setupFiles: ['./test/setup.ts'],
  },
})
