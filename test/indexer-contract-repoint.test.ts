import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../src/db/index.js'
import { ensureCursorContract, resetForContractChange } from '../src/indexer/poller.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'

// Issue #16: repointing CONTRACT_ID at a new deployment must not silently
// merge two deployments' derived state. INDEXER_RESET_ON_CONTRACT_CHANGE is
// read at config import time and defaults to false in the test env, so these
// cover the default (refuse) path plus the reset primitive directly.
describe('indexer: contract repoint guard', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  async function seedCursor(contractId: string): Promise<void> {
    await pool.query(
      `INSERT INTO indexer_cursor (id, paging_token, last_ledger, contract_id)
       VALUES (1, 'tok', 42, $1)
       ON CONFLICT (id) DO UPDATE SET contract_id = $1`,
      [contractId]
    )
  }

  it('refuses to start when the saved cursor belongs to a different contract', async () => {
    await seedCursor('COLDCONTRACT')
    await expect(ensureCursorContract('CNEWCONTRACT')).rejects.toThrow(/belongs to contract COLDCONTRACT/)
  })

  it('is a no-op when the cursor matches the configured contract', async () => {
    await seedCursor('CSAME')
    await expect(ensureCursorContract('CSAME')).resolves.toBeUndefined()
    const rows = await query('SELECT * FROM indexer_cursor WHERE id = 1')
    expect(rows).toHaveLength(1)
  })

  it('is a no-op on a cold start with no saved cursor', async () => {
    await expect(ensureCursorContract('CANYTHING')).resolves.toBeUndefined()
  })

  it('resetForContractChange clears the cursor and derived tables but keeps the raw events log', async () => {
    const client = await pool.connect()
    try {
      await applyEvent(client, decodedEvent('joined', { member: 'GA', fee: '10' }))
      await applyEvent(client, decodedEvent('loan_req', { id: 1, borrower: 'GA', amount: '5', total_repayment: '6' }))
    } finally {
      client.release()
    }
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('raw-1', 100, now(), 'COLDCONTRACT', 'joined', '[]', '[]')`
    )
    await seedCursor('COLDCONTRACT')

    await resetForContractChange()

    expect(await query('SELECT * FROM members')).toEqual([])
    expect(await query('SELECT * FROM loan_proposals')).toEqual([])
    expect(await query('SELECT * FROM indexer_cursor')).toEqual([])
    // The append-only audit trail is untouched.
    expect((await query('SELECT * FROM events')).length).toBeGreaterThan(0)
  })
})
