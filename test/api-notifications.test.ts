import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: notification mutations', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('GET /api/notifications requires an address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications' })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH /api/notifications/:id/read marks that row read and 404s for a missing id', async () => {
    const [row] = await query<{ id: number }>(
      `INSERT INTO notifications (address, type, title, message) VALUES ('GA', 'info', 't', 'm') RETURNING id`
    )
    const res = await app.inject({ method: 'PATCH', url: `/api/notifications/${row!.id}/read` })
    expect(res.statusCode).toBe(200)
    expect(res.json().read).toBe(true)

    const missing = await app.inject({ method: 'PATCH', url: '/api/notifications/999999/read' })
    expect(missing.statusCode).toBe(404)
  })

  it('PATCH /api/notifications/:id/read 400s on a non-numeric id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/notifications/not-a-number/read' })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH /api/notifications/read-all marks only that address unread rows as read', async () => {
    await query(
      `INSERT INTO notifications (address, type, title, message, read) VALUES
       ('GA', 'info', 't1', 'm1', false),
       ('GA', 'info', 't2', 'm2', false),
       ('GA', 'info', 't3', 'm3', true),
       ('GB', 'info', 't4', 'm4', false)`
    )
    const res = await app.inject({ method: 'PATCH', url: '/api/notifications/read-all?address=GA' })
    expect(res.statusCode).toBe(200)
    expect(res.json().updated).toBe(2)

    const ga = await query<{ read: boolean }>('SELECT read FROM notifications WHERE address = $1', ['GA'])
    expect(ga.every((n) => n.read)).toBe(true)

    const gb = await query<{ read: boolean }>('SELECT read FROM notifications WHERE address = $1', ['GB'])
    expect(gb[0]?.read).toBe(false)
  })

  it('PATCH /api/notifications/read-all requires an address', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/notifications/read-all' })
    expect(res.statusCode).toBe(400)
  })
})
