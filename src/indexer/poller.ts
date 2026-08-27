import type { rpc } from '@stellar/stellar-sdk'
import { config, assertContractConfigured } from '../config.js'
import { pool, queryOne } from '../db/index.js'
import { server, getLatestLedger } from '../stellar/rpc.js'
import { decodeEvent } from '../stellar/events.js'
import { applyEvent } from './handlers.js'

interface CursorRow {
  paging_token: string | null
  last_ledger: number | null
  contract_id: string | null
}

let stopped = false

/** Loads the saved cursor, but only if it belongs to `contractId` — a
 *  cursor saved under a different contract (CONTRACT_ID changed since the
 *  last run) is treated as absent so the indexer cold-starts instead of
 *  resuming with another contract's paging_token. */
async function loadCursor(contractId: string): Promise<CursorRow | null> {
  const row = await queryOne<CursorRow>(
    'SELECT paging_token, last_ledger, contract_id FROM indexer_cursor WHERE id = 1'
  )
  if (row && row.contract_id != null && row.contract_id !== contractId) return null
  return row
}

async function saveCursor(contractId: string, pagingToken: string | null, lastLedger: number): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_cursor (id, paging_token, last_ledger, contract_id, updated_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET paging_token = $1, last_ledger = $2, contract_id = $3, updated_at = now()`,
    [pagingToken, lastLedger, contractId]
  )
}

/** Touch updated_at without changing data — keeps freshness signal alive on idle contracts. */
async function touchCursor(): Promise<void> {
  await pool.query('UPDATE indexer_cursor SET updated_at = now() WHERE id = 1')
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

/**
 * Fetch events from the Soroban RPC and ingest them into Postgres.
 *
 * Issue #3: drains multiple pages when behind — keeps requesting while the
 * previous page came back full (events.length === pageLimit), bounded by
 * DRAIN_MAX_PAGES and DRAIN_MAX_MS. The cursor is advanced after every page
 * so progress survives a mid-drain crash.
 */
async function fetchOnce(contractId: string): Promise<void> {
  const cursor = await loadCursor(contractId)

  const base = {
    filters: [{ type: 'contract' as const, contractIds: [contractId], topics: [] as string[][] }],
    limit: config.indexer.pageLimit,
  }
  const request: Parameters<typeof server.getEvents>[0] = cursor?.paging_token
    ? { ...base, cursor: cursor.paging_token }
    : { ...base, startLedger: await resolveStartLedger() }

  let currentRequest = request
  let totalPages = 0
  const drainStart = Date.now()
  let totalEvents = 0
  let lastLedger = cursor?.last_ledger ?? 0

  for (;;) {
    const res = await server.getEvents(currentRequest)
    const events = res.events ?? []
    const pageCount = events.length

    await ingestPage(events)
    totalPages += 1
    totalEvents += pageCount

    // Advance cursor after every page (issue #3: per-page cursor advancement).
    const last = events[events.length - 1]
    const nextToken = last?.id ?? res.cursor ?? currentRequest.cursor ?? null
    const pageLedger = last?.ledger ?? res.latestLedger ?? lastLedger
    if (nextToken !== cursor?.paging_token || pageLedger !== lastLedger) {
      await saveCursor(contractId, nextToken, pageLedger)
      lastLedger = pageLedger
    }

    // Log catch-up progress distinctly from steady-state (issue #3).
    if (pageCount > 0) {
      console.log(`[indexer] page ${totalPages}: ingested ${pageCount} event(s) up to ledger ${pageLedger}`)
    }

    // Stop draining if:
    //  - short page (tail reached)
    //  - max pages hit
    //  - wall-clock budget exhausted
    const isFullPage = pageCount >= config.indexer.pageLimit
    const pagesExhausted = totalPages >= config.indexer.maxDrainPages
    const timeExhausted = Date.now() - drainStart >= config.indexer.maxDrainMs

    if (!isFullPage || pagesExhausted || timeExhausted) {
      if (pagesExhausted || timeExhausted) {
        console.log(`[indexer] drain cap reached: ${totalPages} pages, ${totalEvents} events, ${Date.now() - drainStart}ms`)
      }
      break
    }

    // Build next request from the response cursor
    currentRequest = { ...base, cursor: res.cursor }
  }

  // On a genuinely idle contract with no new events, touch updated_at so
  // /ready doesn't falsely report stale (issue #2 context note).
  if (totalEvents === 0) {
    await touchCursor()
  } else if (totalPages > 1) {
    console.log(`[indexer] drain complete: ${totalPages} pages, ${totalEvents} events in ${Date.now() - drainStart}ms`)
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
