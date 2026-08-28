// Issue #42: handlers used to coerce a missing/malformed required field into
// a plausible default (str -> '0', num -> null, addr -> '') and silently
// write a wrong row. Handlers now throw FieldValidationError instead, so the
// transaction (whole-page, or — once quarantined, see poller.ts/issue #43 —
// single-event) rolls back rather than committing a zero-amount loan, a
// no-op `WHERE id = NULL`, or an unreachable empty-address row.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query } from '../src/db/index.js'
import { applyEvent, FieldValidationError } from '../src/indexer/handlers.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'

describe('indexer handlers: required-field validation (issue #42)', () => {
  let client: PoolClient
  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => client.release())
  afterAll(closeDb)

  it('joined with no fee throws instead of writing a zero-contribution row', async () => {
    const ev = decodedEvent('joined', { member: 'GBORROWER' }) // fee missing
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)
    expect(await query('SELECT * FROM members')).toHaveLength(0)
  })

  it('joined with no member throws instead of writing an unaddressable row', async () => {
    const ev = decodedEvent('joined', { fee: '10' }) // member missing
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)
    expect(await query('SELECT * FROM members')).toHaveLength(0)
  })

  it('loan_req with a non-numeric id throws instead of an UPDATE/INSERT that matches nothing', async () => {
    const ev = decodedEvent('loan_req', { id: 'not-a-number', borrower: 'GB', amount: '100', total_repayment: '110' })
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)
    expect(await query('SELECT * FROM loan_proposals')).toHaveLength(0)
  })

  it('loan_req with no amount throws instead of defaulting to a zero-amount proposal', async () => {
    const ev = decodedEvent('loan_req', { id: 1, borrower: 'GB', total_repayment: '110' }) // amount missing
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)
    expect(await query('SELECT * FROM loan_proposals')).toHaveLength(0)
  })

  it('loan_dflt with no penalty throws instead of applying no penalty (the motivating case)', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GB', fee: '1000' }))
    await applyEvent(client, decodedEvent('loan_req', { id: 1, borrower: 'GB', amount: '100', total_repayment: '110' }))
    await applyEvent(client, decodedEvent('loan_appr', { id: 1, borrower: 'GB', amount: '100' }))

    const ev = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GB' }) // penalty missing
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)

    const loans = await query<{ status: string }>('SELECT status FROM loans WHERE id = 1')
    expect(loans[0]?.status).toBe('active') // not silently marked defaulted with no penalty applied
    const members = await query<{ contribution: string }>('SELECT contribution FROM members WHERE address = $1', ['GB'])
    expect(members[0]?.contribution).toBe('1000')
  })

  it('loan_vote with a non-boolean support throws instead of silently counting as a vote against', async () => {
    await applyEvent(client, decodedEvent('loan_req', { id: 2, borrower: 'GB', amount: '100', total_repayment: '110' }))
    const ev = decodedEvent('loan_vote', { proposal_id: 2, voter: 'GV' }) // support missing
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)

    const rows = await query<{ votes_for: string; votes_against: string; voter_count: number }>(
      'SELECT votes_for, votes_against, voter_count FROM loan_proposals WHERE id = 2'
    )
    expect(rows[0]).toMatchObject({ votes_for: '0', votes_against: '0', voter_count: 0 })
  })

  it('staked with no address throws instead of running an UPDATE that matches nothing', async () => {
    const ev = decodedEvent('staked', { amount: '400', new_stake: '400' }) // member missing
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)
  })

  it('tre_prop with no destination throws instead of writing an unreachable proposal', async () => {
    const ev = decodedEvent('tre_prop', { id: 1, amount: '5000', private: false }) // destination missing
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)
    expect(await query('SELECT * FROM treasury_proposals')).toHaveLength(0)
  })

  it('a negative amount is rejected too, not just a missing one', async () => {
    const ev = decodedEvent('joined', { member: 'GB', fee: '-10' })
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)
  })

  it('validation error messages carry the event id, symbol, and failing field', async () => {
    const ev = decodedEvent('loan_dflt', { loan_id: 9, borrower: 'GB' })
    await expect(applyEvent(client, ev)).rejects.toThrow(
      new RegExp(`event ${ev.id} \\(loan_dflt\\): field "penalty"`)
    )
  })

  it('doc_attn with an unrecognized kind throws instead of writing a garbled document row', async () => {
    const ev = decodedEvent('doc_attn', { kind: 'Something', proposal_id: 1, caller: 'GB' })
    await expect(applyEvent(client, ev)).rejects.toThrow(FieldValidationError)
    expect(await query('SELECT * FROM documents')).toHaveLength(0)
  })

  it('a well-formed event of every previously-affected symbol still applies cleanly (no regression)', async () => {
    await applyEvent(client, decodedEvent('joined', { member: 'GB', fee: '10' }))
    await applyEvent(client, decodedEvent('exited', { member: 'GB', share: '5' }))
    await applyEvent(client, decodedEvent('joined', { member: 'GC', fee: '10' }))
    await applyEvent(client, decodedEvent('claimed', { member: 'GC', pending: '3' }))
    await applyEvent(client, decodedEvent('loan_req', { id: 10, borrower: 'GC', amount: '100', total_repayment: '110' }))
    await applyEvent(client, decodedEvent('loan_edit', { proposal_id: 10, borrower: 'GC', new_amount: '200', total_repayment: '220' }))
    await applyEvent(client, decodedEvent('loan_vote', { proposal_id: 10, voter: 'GV', support: true }))
    await applyEvent(client, decodedEvent('loan_appr', { id: 10, borrower: 'GC', amount: '200' }))
    await applyEvent(client, decodedEvent('loan_rpy', { loan_id: 10, borrower: 'GC', outstanding: '0' }))
    await applyEvent(client, decodedEvent('tre_prop', { id: 5, amount: '900', destination: 'GD', private: false }))
    await applyEvent(client, decodedEvent('tre_vote', { id: 5, voter: 'GV', support: true }))
    await applyEvent(client, decodedEvent('tre_exec', { id: 5, amount: '900', destination: 'GD' }))
    await applyEvent(client, decodedEvent('staked', { member: 'GC', amount: '50', new_stake: '50' }))
    await applyEvent(client, decodedEvent('unstaked', { member: 'GC', amount: '50', new_stake: '0' }))
    await applyEvent(client, decodedEvent('name_reg', { name: 'carol', owner: 'GC' }))
    await applyEvent(client, decodedEvent('revealed', { proposal_id: 5, voter: 'GV2', support: false }))
    await applyEvent(client, decodedEvent('doc_attn', { kind: 'Loan', proposal_id: 10, caller: 'GC' }))

    expect((await query('SELECT status FROM loans WHERE id = 10'))[0]).toMatchObject({ status: 'repaid' })
    expect((await query('SELECT status FROM treasury_proposals WHERE id = 5'))[0]).toMatchObject({ status: 'executed' })
    expect((await query('SELECT name FROM members WHERE address = $1', ['GC']))[0]).toMatchObject({ name: 'carol' })
    expect((await query('SELECT kind, proposal_id FROM documents'))[0]).toMatchObject({ kind: 'loan', proposal_id: 10 })
  })
})
