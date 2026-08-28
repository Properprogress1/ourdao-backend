import type { PoolClient } from 'pg'
import { pool } from '../db/index.js'
import { applyEvent } from './handlers.js'
import { namedFields, type DecodedEvent } from '../stellar/events.js'

interface EventLogRow {
  id: string
  ledger: number
  closed_at: Date | string
  contract_id: string
  symbol: string
  topics: unknown
  data: unknown
  tx_hash: string | null
}

// Everything derived from the raw `events` log. `events`, `schema_migrations`
// and `indexer_cursor` are deliberately not touched — the point is to rebuild
// derived state *from* the untouched raw log.
const DERIVED_TABLES = [
  'notifications',
  'treasury_proposals',
  'loans',
  'loan_proposals',
  'members',
  'interest_distributions',
  'documents',
] as const

/**
 * Rebuild every derived table from the raw `events` log (issue #23).
 *
 * The incremental fold the indexer runs and a full rebuild from the log must
 * produce byte-identical derived state — that property is what makes the raw
 * log authoritative and makes re-indexing a real recovery mechanism: for a
 * detected ledger discontinuity, and for the historical-data bugs tracked in
 * other issues in this repo (rejoin double-counting, missing default
 * penalties, unweighted tallies) which this command repairs in one pass.
 *
 * Runs in a single transaction — the whole rebuild lands or none of it does.
 */
export async function reindexFromEventLog(): Promise<{ events: number }> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`TRUNCATE ${DERIVED_TABLES.join(', ')} RESTART IDENTITY`)
    // dao_totals is a fixed single row — reset in place rather than truncate.
    await client.query(
      `UPDATE dao_totals
          SET interest_collected = 0, principal_lent = 0,
              principal_repaid = 0, value_defaulted = 0, updated_at = now()
        WHERE id = 1`
    )

    const { rows } = await client.query<EventLogRow>(
      `SELECT id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash
         FROM events ORDER BY ledger ASC, id ASC`
    )

    for (const row of rows) {
      const data = Array.isArray(row.data) ? (row.data as unknown[]) : [row.data]
      const ev: DecodedEvent = {
        id: row.id,
        ledger: row.ledger,
        closedAt:
          row.closed_at instanceof Date ? row.closed_at.toISOString() : String(row.closed_at),
        contractId: row.contract_id,
        txHash: row.tx_hash,
        symbol: row.symbol,
        topics: Array.isArray(row.topics) ? (row.topics as unknown[]) : [],
        data,
        fields: namedFields(row.symbol, data),
      }
      await applyEvent(client, ev)
    }

    await client.query('COMMIT')
    return { events: rows.length }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// `npm run reindex`
if (import.meta.url === `file://${process.argv[1]}`) {
  reindexFromEventLog()
    .then(({ events }) => {
      console.log(`[reindex] rebuilt derived tables from ${events} event(s)`)
      return pool.end()
    })
    .catch((err) => {
      console.error('[reindex] failed:', err)
      process.exit(1)
    })
}
