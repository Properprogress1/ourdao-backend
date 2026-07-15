import { migrate } from './db/migrate.js'
import { pool } from './db/index.js'
import { runIndexer, stopIndexer } from './indexer/poller.js'

async function main(): Promise<void> {
  await migrate()

  const shutdown = async (signal: string) => {
    console.log(`[indexer] received ${signal}, stopping`)
    stopIndexer()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await runIndexer()
}

main().catch((err) => {
  console.error('[indexer] fatal:', err)
  process.exit(1)
})
