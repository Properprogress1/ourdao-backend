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

  it('joining again for the same address adds to contribution instead of replacing it', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GBOB', fee: '100' }))
    await applyEvent(client, decodedEvent('joined', { member: 'GBOB', fee: '50' }))

    const rows = await query<MemberRow>('SELECT * FROM members WHERE address = $1', ['GBOB'])
    expect(rows[0]?.contribution).toBe('150')
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
