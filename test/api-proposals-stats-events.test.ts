import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: proposals, stats, events, admin/log', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('GET /api/proposals/loan returns newest first', async () => {
    await query(
      `INSERT INTO loan_proposals (id, borrower, amount) VALUES (1, 'GA', 100), (2, 'GA', 200)`
    )
    const res = await app.inject({ method: 'GET', url: '/api/proposals/loan' })
    expect(res.json().map((p: { id: number }) => p.id)).toEqual([2, 1])
  })

  it('GET /api/proposals/treasury returns newest first', async () => {
    await query(
      `INSERT INTO treasury_proposals (id, amount, destination) VALUES (1, 100, 'GD'), (2, 200, 'GD')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/proposals/treasury' })
    expect(res.json().map((p: { id: number }) => p.id)).toEqual([2, 1])
  })

  it('GET /api/stats aggregates across all domain tables', async () => {
    // GA: active member with stake. GB: exited — a stale stake value that
    // should be excluded from totalStaked (issue #13). GPHANTOM: a row with
    // no join event (e.g. from name_reg) that must count for nothing (#14).
    await query(
      `INSERT INTO members (address, joined_ledger, exited, stake) VALUES
       ('GA', 10, false, 100), ('GB', 20, true, 50), ('GPHANTOM', NULL, false, 0)`
    )
    await query(`INSERT INTO loan_proposals (id, borrower, amount) VALUES (1, 'GA', 100)`)
    await query(
      `INSERT INTO loans (id, borrower, amount, outstanding, status) VALUES
       (1, 'GA', 100, 100, 'active'), (2, 'GA', 50, 0, 'repaid'), (3, 'GA', 80, 88, 'defaulted')`
    )
    await query(`INSERT INTO treasury_proposals (id, amount, destination) VALUES (1, 500, 'GD')`)
    await query(
      `INSERT INTO indexer_cursor (id, last_ledger) VALUES (1, 999)
       ON CONFLICT (id) DO UPDATE SET last_ledger = 999`
    )

    const res = await app.inject({ method: 'GET', url: '/api/stats' })
    const body = res.json()
    // totalMembers is all-time (GA + GB), activeMembers is current (GA only) —
    // they must differ, matching the contract's two getters. GPHANTOM counts
    // for neither.
    expect(body.totalMembers).toBe(2)
    expect(body.activeMembers).toBe(1)
    expect(body.totalLoans).toBe(3)
    expect(body.activeLoans).toBe(1)
    expect(body.defaultedLoans).toBe(1)
    expect(body.totalDefaultedValue).toBe('88')
    expect(body.totalLoanProposals).toBe(1)
    expect(body.totalTreasuryProposals).toBe(1)
    // Only GA's stake — GB exited, so their stale 50 is excluded.
    expect(body.totalStaked).toBe('100')
    expect(body.lastIndexedLedger).toBe(999)
  })

  it('GET /api/events filters by symbol and paginates with before=<ledger>', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data) VALUES
       ('1-0', 10, now(), 'C1', 'joined', '[]', '[]'),
       ('2-0', 20, now(), 'C1', 'staked', '[]', '[]'),
       ('3-0', 30, now(), 'C1', 'joined', '[]', '[]')`
    )
    const bySymbol = await app.inject({ method: 'GET', url: '/api/events?symbol=joined' })
    expect(bySymbol.json()).toHaveLength(2)

    const paged = await app.inject({ method: 'GET', url: '/api/events?before=30' })
    const pagedBody = paged.json()
    expect(pagedBody).toHaveLength(2)
    expect(pagedBody.every((e: { ledger: number }) => e.ledger < 30)).toBe(true)
  })

  it('GET /api/events?contract= scopes the raw log to one deployment (issue #16)', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data) VALUES
       ('a-0', 10, now(), 'COLD', 'joined', '[]', '[]'),
       ('b-0', 20, now(), 'CNEW', 'joined', '[]', '[]'),
       ('c-0', 30, now(), 'CNEW', 'staked', '[]', '[]')`
    )
    const scoped = await app.inject({ method: 'GET', url: '/api/events?contract=CNEW' })
    const body = scoped.json()
    expect(body).toHaveLength(2)
    expect(body.every((e: { contract_id: string }) => e.contract_id === 'CNEW')).toBe(true)
  })

  it('GET /api/admin/log only returns admin/governance symbols, newest first', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data) VALUES
       ('1-0', 10, now(), 'C1', 'joined', '[]', '[]'),
       ('2-0', 20, now(), 'C1', 'paused', '[]', '[]'),
       ('3-0', 30, now(), 'C1', 'threshold', '[]', '[]')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/admin/log' })
    const body = res.json()
    expect(body.map((e: { symbol: string }) => e.symbol)).toEqual(['threshold', 'paused'])
  })
})
