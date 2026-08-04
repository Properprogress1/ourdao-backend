// Shared harness for DB-backed tests. Applies the real schema.sql to the test
// database (see test/setup.ts for how DATABASE_URL is pointed there) and
// truncates every table between tests so each test starts from empty state.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pool } from '../src/db/index.js'

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql')

let schemaApplied: Promise<void> | null = null

function applySchema(): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8')
  return pool.query(sql).then(() => undefined)
}

/** Idempotent: safe to call from every test file's setup. */
export function ensureSchema(): Promise<void> {
  if (!schemaApplied) schemaApplied = applySchema()
  return schemaApplied
}

// Order doesn't matter — TRUNCATE ... CASCADE handles dependents, and none of
// these tables actually have FK constraints between them (each is keyed by
// address/id independently, matching schema.sql).
const TABLES = [
  'notifications',
  'treasury_proposals',
  'loans',
  'loan_proposals',
  'members',
  'events',
  'indexer_cursor',
]

export async function resetDb(): Promise<void> {
  await ensureSchema()
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
}

export async function closeDb(): Promise<void> {
  await pool.end()
}
