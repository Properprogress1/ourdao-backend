import type { rpc } from '@stellar/stellar-sdk'
import { config, assertContractConfigured } from '../config.js'
import { pool, queryOne } from '../db/index.js'
import { server, getLatestLedger } from '../stellar/rpc.js'
import { decodeEvent } from '../stellar/events.js'
import { applyEvent } from './handlers.js'

interface CursorRow {
  paging_token: string | null
  last_ledger: number | null
}

let stopped = false

async function loadCursor(): Promise<CursorRow | null> {
  return queryOne<CursorRow>('SELECT paging_token, last_ledger FROM indexer_cursor WHERE id = 1')
}

async function saveCursor(pagingToken: string | null, lastLedger: number): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_cursor (id, paging_token, last_ledger, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET paging_token = $1, last_ledger = $2, updated_at = now()`,
    [pagingToken, lastLedger]
  )
}

/** Determine the ledger to start from on a cold start (no saved cursor). */
async function resolveStartLedger(): Promise<number> {
  if (config.indexer.startLedger > 0) return config.indexer.startLedger
  const latest = await getLatestLedger()
  return Math.max(1, latest - config.indexer.startLookbackLedgers)
}

/** Persist a page of events + their derived side effects atomically. */
async function ingestPage(events: rpc.Api.EventResponse[]): Promise<void> {
  if (events.length === 0) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const raw of events) {
      const ev = decodeEvent(raw)
      // Raw log first (idempotent on the unique event id), then derived state.
      await client.query(
        `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol, JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash]
      )
      await applyEvent(client, ev)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function fetchOnce(contractId: string): Promise<void> {
  const cursor = await loadCursor()

  // getEvents accepts either a cursor (resume) or a startLedger (cold start).
  const base = {
    filters: [{ type: 'contract' as const, contractIds: [contractId], topics: [] as string[][] }],
    limit: config.indexer.pageLimit,
  }
  const request: Parameters<typeof server.getEvents>[0] = cursor?.paging_token
    ? { ...base, cursor: cursor.paging_token }
    : { ...base, startLedger: await resolveStartLedger() }

  const res = await server.getEvents(request)
  const events = res.events ?? []

  await ingestPage(events)

  // Advance the cursor. Prefer the paging id of the last event; fall back to
  // the response-level cursor so we keep moving even across empty pages.
  // (In Soroban RPC an event's `id` is its paging token.)
  const last = events[events.length - 1]
  const nextToken = last?.id ?? res.cursor ?? cursor?.paging_token ?? null
  const lastLedger = last?.ledger ?? res.latestLedger ?? cursor?.last_ledger ?? 0
  if (nextToken !== cursor?.paging_token || lastLedger !== cursor?.last_ledger) {
    await saveCursor(nextToken, lastLedger)
  }

  if (events.length > 0) {
    console.log(`[indexer] ingested ${events.length} event(s) up to ledger ${lastLedger}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Run the poll loop until stopped. Errors are logged and retried with
 *  exponential backoff (capped at `POLL_MAX_BACKOFF_MS`) so a stuck or down
 *  RPC endpoint doesn't get hammered every `pollIntervalMs`. The delay resets
 *  to the normal interval as soon as a poll succeeds. */
export async function runIndexer(): Promise<void> {
  const contractId = assertContractConfigured()
  console.log(`[indexer] watching ${contractId} on ${config.stellar.rpcUrl}`)
  let consecutiveFailures = 0
  while (!stopped) {
    let delay = config.indexer.pollIntervalMs
    try {
      await fetchOnce(contractId)
      consecutiveFailures = 0
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      consecutiveFailures += 1
      delay = Math.min(
        config.indexer.pollIntervalMs * 2 ** consecutiveFailures,
        config.indexer.maxBackoffMs
      )
      console.error(
        `[indexer] poll error (${consecutiveFailures} consecutive): ${msg} — retrying in ${delay}ms`
      )
    }
    await sleep(delay)
  }
}

export function stopIndexer(): void {
  stopped = true
}
