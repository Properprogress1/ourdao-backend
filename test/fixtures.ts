import type { DecodedEvent } from '../src/stellar/events.js'

let nextLedger = 100

/** A DecodedEvent with sane defaults, for indexer-handler tests that only
 *  care about `symbol`/`fields`. Bypasses real ScVal decoding since the
 *  handlers only ever read `ev.fields`, `ev.ledger`, and `ev.txHash`. */
export function decodedEvent(
  symbol: string,
  fields: Record<string, unknown>,
  overrides: Partial<DecodedEvent> = {}
): DecodedEvent {
  const ledger = overrides.ledger ?? nextLedger++
  return {
    id: `${ledger}-0`,
    ledger,
    closedAt: '2026-01-01T00:00:00Z',
    contractId: 'CTESTCONTRACT',
    txHash: `tx-${ledger}`,
    symbol,
    topics: [symbol],
    data: Object.values(fields),
    fields,
    ...overrides,
  }
}
