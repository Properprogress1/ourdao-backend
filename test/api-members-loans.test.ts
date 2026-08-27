import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: members and loans', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('GET /api/members returns active members, newest first, and excludes exited ones', async () => {
    await query(
      `INSERT INTO members (address, joined_ledger, contribution, exited) VALUES
       ('GOLD', 100, 10, false), ('GNEW', 200, 20, false), ('GGONE', 300, 30, true)`
    )
    const res = await app.inject({ method: 'GET', url: '/api/members' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.map((m: { address: string }) => m.address)).toEqual(['GNEW', 'GOLD'])
  })

  it('GET /api/members/:address 404s for an unknown address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/members/GNOBODY' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/members/:address returns the member when present', async () => {
    await query(`INSERT INTO members (address, contribution) VALUES ('GALICE', 500)`)
    const res = await app.inject({ method: 'GET', url: '/api/members/GALICE' })
    expect(res.statusCode).toBe(200)
    expect(res.json().contribution).toBe('500')
  })

  it('GET /api/loans filters by borrower', async () => {
    await query(
      `INSERT INTO loans (id, borrower, amount, outstanding, status) VALUES
       (1, 'GA', 100, 100, 'active'), (2, 'GB', 200, 0, 'repaid'), (3, 'GA', 300, 300, 'active')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/loans?borrower=GA' })
    const body = res.json()
    expect(body).toHaveLength(2)
    expect(body.every((l: { borrower: string }) => l.borrower === 'GA')).toBe(true)
  })

  it('GET /api/loans supports before-id cursor pagination', async () => {
    await query(
      `INSERT INTO loans (id, borrower, amount, outstanding, status) VALUES
       (10, 'GA', 1, 1, 'active'), (11, 'GA', 1, 1, 'active'), (12, 'GA', 1, 1, 'active')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/loans?before=12&limit=1' })
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe(11)
  })

  it('GET /api/loans/:id 404s when missing, 200s with the row when present', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/loans/999' })
    expect(missing.statusCode).toBe(404)

    await query(`INSERT INTO loans (id, borrower, amount, outstanding) VALUES (1, 'GA', 100, 100)`)
    const found = await app.inject({ method: 'GET', url: '/api/loans/1' })
    expect(found.statusCode).toBe(200)
    expect(found.json().borrower).toBe('GA')
  })

  it('GET /api/loans/:id exposes the interest charge and repayment progress derived from total_repayment', async () => {
    await query(
      `INSERT INTO loans (id, borrower, amount, total_repayment, outstanding, status) VALUES
       (5, 'GA', 1000, 1080, 1080, 'active')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/loans/5' })
    const body = res.json()
    expect(body.interest_charge).toBe('80')
    expect(body.repaid_amount).toBe('0')

    await query(`UPDATE loans SET outstanding = 380 WHERE id = 5`)
    const afterPartial = (await app.inject({ method: 'GET', url: '/api/loans/5' })).json()
    expect(afterPartial.repaid_amount).toBe('700')
  })
})
