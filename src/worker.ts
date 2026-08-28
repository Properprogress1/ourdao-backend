import { migrate } from './db/migrate.js'
import { pool } from './db/index.js'
import { runIndexer, stopIndexer } from './indexer/poller.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

async function main(): Promise<void> {
  await migrate()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[indexer] received ${signal} — waiting for current page to complete`)

    // Wait for the indexer loop to finish its current page and exit,
    // bounded so a wedged RPC call can't hang shutdown forever (issue #47).
    const stopPromise = stopIndexer()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))
    await Promise.race([stopPromise, timeout])

    console.log('[indexer] closing database pool')
    await pool.end()
    console.log('[indexer] shutdown complete')
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
