import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Apply the (idempotent) schema. Safe to call on every boot. */
export async function migrate(): Promise<void> {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8')
  await pool.query(sql)
}

// Allow running directly: `npm run migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      console.log('[db] schema applied')
      return pool.end()
    })
    .catch((err) => {
      console.error('[db] migration failed:', err)
      process.exit(1)
    })
}
