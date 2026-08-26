import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { closeDb, resetDb } from './db.js'

describe('API: rate limiting', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('/health is exempt from rate limiting', async () => {
    // Fire many requests — /health should never 429
    for (let i = 0; i < 150; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
    }
  })

  it('/ready is exempt from rate limiting', async () => {
    for (let i = 0; i < 150; i++) {
      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(200)
    }
  })

  it('returns 429 with Retry-After when limit exceeded', async () => {
    // The default limit is 100/min. Exhaust it.
    for (let i = 0; i < 100; i++) {
      await app.inject({ method: 'GET', url: '/api/members' })
    }
    const res = await app.inject({ method: 'GET', url: '/api/members' })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
    const body = res.json()
    expect(body.message).toBeDefined()
  })
})
