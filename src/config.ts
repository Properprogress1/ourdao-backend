import 'dotenv/config'

function str(name: string, fallback = ''): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function int(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Parse the CORS_ORIGIN env var into a Fastify-compatible origin value.
 *
 * - `"*"` → `"*"` (opt-in to wide-open CORS, triggers a warning)
 * - Comma-separated list → trimmed, de-deduplicated, empty entries dropped
 * - Unset / empty → `"http://localhost:3000"` (safe default)
 *
 * Exported so tests can exercise it without fighting import-time side effects.
 */
export function parseCorsOrigin(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return 'http://localhost:3000'
  if (trimmed === '*') return '*'
  const origins = [...new Set(trimmed.split(',').map((o) => o.trim()).filter(Boolean))]
  return origins.length === 1 ? origins[0]! : origins.join(',')
}

/** Resolved runtime configuration, read once at import time. */
export const config = {
  http: {
    port: int('PORT', 4000),
    host: str('HOST', '0.0.0.0'),
    corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
    rateLimitMax: int('RATE_LIMIT_MAX', 100),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitEventsMax: int('RATE_LIMIT_EVENTS_MAX', 30),
    trustProxy: str('TRUST_PROXY', 'false'),
  },
  db: {
    // pg reads PG* env vars automatically; connectionString wins when set.
    connectionString: str('DATABASE_URL') || undefined,
  },
  stellar: {
    contractId: str('CONTRACT_ID'),
    rpcUrl: str('SOROBAN_RPC_URL', 'https://soroban-testnet.stellar.org'),
    networkPassphrase: str('NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015'),
  },
  indexer: {
    startLedger: int('START_LEDGER', 0),
    startLookbackLedgers: int('START_LOOKBACK_LEDGERS', 17280),
    pollIntervalMs: int('POLL_INTERVAL_MS', 5000),
    pageLimit: int('EVENTS_PAGE_LIMIT', 100),
    // Cap for the exponential backoff applied after consecutive poll failures.
    maxBackoffMs: int('POLL_MAX_BACKOFF_MS', 60_000),
    // Max pages to drain per poll iteration (issue #3).
    maxDrainPages: int('DRAIN_MAX_PAGES', 20),
    // Max wall-clock ms for a single drain cycle (issue #3).
    maxDrainMs: int('DRAIN_MAX_MS', 30_000),
    // How long (ms) the indexer cursor can be idle before /ready reports stale.
    staleAfterMs: int('INDEXER_STALE_AFTER_MS', 120_000),
  },
} as const

export function assertContractConfigured(): string {
  if (!config.stellar.contractId) {
    throw new Error(
      'CONTRACT_ID is not set. The indexer needs the deployed OurDAO contract id to poll events.'
    )
  }
  return config.stellar.contractId
}
