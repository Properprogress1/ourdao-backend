import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: /events paging and sorting', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
    
    // Seed events with multiple events in the same ledger
    await query(`
      INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data) VALUES
      ('100-1', 100, now(), 'C1', 'staked', '[]', '[]'),
      ('100-2', 100, now(), 'C1', 'staked', '[]', '[]'),
      ('100-3', 100, now(), 'C1', 'staked', '[]', '[]'),
      ('101-1', 101, now(), 'C1', 'staked', '[]', '[]'),
      ('101-2', 101, now(), 'C1', 'staked', '[]', '[]')
    `)
  })
  afterAll(closeDb)

  it('GET /api/events?order=asc returns in ascending order', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?order=asc' })
    const body = res.json().events
    expect(body.map((e: { id: string }) => e.id)).toEqual(['100-1', '100-2', '100-3', '101-1', '101-2'])
  })

  it('GET /api/events defaults to descending order', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' })
    const body = res.json().events
    expect(body.map((e: { id: string }) => e.id)).toEqual(['101-2', '101-1', '100-3', '100-2', '100-1'])
  })

  it('GET /api/events?before=101-1 pages backwards without dropping events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?before=101-1' })
    const body = res.json().events
    // Everything strictly less than 101-1 in descending order
    expect(body.map((e: { id: string }) => e.id)).toEqual(['100-3', '100-2', '100-1'])
  })

  it('GET /api/events?after=100-2 pages forwards without dropping events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?after=100-2&order=asc' })
    const body = res.json().events
    // strictly greater than 100-2
    expect(body.map((e: { id: string }) => e.id)).toEqual(['100-3', '101-1', '101-2'])
  })

  it('GET /api/events fails if before and after are used together', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?before=101-2&after=100-1' })
    expect(res.statusCode).toBe(400)
  })
  
  it('GET /api/events still supports just ledger number for before', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?before=101' })
    const body = res.json().events
    expect(body.map((e: { id: string }) => e.id)).toEqual(['100-3', '100-2', '100-1'])
  })
})
