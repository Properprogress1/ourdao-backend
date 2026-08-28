import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { pool } from '../src/db/index.js'
import { resetDb } from './db.js'

const VALID_ADDRESS = Keypair.random().publicKey()

describe('API: pagination and path validation', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  it.each([
    '/api/members',
    '/api/proposals/loan',
    '/api/loans',
    '/api/proposals/treasury',
    `/api/notifications?address=${VALID_ADDRESS}`,
    '/api/events',
    '/api/admin/log',
    '/api/interest',
  ])('clamps invalid limits on %s before querying', async (path) => {
    const spy = vi.spyOn(pool, 'query')
    try {
      for (const value of ['abc', '-5', '99999']) {
        const res = await app.inject({ method: 'GET', url: `${path}${path.includes('?') ? '&' : '?'}limit=${value}` })
        expect(res.statusCode).toBe(200)
        const call = spy.mock.calls.at(-1)
        expect(call?.[1]).toContain(value === '99999' ? 200 : 50)
      }
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['/api/loans', '/api/events', '/api/interest'])(
    'rejects malformed cursors on %s before querying',
    async (path) => {
      const spy = vi.spyOn(pool, 'query')
      try {
        const res = await app.inject({ method: 'GET', url: `${path}?before=not-a-number` })
        expect(res.statusCode).toBe(400)
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    }
  )

  it('rejects invalid member addresses before querying', async () => {
    const spy = vi.spyOn(pool, 'query')
    try {
      const res = await app.inject({ method: 'GET', url: '/api/members/not-a-stellar-address' })
      expect(res.statusCode).toBe(400)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['/api/loans/not-a-number'])('rejects invalid numeric path parameters', async (path) => {
    const spy = vi.spyOn(pool, 'query')
    try {
      const res = await app.inject({ method: 'GET', url: path })
      expect(res.statusCode).toBe(400)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('API: fail-soft readiness', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildServer()
    await app.ready()
  })

  it('returns 503 when the readiness database query fails', async () => {
    const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('database unavailable'))
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ status: 'not ready', reason: 'postgres_unreachable' })
    } finally {
      spy.mockRestore()
    }
  })
})
