import { scValToNative, type rpc, type xdr } from '@stellar/stellar-sdk'

// The complete catalog of events the OurDAO contract publishes, keyed by the
// first-topic symbol. `fields` names the positional entries of the published
// data tuple so downstream handlers read `data.borrower` instead of `data[1]`.
// Kept in sync with ourdao-contracts (membership/loans/treasury/staking/
// registry/privacy .rs `env.events().publish(...)` calls).
export const EVENT_FIELDS = {
  joined: ['member', 'fee'],
  exited: ['member', 'share'],
  claimed: ['member', 'pending'],
  loan_req: ['id', 'borrower', 'amount', 'total_repayment'],
  loan_edit: ['proposal_id', 'borrower', 'new_amount', 'total_repayment'],
  loan_vote: ['proposal_id', 'voter', 'support'],
  loan_appr: ['id', 'borrower', 'amount'],
  loan_rpy: ['loan_id', 'borrower', 'outstanding'],
  loan_dflt: ['loan_id', 'borrower', 'penalty'],
  interest: ['interest', 'active'],
  tre_prop: ['id', 'amount', 'destination', 'private'],
  tre_vote: ['id', 'voter', 'support'],
  tre_exec: ['id', 'amount', 'destination'],
  staked: ['member', 'amount', 'new_stake'],
  unstaked: ['member', 'amount', 'new_stake'],
  name_reg: ['name', 'owner'],
  committed: ['proposal_id', 'voter'],
  revealed: ['proposal_id', 'voter', 'support'],
  doc_attn: ['kind', 'proposal_id', 'caller'],
  // Admin/governance events. `policy`, `paused`, and `unpaused` carry no data
  // tuple (the contract publishes `()`), so they have no named fields.
  init: ['admins', 'consensus_threshold', 'membership_fee', 'token'],
  admin_add: ['admin'],
  admin_rem: ['admin'],
  threshold: ['threshold'],
  policy: [],
  paused: [],
  unpaused: [],
} as const

/** Event symbols that represent governance/admin actions rather than DAO
 *  member activity. Used to power the admin audit log endpoint. */
export const ADMIN_EVENT_SYMBOLS = [
  'init',
  'admin_add',
  'admin_rem',
  'threshold',
  'policy',
  'paused',
  'unpaused',
] as const

export type EventSymbol = keyof typeof EVENT_FIELDS

/** A raw contract event decoded into JSON-safe primitives. */
export interface DecodedEvent {
  id: string
  ledger: number
  closedAt: string
  contractId: string
  txHash: string | null
  symbol: string
  topics: unknown[]
  /** Positional data tuple, JSON-safe (bigints -> strings). */
  data: unknown[]
  /** Named view of `data` when the symbol is in the catalog. */
  fields: Record<string, unknown>
}

/** Recursively convert bigints to strings so values survive JSON/JSONB. */
export function toJsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(toJsonSafe)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, toJsonSafe(val)])
    )
  }
  return v
}

function safeNative(scv: xdr.ScVal): unknown {
  try {
    return toJsonSafe(scValToNative(scv))
  } catch {
    return null
  }
}

/** Decode one getEvents response entry into a JSON-safe DecodedEvent. */
export function decodeEvent(ev: rpc.Api.EventResponse): DecodedEvent {
  const topics = (ev.topic ?? []).map(safeNative)
  const symbol = typeof topics[0] === 'string' ? topics[0] : String(topics[0] ?? '')

  const nativeValue = safeNative(ev.value)
  const data = Array.isArray(nativeValue) ? nativeValue : [nativeValue]

  const names = EVENT_FIELDS[symbol as EventSymbol] as readonly string[] | undefined
  const fields: Record<string, unknown> = {}
  if (names) names.forEach((name, i) => (fields[name] = data[i] ?? null))

  return {
    id: ev.id,
    ledger: ev.ledger,
    closedAt: ev.ledgerClosedAt,
    contractId: typeof ev.contractId === 'string' ? ev.contractId : (ev.contractId?.toString() ?? ''),
    txHash: ev.txHash ?? null,
    symbol,
    topics,
    data,
    fields,
  }
}
