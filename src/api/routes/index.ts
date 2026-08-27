import type { FastifyInstance } from 'fastify'
import { query, queryOne } from '../../db/index.js'
import { config } from '../../config.js'
import { ADMIN_EVENT_SYMBOLS } from '../../stellar/events.js'
import type {
  DAOStats,
  LoanProposalRow,
  LoanRow,
  MemberRow,
  NotificationRow,
  TreasuryProposalRow,
  EventRow,
} from '../../types.js'
import { authenticateRequest, MemoryNonceStore, extractAuthHeaders } from '../../auth.js'

// Small helper: clamp a `limit` query param to a sane range.
function limit(v: unknown, def = 50, max = 200): number {
  const n = Number.parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(n, max)
}

// Parse an optional numeric pagination cursor (e.g. `?before=`). Returns null
// when absent or invalid, meaning "start from the newest row."
function cursor(v: unknown): number | null {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : null
}

// A loan's interest charge and repayment progress aren't stored columns —
// both derive from total_repayment, which issue #11 added — so compute them
// at read time rather than duplicating state that could drift out of sync.
// BigInt (not Number) because these are NUMERIC(40,0) decimal strings that
// can exceed Number.MAX_SAFE_INTEGER.
function withLoanDerived(loan: LoanRow): LoanRow & { interest_charge: string; repaid_amount: string } {
  const totalRepayment = BigInt(loan.total_repayment)
  const amount = BigInt(loan.amount)
  const outstanding = BigInt(loan.outstanding)
  return {
    ...loan,
    interest_charge: (totalRepayment - amount).toString(),
    repaid_amount: (totalRepayment - outstanding).toString(),
  }
}

