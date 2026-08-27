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
    await client.query(
      `UPDATE members
         SET exited = true, exit_share = $2, exited_ledger = $3, updated_at = now()
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
      `UPDATE loan_proposals SET ${column} = ${column} + 1, updated_at = now() WHERE id = $1`,
      [num(f.proposal_id)]
    )
  },

  async loan_appr(client, ev) {
    const f = ev.fields
    const id = num(f.id)
    await client.query(
      `UPDATE loan_proposals SET status = 'approved', updated_at = now() WHERE id = $1`,
      [id]
    )
    await client.query(
      `INSERT INTO loans (id, borrower, amount, outstanding, total_repayment, status, approved_ledger, updated_at)
       VALUES ($1, $2, $3, $3, COALESCE((SELECT total_repayment FROM loan_proposals WHERE id = $1), 0), 'active', $4, now())
       ON CONFLICT (id) DO UPDATE
         SET status = 'active', approved_ledger = EXCLUDED.approved_ledger, updated_at = now()`,
      [id, addr(f.borrower), str(f.amount), ev.ledger]
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
    await client.query(
      `UPDATE loans SET status = 'defaulted', defaulted_ledger = $2, updated_at = now() WHERE id = $1`,
      [id, ev.ledger]
    )
    await client.query(`UPDATE members SET has_active_loan = false WHERE address = $1`, [borrower])
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
      `UPDATE treasury_proposals SET ${column} = ${column} + 1, updated_at = now() WHERE id = $1`,
      [num(f.id)]
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
    const f = ev.fields
    await client.query(
      `INSERT INTO members (address, stake, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (address) DO UPDATE SET stake = EXCLUDED.stake, updated_at = now()`,
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
    const f = ev.fields
    await client.query(
      `INSERT INTO members (address, name, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
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
      `UPDATE treasury_proposals SET ${column} = ${column} + 1, updated_at = now() WHERE id = $1`,
      [num(f.proposal_id)]
    )
  },
}

/** Apply one decoded event's side effects. Unknown symbols are a no-op
 *  (the raw event is still persisted by the caller). */
export async function applyEvent(client: PoolClient, ev: DecodedEvent): Promise<void> {
  const handler = handlers[ev.symbol]
  if (handler) await handler(client, ev)
}
