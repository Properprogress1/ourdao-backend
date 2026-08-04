import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('test db harness', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('applies schema.sql so domain tables exist and start empty', async () => {
    const rows = await query('SELECT * FROM members')
    expect(rows).toEqual([])
  })

  it('truncates between tests instead of accumulating state', async () => {
    await query("INSERT INTO members (address, contribution) VALUES ('GTEST', 100)")
    const rows = await query('SELECT * FROM members')
    expect(rows).toHaveLength(1)
  })

  it('really did reset after the previous test', async () => {
    const rows = await query('SELECT * FROM members')
    expect(rows).toEqual([])
  })
})
