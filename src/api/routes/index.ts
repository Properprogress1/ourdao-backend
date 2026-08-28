import type { FastifyInstance } from 'fastify'
import { StrKey } from '@stellar/stellar-sdk'
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
  InterestDistributionRow,
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
  if (v === undefined || v === null || v === '') return null
  const raw = String(v).trim()
  if (!/^[0-9]+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function invalidCursor(v: unknown): boolean {
  return v !== undefined && cursor(v) === null
}

function validAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address)
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
    } catch {
      return reply.code(500).send({ error: 'Failed to generate challenge' })
    }
  })
  
  // --- Members ---
  // `joined_ledger IS NOT NULL` filters out phantom rows — an address that
  // only ever appeared in a `name_reg`/`staked` event and never actually
  // joined the DAO (issue #14). A real member always has a join ledger.
  app.get('/members', async (req) => {
    const l = limit((req.query as Record<string, unknown>).limit)
    return query<MemberRow>(
      `SELECT * FROM members
        WHERE exited = false AND joined_ledger IS NOT NULL
        ORDER BY joined_ledger DESC NULLS LAST LIMIT $1`,
      [l]
    )
  })

  app.get<{ Params: { address: string } }>('/members/:address', async (req, reply) => {
    if (!validAddress(req.params.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
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
  app.get('/loans', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
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
    const rawId = req.params.id.trim()
    if (!/^[0-9]+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0) {
      return reply.code(400).send({ error: 'invalid loan id' })
    }
    const loan = await queryOne<LoanRow>('SELECT * FROM loans WHERE id = $1', [Number(rawId)])
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
  }, async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    const symbol = typeof q.symbol === 'string' && q.symbol ? q.symbol : null
    // `?contract=<C...>` scopes the raw log to one deployment (issue #16).
    // The column is always populated; without this filter a database that
    // has held more than one CONTRACT_ID interleaves both.
    const contract = typeof q.contract === 'string' && q.contract ? q.contract : null

    const conditions: string[] = []
    const params: unknown[] = []
    if (symbol) {
      params.push(symbol)
      conditions.push(`symbol = $${params.length}`)
    }
    if (contract) {
      params.push(contract)
      conditions.push(`contract_id = $${params.length}`)
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
    const q = req.query as Record<string, unknown>
    const l = limit(q.limit)
    // `?contract=<C...>` scopes to one deployment, same as /events (issue #16).
    const contract = typeof q.contract === 'string' && q.contract ? q.contract : null
    const params: unknown[] = [ADMIN_EVENT_SYMBOLS as unknown as string[]]
    let where = `WHERE symbol = ANY($1)`
    if (contract) {
      params.push(contract)
      where += ` AND contract_id = $${params.length}`
    }
    params.push(l)
    return query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY ledger DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Interest distribution history (issue #24, ?before=<ledger> cursor) ---
  // One row per `interest` event: the amount the treasury collected and the
  // active-member count at that distribution, so per-member share per
  // distribution is derivable. `amount` is interest *collected* — the
  // contract keeps the indivisible remainder, so it is slightly more than the
  // sum credited to members (documented in the README).
  app.get('/interest', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    const params: unknown[] = []
    let where = ''
    if (before !== null) {
      params.push(before)
      where = `WHERE ledger < $${params.length}`
    }
    params.push(l)
    return query<InterestDistributionRow>(
      `SELECT id, ledger, amount, active_members, tx_hash, created_at
         FROM interest_distributions ${where}
        ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Aggregate stats (with indexer freshness — issue #2) ---
  //
  // Issue #18: /api/stats is the hottest endpoint (the frontend polls it
  // every 15s from every tab, and proposal enumeration depends on it) and the
  // most expensive (eight uncached counts). A short-lived in-process cache
  // collapses a burst of polls to one set of queries. Scoped to this server
  // instance — a fresh registerRoutes() closure per buildServer() — so it
  // never leaks across tests or restarts.
  let statsCache: { at: number; value: DAOStats } | null = null

  async function computeStats(): Promise<DAOStats> {
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
      interest_collected: string | null
      principal_lent: string | null
      principal_repaid: string | null
      value_defaulted: string | null
      last_ledger: number | null
      cursor_updated_at: string | null
    }>(
      // Member counts mirror the contract's two distinct getters:
      // get_total_members (all-time) vs get_active_members (current). Both
      // require a real join event — `joined_ledger IS NOT NULL` — so phantom
      // rows from a name/stake event never count (issue #14). total_staked
      // sums only non-exited members: the `exited` handler now zeroes stake
      // (issue #13), and this WHERE is defence in depth so a future handler
      // gap can't re-inflate the figure.
      `SELECT
         (SELECT count(*) FROM members WHERE joined_ledger IS NOT NULL)             AS total_members,
         (SELECT count(*) FROM members WHERE joined_ledger IS NOT NULL AND exited = false) AS active_members,
         (SELECT count(*) FROM loan_proposals)                                     AS total_loan_proposals,
         (SELECT count(*) FROM loans)                                              AS total_loans,
         (SELECT count(*) FROM loans WHERE status = 'active')                      AS active_loans,
         (SELECT count(*) FROM loans WHERE status = 'defaulted')                   AS defaulted_loans,
         (SELECT COALESCE(sum(outstanding), 0) FROM loans WHERE status = 'defaulted') AS total_defaulted_value,
         (SELECT count(*) FROM treasury_proposals)                                 AS total_treasury_proposals,
         (SELECT COALESCE(sum(stake), 0) FROM members WHERE exited = false)         AS total_staked,
         (SELECT interest_collected FROM dao_totals WHERE id = 1)                  AS interest_collected,
         (SELECT principal_lent     FROM dao_totals WHERE id = 1)                  AS principal_lent,
         (SELECT principal_repaid   FROM dao_totals WHERE id = 1)                  AS principal_repaid,
         (SELECT value_defaulted    FROM dao_totals WHERE id = 1)                  AS value_defaulted,
         (SELECT last_ledger FROM indexer_cursor WHERE id = 1)                     AS last_ledger,
         (SELECT updated_at FROM indexer_cursor WHERE id = 1)                      AS cursor_updated_at`
    )
    const cursorUpdatedAt = row?.cursor_updated_at
    const secondsSinceUpdate = cursorUpdatedAt
      ? Math.floor((Date.now() - new Date(cursorUpdatedAt).getTime()) / 1000)
      : null
    const isStale = cursorUpdatedAt != null &&
      Date.now() - new Date(cursorUpdatedAt).getTime() > config.indexer.staleAfterMs

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
      interestCollected: String(row?.interest_collected ?? '0'),
      principalLent: String(row?.principal_lent ?? '0'),
      principalRepaid: String(row?.principal_repaid ?? '0'),
      valueDefaulted: String(row?.value_defaulted ?? '0'),
      lastIndexedLedger: row?.last_ledger ?? null,
      secondsSinceUpdate,
      indexerStale: isStale,
    }
  }

  app.get('/stats', async (_req, reply): Promise<DAOStats> => {
    const ttl = config.http.statsCacheMs
    reply.header('Cache-Control', `public, max-age=${Math.max(0, Math.floor(ttl / 1000))}`)
    if (statsCache && Date.now() - statsCache.at < ttl) {
      return statsCache.value
    }
    const value = await computeStats()
    statsCache = { at: Date.now(), value }
    return value
  })
}
