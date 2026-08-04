import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // DB-backed tests do real round trips against a local Postgres.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    setupFiles: ['./test/setup.ts'],
    // All DB-backed test files share one physical test database (see
    // test/db.ts). Running files in parallel lets one file's
    // `resetDb()` TRUNCATE race another file's in-flight assertions —
    // observed as flaky failures. Serialize file execution instead.
    fileParallelism: false,
  },
})
