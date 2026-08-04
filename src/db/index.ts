import { Pool, types, type PoolClient, type QueryResultRow } from 'pg'
import { config } from '../config.js'

// pg returns BIGINT (OID 20) as a string by default, to avoid silently
// truncating values beyond Number.MAX_SAFE_INTEGER. Every BIGINT column in
// this schema is a ledger sequence number (well under that range) and is
// typed `number` in src/types.ts, so parse it as one instead.
types.setTypeParser(20, (val: string) => Number.parseInt(val, 10))

// A single shared pool. pg picks up PG* env vars automatically; a
// DATABASE_URL connection string takes precedence when provided.
export const pool = new Pool(
  config.db.connectionString ? { connectionString: config.db.connectionString } : {}
)

pool.on('error', (err) => {
  // Background idle-client errors shouldn't crash the process.
  console.error('[db] unexpected idle client error:', err.message)
})

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(text, params as unknown[])
  return res.rows
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/** Run a set of statements inside a transaction. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
