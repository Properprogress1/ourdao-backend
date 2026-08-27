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

  // Issue #15: no process-wide BIGINT parser. NUMERIC amount columns must
  // round-trip as exact decimal strings even past Number.MAX_SAFE_INTEGER, so
  // an amount is never silently truncated.
  it('a NUMERIC(40,0) amount above Number.MAX_SAFE_INTEGER round-trips as an exact string', async () => {
    const i128Max = '170141183460469231731687303715884105727'
    await query("INSERT INTO members (address, contribution) VALUES ('GWHALE', $1)", [i128Max])
    const rows = await query<{ contribution: string }>(
      "SELECT contribution FROM members WHERE address = 'GWHALE'"
    )
    expect(rows[0]?.contribution).toBe(i128Max)
    expect(typeof rows[0]?.contribution).toBe('string')
  })

  // Ledger sequence numbers (BIGINT) still come back as JS numbers — the
  // parser is scoped to the pool in src/db/index.ts, not the pg global.
  it('BIGINT ledger columns come back as JS numbers', async () => {
    await query("INSERT INTO members (address, joined_ledger) VALUES ('GLEDGER', 4200000)")
    const rows = await query<{ joined_ledger: number }>(
      "SELECT joined_ledger FROM members WHERE address = 'GLEDGER'"
    )
    expect(rows[0]?.joined_ledger).toBe(4200000)
    expect(typeof rows[0]?.joined_ledger).toBe('number')
  })
})
