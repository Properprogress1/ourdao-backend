// Runs before every test file. Points the shared `pool` (src/db/index.ts) at
// a dedicated test database instead of whatever DATABASE_URL is set to for
// dev, so tests never touch real data. `dotenv/config` (loaded by
// src/config.ts) only fills in env vars that aren't already set, so this
// takes precedence as long as it runs first — which vitest guarantees for
// setupFiles.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
