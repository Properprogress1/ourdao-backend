import type { PoolClient } from 'pg'
import type { DecodedEvent } from '../stellar/events.js'
import type { NotificationType } from '../types.js'

// Helpers ------------------------------------------------------------------

const str = (v: unknown): string => (v == null ? '0' : String(v))
const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const addr = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))

async function notify(
  client: PoolClient,
  ev: DecodedEvent,
  address: string,
  type: NotificationType,
  title: string,
  message: string
): Promise<void> {
  if (!address) return
  await client.query(
    `INSERT INTO notifications (address, type, title, message, ledger, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [address, type, title, message, ev.ledger, ev.txHash]
  )
}

// Per-event handlers -------------------------------------------------------
// Each mutates derived tables for one decoded event. `f` is ev.fields.
//
// Rule of thumb (see issue #10): a handler must mirror the contract's own
// state transition for the field it's writing — assign where the contract
// assigns a fresh value onto the record, accumulate only where the contract
// itself accumulates. `joined` is the clearest example: register_member
// builds an entirely new `Member` record on every call, including a rejoin,
// so the indexer must overwrite rather than add. `claimed`'s `pending_claimed`
// is different on purpose — it's an indexer-only lifetime counter with no
// on-chain equivalent to mirror, so accumulating there is correct.

// Contract-published voting weight, once ourdao-contracts adds it to the vote
// events (see the linked issue there). Until then the field decodes as
// null/undefined and every vote counts as weight 1, same as before.
const weightOf = (f: Record<string, unknown>): string => (f.weight == null ? '1' : str(f.weight))

type Handler = (client: PoolClient, ev: DecodedEvent) => Promise<void>

const handlers: Record<string, Handler> = {
  async joined(client, ev) {
    const f = ev.fields
    const member = addr(f.member)
    // membership.rs::register_member stores a brand-new Member record on
    // every join, including a rejoin after exit — contribution is *set* to
    // the fee, never added to what was there before, and every other bit of
    // membership state (exited, exit_share, exited_ledger, has_active_loan)
    // starts fresh too. Mirror that exactly: overwrite, don't accumulate.
    await client.query(
      `INSERT INTO members (address, joined_ledger, contribution, exited, exit_share, exited_ledger, has_active_loan, updated_at)
       VALUES ($1, $2, $3, false, NULL, NULL, false, now())
       ON CONFLICT (address) DO UPDATE
         SET joined_ledger   = EXCLUDED.joined_ledger,
             contribution    = EXCLUDED.contribution,
             exited          = false,
             exit_share      = NULL,
             exited_ledger   = NULL,
             has_active_loan = false,
             updated_at      = now()`,
      [member, ev.ledger, str(f.fee)]
    )
    await notify(client, ev, member, 'success', 'Welcome to OurDAO', 'Your membership is active.')
  },

  async exited(client, ev) {
    const f = ev.fields
    const member = addr(f.member)
    // Mirror the contract's exit_dao (issue #13): it zeroes the member's
    // stake (and decrements total_staked), and exit requires no active loan,
    // so the indexer row must reflect both. `pending_claimed` is left as-is
    // on purpose — it's an indexer-only *lifetime* counter of yield ever
    // claimed, with no on-chain equivalent to reset; the pending yield the
    // contract pays out on exit was already surfaced by its own `claimed`
    // events, so clearing the lifetime total here would lose history.
    await client.query(
      `UPDATE members
         SET exited = true, exit_share = $2, exited_ledger = $3,
             stake = 0, has_active_loan = false, updated_at = now()
       WHERE address = $1`,
      [member, str(f.share), ev.ledger]
    )
    await notify(client, ev, member, 'info', 'Membership ended', `You withdrew your share of ${str(f.share)}.`)
  },

  async claimed(client, ev) {
    const f = ev.fields
    const member = addr(f.member)
    await client.query(
      `UPDATE members
         SET pending_claimed = pending_claimed + $2, updated_at = now()
       WHERE address = $1`,
      [member, str(f.pending)]
    )
    await notify(client, ev, member, 'success', 'Yield claimed', `You claimed ${str(f.pending)} in rewards.`)
  },

  async loan_req(client, ev) {
    const f = ev.fields
    await client.query(
      `INSERT INTO loan_proposals (id, borrower, amount, total_repayment, status, created_ledger, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, now())
       ON CONFLICT (id) DO UPDATE
         SET amount = EXCLUDED.amount,
             total_repayment = EXCLUDED.total_repayment,
             updated_at = now()`,
      [num(f.id), addr(f.borrower), str(f.amount), str(f.total_repayment), ev.ledger]
    )
    await notify(client, ev, addr(f.borrower), 'info', 'Loan requested', `Proposal #${str(f.id)} is open for voting.`)
  },

  async loan_edit(client, ev) {
    const f = ev.fields
    await client.query(
      `UPDATE loan_proposals
         SET amount = $2, total_repayment = $3, updated_at = now()
       WHERE id = $1`,
      [num(f.proposal_id), str(f.new_amount), str(f.total_repayment)]
    )
  },

  async loan_vote(client, ev) {
    const f = ev.fields
    const column = f.support === true ? 'votes_for' : 'votes_against'
    await client.query(
      `UPDATE loan_proposals
         SET ${column} = ${column} + $2, voter_count = voter_count + 1, updated_at = now()
       WHERE id = $1`,
      [num(f.proposal_id), weightOf(f)]
    )
  },

  async loan_appr(client, ev) {
    const f = ev.fields
    const id = num(f.id)
    await client.query(
      `UPDATE loan_proposals SET status = 'approved', updated_at = now() WHERE id = $1`,
      [id]
    )
    // `loan_appr` only carries the disbursed principal, not the repayment
    // total — outstanding debt from day one is total_repayment (principal +
    // interest), not the principal alone (issue #11). ourdao-contracts
    // doesn't publish total_repayment on this event, but `loan.id ==
    // proposal.id` is a documented invariant, so the just-approved proposal
    // row (already carrying total_repayment from `loan_req`/`loan_edit`) is
    // a reliable interim source. This depends on that proposal row existing,
    // which it will unless the indexer started mid-history.
    const proposal = await client.query<{ total_repayment: string }>(
      `SELECT total_repayment FROM loan_proposals WHERE id = $1`,
      [id]
    )
    const totalRepayment = proposal.rows[0]?.total_repayment ?? str(f.amount)
    // due_time is a unix-seconds timestamp on the contract side; convert for
    // the TIMESTAMPTZ column. Always null today since the event doesn't
    // carry it yet (see the comment on EVENT_FIELDS.loan_appr).
    const dueTime = f.due_time == null ? null : new Date(Number(f.due_time) * 1000)
    await client.query(
      `INSERT INTO loans (id, borrower, amount, total_repayment, outstanding, status, approved_ledger, due_time, updated_at)
       VALUES ($1, $2, $3, $4, $4, 'active', $5, $6, now())
       ON CONFLICT (id) DO UPDATE
         SET status = 'active', approved_ledger = EXCLUDED.approved_ledger, updated_at = now()`,
      [id, addr(f.borrower), str(f.amount), totalRepayment, ev.ledger, dueTime]
    )
    await client.query(
      `UPDATE members SET has_active_loan = true WHERE address = $1`,
      [addr(f.borrower)]
    )
    await notify(client, ev, addr(f.borrower), 'success', 'Loan approved', `Loan #${str(id)} of ${str(f.amount)} was approved.`)
  },

  async loan_rpy(client, ev) {
    const f = ev.fields
    const outstanding = str(f.outstanding)
    const status = outstanding === '0' ? 'repaid' : 'active'
    await client.query(
      `UPDATE loans
         SET outstanding = $2, status = $3,
             repaid_ledger = CASE WHEN $3 = 'repaid' THEN $4 ELSE repaid_ledger END,
             updated_at = now()
       WHERE id = $1`,
      [num(f.loan_id), outstanding, status, ev.ledger]
    )
    if (status === 'repaid') {
      await client.query(`UPDATE members SET has_active_loan = false WHERE address = $1`, [addr(f.borrower)])
    }
    const type: NotificationType = status === 'repaid' ? 'success' : 'info'
    const msg = status === 'repaid' ? `Loan #${str(f.loan_id)} is fully repaid.` : `Repayment received; ${outstanding} remaining.`
    await notify(client, ev, addr(f.borrower), type, 'Loan repayment', msg)
  },

  async loan_dflt(client, ev) {
    const f = ev.fields
    const id = num(f.loan_id)
    const borrower = addr(f.borrower)
    // Guard on the loan's own status rather than trusting the poll loop
    // never redelivers a page (it can — see the event re-delivery issue in
    // this repo). `loans.rs::mark_loan_defaulted` only ever transitions a
    // loan out of `Active` once, so re-running this UPDATE for an
    // already-defaulted loan is a no-op (`rowCount === 0`), and that's the
    // signal used below to skip re-applying the penalty and re-notifying.
    const updated = await client.query(
      `UPDATE loans SET status = 'defaulted', defaulted_ledger = $2, updated_at = now()
       WHERE id = $1 AND status <> 'defaulted'`,
      [id, ev.ledger]
    )
    if (updated.rowCount === 0) return

    await client.query(
      `UPDATE members
         SET contribution    = GREATEST(contribution - $2, 0),
             has_active_loan = false,
             defaults_count  = defaults_count + 1,
             updated_at      = now()
       WHERE address = $1`,
      [borrower, str(f.penalty)]
    )
    await notify(
      client,
      ev,
      borrower,
      'error',
      'Loan defaulted',
      `Loan #${str(id)} was marked defaulted; a penalty of ${str(f.penalty)} was applied to your contribution.`
    )
  },

  async interest() {
    // Interest distribution is a treasury-wide event with no per-member payload;
    // it is retained in the raw `events` table. Per-member yield is surfaced via
    // the `claimed` event when members claim.
  },

  async tre_prop(client, ev) {
    const f = ev.fields
    await client.query(
      `INSERT INTO treasury_proposals (id, amount, destination, private, status, created_ledger, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, now())
       ON CONFLICT (id) DO UPDATE
         SET amount = EXCLUDED.amount, destination = EXCLUDED.destination,
             private = EXCLUDED.private, updated_at = now()`,
      [num(f.id), str(f.amount), addr(f.destination), f.private === true, ev.ledger]
    )
  },

  async tre_vote(client, ev) {
    const f = ev.fields
    const column = f.support === true ? 'votes_for' : 'votes_against'
    await client.query(
      `UPDATE treasury_proposals
         SET ${column} = ${column} + $2, voter_count = voter_count + 1, updated_at = now()
       WHERE id = $1`,
      [num(f.id), weightOf(f)]
    )
  },

  async tre_exec(client, ev) {
    const f = ev.fields
    await client.query(
      `UPDATE treasury_proposals
         SET status = 'executed', executed_ledger = $2, updated_at = now()
       WHERE id = $1`,
      [num(f.id), ev.ledger]
    )
    await notify(client, ev, addr(f.destination), 'success', 'Treasury withdrawal executed', `${str(f.amount)} was sent to your address.`)
  },

  async staked(client, ev) {
    // UPDATE only, never INSERT (issue #14). The contract requires membership
    // to stake, but this indexer can't enforce that guarantee, and a read
    // model shouldn't materialise a member row just because an event named an
    // address. A `staked` for an unknown address is still in the raw `events`
    // log; it just doesn't create a phantom member. Same reasoning as
    // `name_reg`, and identical to `unstaked` now.
    const f = ev.fields
    await client.query(
      `UPDATE members SET stake = $2, updated_at = now() WHERE address = $1`,
      [addr(f.member), str(f.new_stake)]
    )
  },

  async unstaked(client, ev) {
    const f = ev.fields
    await client.query(
      `UPDATE members SET stake = $2, updated_at = now() WHERE address = $1`,
      [addr(f.member), str(f.new_stake)]
    )
  },

  async name_reg(client, ev) {
    // UPDATE only, never INSERT (issue #14). The contract's register_name
    // authorizes the caller but does *not* check membership, unlike every
    // other member-facing entrypoint — so anyone on the network can register
    // a name. Upserting here let a non-member insert itself into `members`
    // (contribution 0, joined_ledger NULL) and be served by /api/members and
    // counted by /api/stats. The name is still recorded in the raw `events`
    // log; it just no longer creates a member.
    //
    // Ordering edge case: if `name_reg` somehow arrives before the `joined`
    // event for the same address (possible only on a cold start whose start
    // ledger was clamped past the join), this UPDATE is a no-op and the name
    // is lost. We accept that rather than carry a pending-names side table:
    // `register_member` builds a fresh Member record on join and the name is
    // re-registrable at any time, so the fix is a re-register, and the raw
    // event is retained regardless.
    const f = ev.fields
    await client.query(
      `UPDATE members SET name = $2, updated_at = now() WHERE address = $1`,
      [addr(f.owner), typeof f.name === 'string' ? f.name : String(f.name ?? '')]
    )
  },

  async committed(client, ev) {
    const f = ev.fields
    await notify(client, ev, addr(f.voter), 'info', 'Private vote committed', `Your commitment for proposal #${str(f.proposal_id)} was recorded.`)
  },

  async revealed(client, ev) {
    // A revealed commit-reveal ballot counts like a treasury vote.
    const f = ev.fields
    const column = f.support === true ? 'votes_for' : 'votes_against'
    await client.query(
      `UPDATE treasury_proposals
         SET ${column} = ${column} + $2, voter_count = voter_count + 1, updated_at = now()
       WHERE id = $1`,
      [num(f.proposal_id), weightOf(f)]
    )
  },
}

/** Apply one decoded event's side effects. Unknown symbols are a no-op
 *  (the raw event is still persisted by the caller). */
export async function applyEvent(client: PoolClient, ev: DecodedEvent): Promise<void> {
  const handler = handlers[ev.symbol]
  if (handler) await handler(client, ev)
}
