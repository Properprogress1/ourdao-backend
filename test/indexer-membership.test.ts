import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { MemberRow, NotificationRow } from '../src/types.js'

describe('indexer handlers: membership', () => {
  let client: PoolClient

  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => client.release())
  afterAll(closeDb)

  it('joined creates a new member with their fee as contribution', async () => {
    const ev = decodedEvent('joined', { member: 'GALICE', fee: '500' })
    await applyEvent(client, ev)

    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GALICE'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.contribution).toBe('500')
    expect(rows[0]?.exited).toBe(false)
    expect(rows[0]?.joined_ledger).toBe(ev.ledger)

    const notifs = await query<NotificationRow>(
      'SELECT * FROM notifications WHERE address = $1',
      ['GALICE']
    )
    expect(notifs).toHaveLength(1)
    expect(notifs[0]?.type).toBe('success')
  })

  it('joining again for the same address replaces contribution rather than accumulating it, matching the contract', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBOB', fee: '100' }))
    await applyEvent(client, decodedEvent('joined', { member: 'GBOB', fee: '50' }))

    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GBOB'])
    expect(rows[0]?.contribution).toBe('50')
  })

  it('a join -> exit -> rejoin sequence leaves contribution at a single fee, with no residue of the previous membership', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GEVE', fee: '100' }))
    await applyEvent(client, decodedEvent('loan_appr', { id: 900, borrower: 'GEVE', amount: '1' }))
    await applyEvent(client, decodedEvent('exited', { member: 'GEVE', share: '120' }))
    await applyEvent(client, decodedEvent('joined', { member: 'GEVE', fee: '100' }))

    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GEVE'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.contribution).toBe('100')
    expect(rows[0]?.exited).toBe(false)
    expect(rows[0]?.exit_share).toBeNull()
    expect(rows[0]?.exited_ledger).toBeNull()
    expect(rows[0]?.has_active_loan).toBe(false)
  })

  it('exited marks a member inactive and records their exit share', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GCAROL', fee: '200' }))
    const exitEv = decodedEvent('exited', { member: 'GCAROL', share: '220' })
    await applyEvent(client, exitEv)

    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GCAROL'])
    expect(rows[0]?.exited).toBe(true)
    expect(rows[0]?.exit_share).toBe('220')
    expect(rows[0]?.exited_ledger).toBe(exitEv.ledger)
  })

  it('exited zeroes the member\'s stake and clears has_active_loan, mirroring exit_dao (issue #13)', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GFRANK', fee: '100' }))
    await applyEvent(client, decodedEvent('staked', { member: 'GFRANK', amount: '400', new_stake: '400' }))
    await applyEvent(client, decodedEvent('claimed', { member: 'GFRANK', pending: '25' }))
    await applyEvent(client, decodedEvent('loan_appr', { id: 950, borrower: 'GFRANK', amount: '1' }))
    await applyEvent(client, decodedEvent('exited', { member: 'GFRANK', share: '150' }))

    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GFRANK'])
    expect(rows[0]?.stake).toBe('0')
    expect(rows[0]?.has_active_loan).toBe(false)
    // pending_claimed is an indexer-only lifetime counter and is intentionally
    // NOT reset on exit.
    expect(rows[0]?.pending_claimed).toBe('25')
  })

  it('claimed accumulates pending_claimed for the member across multiple claims', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GDAVE', fee: '10' }))
    await applyEvent(client, decodedEvent('claimed', { member: 'GDAVE', pending: '30' }))
    await applyEvent(client, decodedEvent('claimed', { member: 'GDAVE', pending: '15' }))

    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GDAVE'])
    expect(rows[0]?.pending_claimed).toBe('45')
  })

  it('an unknown event symbol is a no-op rather than throwing', async () => {
    await expect(
      applyEvent(client, decodedEvent('some_future_event', { whatever: '1' }))
    ).resolves.toBeUndefined()
  })
})
