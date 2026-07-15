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

/** Resolved runtime configuration, read once at import time. */
export const config = {
  http: {
    port: int('PORT', 4000),
    host: str('HOST', '0.0.0.0'),
    corsOrigin: str('CORS_ORIGIN', '*'),
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