export async function registerRoutes(app: FastifyInstance, opts: { nonceStore: MemoryNonceStore }): Promise<void> {
  const { nonceStore } = opts
  
  // --- Authentication challenge ---
  app.get<{ Querystring: { address: string } }>('/auth/challenge', async (req, reply) => {
    const { address } = req.query
    if (!address) {
      return reply.code(400).send({ error: 'address query param is required' })
    }
    
    try {
      const nonce = await nonceStore.issue(address)
      return { nonce }
    } catch (error) {
      return reply.code(500).send({ error: 'Failed to generate challenge' })
    }
  })
  
  // --- Members ---
  app.get('/members', async (req) => {
    const l = limit((req.query as Record<string, unknown>).limit)
    return query<MemberRow>(
      `SELECT * FROM members WHERE exited = false ORDER BY joined_ledger DESC NULLS LAST LIMIT $1`,
      [l]
    )
  })

  app.get<{ Params: { address: string } }>('/members/:address', async (req, reply) => {
    const m = await queryOne<MemberRow>('SELECT * FROM members WHERE address = $1', [req.params.address])
    if (!m) return reply.code(404).send({ error: 'member not found' })
    return m
  })

  // --- Loan proposals ---
  app.get('/proposals/loan', async (req) => {
    const l = limit((req.query as Record<string, unknown>).limit)
    return query<LoanProposalRow>('SELECT * FROM loan_proposals ORDER BY id DESC LIMIT $1', [l])
  })

  // --- Loans (optional ?borrower= filter, ?before=<id> cursor) ---
  app.get('/loans', async (req) => {
    const q = req.query as Record<string, unknown>
    const l = limit(q.limit)
    const before = cursor(q.before)
    const borrower = typeof q.borrower === 'string' && q.borrower ? q.borrower : null

    const conditions: string[] = []
    const params: unknown[] = []
    if (borrower) {
      params.push(borrower)
      conditions.push(`borrower = $${params.length}`)
    }
    if (before !== null) {
      params.push(before)
      conditions.push(`id < $${params.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)
    const loans = await query<LoanRow>(`SELECT * FROM loans ${where} ORDER BY id DESC LIMIT $${params.length}`, params)
    return loans.map(withLoanDerived)
  })

  app.get<{ Params: { id: string } }>('/loans/:id', async (req, reply) => {
    const loan = await queryOne<LoanRow>('SELECT * FROM loans WHERE id = $1', [Number(req.params.id)])
    if (!loan) return reply.code(404).send({ error: 'loan not found' })
    return withLoanDerived(loan)
  })

  // --- Treasury proposals ---
  app.get('/proposals/treasury', async (req) => {
    const l = limit((req.query as Record<string, unknown>).limit)
    return query<TreasuryProposalRow>('SELECT * FROM treasury_proposals ORDER BY id DESC LIMIT $1', [l])
  })

  // --- Notifications for an address ---
  app.get('/notifications', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (typeof q.address !== 'string' || !q.address) {
      return reply.code(400).send({ error: 'address query param is required' })
    }
    const l = limit(q.limit)
    return query<NotificationRow>(
      'SELECT * FROM notifications WHERE address = $1 ORDER BY id DESC LIMIT $2',
      [q.address, l]
    )
  })

  // --- Raw event feed (optional ?symbol= filter, ?before=<ledger> cursor) ---
  // Stricter rate limit on this heavy endpoint (issue #5).
  app.get('/events', {
    config: {
      rateLimit: {
        max: config.http.rateLimitEventsMax,
        timeWindow: config.http.rateLimitWindowMs,
      },
    },
  }, async (req) => {
    const q = req.query as Record<string, unknown>
    const l = limit(q.limit)
    const before = cursor(q.before)
    const symbol = typeof q.symbol === 'string' && q.symbol ? q.symbol : null

    const conditions: string[] = []
    const params: unknown[] = []
    if (symbol) {
      params.push(symbol)
      conditions.push(`symbol = $${params.length}`)
    }
    if (before !== null) {
      params.push(before)
      conditions.push(`ledger < $${params.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)
    return query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY ledger DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Mark a single notification as read ---
  app.patch<{ Params: { id: string } }>('/notifications/:id/read', async (req, reply) => {
    // First authenticate the request
    const auth = await authenticateRequest(req.headers, nonceStore)
    if (!auth.authenticated) {
      return reply.code(401).send({ error: auth.error || 'Authentication required' })
    }
    
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) {
      return reply.code(400).send({ error: 'invalid notification id' })
    }
    
    // Get the notification to check ownership
    const notification = await queryOne<NotificationRow>(
      'SELECT * FROM notifications WHERE id = $1',
      [id]
    )
    if (!notification) return reply.code(404).send({ error: 'notification not found' })
    
    // Extract address from auth headers and verify ownership
    const { address: authAddress } = extractAuthHeaders(req.headers)
    if (notification.address !== authAddress) {
      return reply.code(403).send({ error: 'Cannot modify notifications for another address' })
    }
    
    const row = await queryOne<NotificationRow>(
      'UPDATE notifications SET read = true WHERE id = $1 RETURNING *',
      [id]
    )
    if (!row) return reply.code(404).send({ error: 'notification not found' })
    return row
  })

  // --- Mark all of an address's notifications as read ---
  app.patch('/notifications/read-all', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (typeof q.address !== 'string' || !q.address) {
      return reply.code(400).send({ error: 'address query param is required' })
    }
    
    // Authenticate the request and verify the address matches
    const auth = await authenticateRequest(req.headers, nonceStore, q.address)
    if (!auth.authenticated) {
      return reply.code(401).send({ error: auth.error || 'Authentication required' })
    }
    
    const rows = await query<NotificationRow>(
      'UPDATE notifications SET read = true WHERE address = $1 AND read = false RETURNING id',
      [q.address]
    )
    return { updated: rows.length }
  })

  // --- Admin/governance audit log (init, admin add/remove, threshold,
  // policy, pause/unpause) ---
  app.get('/admin/log', async (req) => {
    const l = limit((req.query as Record<string, unknown>).limit)
    return query<EventRow>(
      `SELECT * FROM events WHERE symbol = ANY($1) ORDER BY ledger DESC LIMIT $2`,
      [ADMIN_EVENT_SYMBOLS as unknown as string[], l]
    )
  })

  // --- Aggregate stats (with indexer freshness — issue #2) ---
  app.get('/stats', async (): Promise<DAOStats> => {
    const row = await queryOne<{
      total_members: string
      active_members: string
      total_loan_proposals: string
      total_loans: string
      active_loans: string
      defaulted_loans: string
      total_defaulted_value: string | null
      total_treasury_proposals: string
      total_staked: string | null
      last_ledger: number | null
      cursor_updated_at: string | null
    }>(
      `SELECT
         (SELECT count(*) FROM members WHERE exited = false)                       AS total_members,
         (SELECT count(*) FROM members WHERE exited = false)                       AS active_members,
         (SELECT count(*) FROM loan_proposals)                                     AS total_loan_proposals,
         (SELECT count(*) FROM loans)                                              AS total_loans,
         (SELECT count(*) FROM loans WHERE status = 'active')                      AS active_loans,
         (SELECT count(*) FROM loans WHERE status = 'defaulted')                   AS defaulted_loans,
         (SELECT COALESCE(sum(outstanding), 0) FROM loans WHERE status = 'defaulted') AS total_defaulted_value,
         (SELECT count(*) FROM treasury_proposals)                                 AS total_treasury_proposals,
         (SELECT COALESCE(sum(stake), 0) FROM members)                             AS total_staked,
         (SELECT last_ledger FROM indexer_cursor WHERE id = 1)                     AS last_ledger,
         (SELECT updated_at FROM indexer_cursor WHERE id = 1)                      AS cursor_updated_at`
    )
    const lastLedger = row?.last_ledger ?? null
    const cursorUpdatedAt = row?.cursor_updated_at
    const secondsSinceUpdate = cursorUpdatedAt
      ? Math.floor((Date.now() - new Date(cursorUpdatedAt).getTime()) / 1000)
      : null
    const isStale = secondsSinceUpdate !== null && secondsSinceUpdate > config.indexer.staleAfterMs

    return {
      totalMembers: Number(row?.total_members ?? 0),
      activeMembers: Number(row?.active_members ?? 0),
      totalLoanProposals: Number(row?.total_loan_proposals ?? 0),
      totalLoans: Number(row?.total_loans ?? 0),
      activeLoans: Number(row?.active_loans ?? 0),
      defaultedLoans: Number(row?.defaulted_loans ?? 0),
      totalDefaultedValue: String(row?.total_defaulted_value ?? '0'),
      totalTreasuryProposals: Number(row?.total_treasury_proposals ?? 0),
      totalStaked: String(row?.total_staked ?? '0'),
      lastIndexedLedger: lastLedger,
      secondsSinceUpdate,
      indexerStale: isStale,
    }
  })
}
