// Issue #44: doc_attn was in the event catalog but had no handler, so there
// was no way to list a proposal's attached documents' existence/history
// off-chain. Covers the handler (idempotency, kind normalization) and the
// reindex rebuild.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { reindexFromEventLog } from '../src/indexer/reindex.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DocumentRow } from '../src/types.js'

async function ingest(client: PoolClient, ev: ReturnType<typeof decodedEvent>): Promise<void> {
  await client.query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol,
     JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash]
  )
  await applyEvent(client, ev)
}

describe('indexer handlers: doc_attn (issue #44)', () => {
  let client: PoolClient
  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => client.release())
  afterAll(closeDb)

  it('records one documents row per event, without touching loan_proposals/treasury_proposals', async () => {
    await applyEvent(client, decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 7, caller: 'GBORROWER' }))

    const rows = await query<DocumentRow>('SELECT * FROM documents')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ proposal_id: 7, kind: 'loan', caller: 'GBORROWER' })
    expect(await query('SELECT * FROM loan_proposals')).toHaveLength(0)
  })

  it('normalizes the ProposalKind contract enum regardless of how scValToNative surfaces it', async () => {
    await applyEvent(client, decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 1, caller: 'GA' }))
    await applyEvent(client, decodedEvent('doc_attn', { kind: ['Treasury'], proposal_id: 2, caller: 'GB' }))
    await applyEvent(client, decodedEvent('doc_attn', { kind: { tag: 'Loan', values: undefined }, proposal_id: 3, caller: 'GC' }))

    const rows = await query<{ proposal_id: number; kind: string }>('SELECT proposal_id, kind FROM documents ORDER BY proposal_id')
    expect(rows).toEqual([
      { proposal_id: 1, kind: 'loan' },
      { proposal_id: 2, kind: 'treasury' },
      { proposal_id: 3, kind: 'loan' },
    ])
  })

  it('loan and treasury proposals with the same numeric id are kept distinct by kind', async () => {
    await applyEvent(client, decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 4, caller: 'GA' }))
    await applyEvent(client, decodedEvent('doc_attn', { kind: 'Treasury', proposal_id: 4, caller: 'GB' }))

    const rows = await query<{ kind: string; caller: string }>('SELECT kind, caller FROM documents WHERE proposal_id = 4 ORDER BY kind')
    expect(rows).toEqual([
      { kind: 'loan', caller: 'GA' },
      { kind: 'treasury', caller: 'GB' },
    ])
  })

  it('a re-delivered doc_attn event folds exactly once (event_id UNIQUE)', async () => {
    const ev = decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 1, caller: 'GA' })
    await applyEvent(client, ev)
    await applyEvent(client, ev)
    expect(await query('SELECT * FROM documents')).toHaveLength(1)
  })

  it('multiple attachments to the same proposal are kept as history, not overwritten', async () => {
    await applyEvent(client, decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 1, caller: 'GA' }))
    await applyEvent(client, decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 1, caller: 'GA' }))
    expect(await query('SELECT * FROM documents WHERE proposal_id = 1')).toHaveLength(2)
  })

  it('npm run reindex rebuilds documents from the raw log identically', async () => {
    const events = [
      decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 1, caller: 'GA' }),
      decodedEvent('doc_attn', { kind: 'Treasury', proposal_id: 2, caller: 'GB' }),
      decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 1, caller: 'GA' }),
    ]
    for (const ev of events) await ingest(client, ev)

    const before = await query('SELECT event_id, proposal_id, kind, caller FROM documents ORDER BY id')
    client.release()
    const { events: replayed } = await reindexFromEventLog()
    expect(replayed).toBe(events.length)
    client = await pool.connect()
    const after = await query('SELECT event_id, proposal_id, kind, caller FROM documents ORDER BY id')

    expect(after).toEqual(before)
    expect(after).toHaveLength(3)
  })
})
