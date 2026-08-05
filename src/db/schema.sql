-- OurDAO backend schema. Idempotent: safe to run on every boot.
-- i128 on-chain amounts are stored as NUMERIC(40,0) (i128 max ~1.7e38 < 10^39).

-- Indexer resume state (single row, id = 1).
CREATE TABLE IF NOT EXISTS indexer_cursor (
  id           SMALLINT PRIMARY KEY DEFAULT 1,
  paging_token TEXT,
  last_ledger  BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT indexer_cursor_singleton CHECK (id = 1)
);

-- Raw event log — the append-only source every derived table is built from.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,          -- Soroban event paging id (globally unique)
  ledger      BIGINT NOT NULL,
  closed_at   TIMESTAMPTZ NOT NULL,
  contract_id TEXT NOT NULL,
  symbol      TEXT NOT NULL,             -- first topic, e.g. 'loan_req'
  topics      JSONB NOT NULL,
  data        JSONB NOT NULL,
  tx_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_symbol_idx ON events (symbol);
CREATE INDEX IF NOT EXISTS events_ledger_idx ON events (ledger);

CREATE TABLE IF NOT EXISTS members (
  address         TEXT PRIMARY KEY,
  joined_ledger   BIGINT,
  contribution    NUMERIC(40,0) NOT NULL DEFAULT 0,
  exited          BOOLEAN NOT NULL DEFAULT false,
  exit_share      NUMERIC(40,0),
  exited_ledger   BIGINT,
  pending_claimed NUMERIC(40,0) NOT NULL DEFAULT 0,
  stake           NUMERIC(40,0) NOT NULL DEFAULT 0,
  has_active_loan BOOLEAN NOT NULL DEFAULT false,
  name            TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loan_proposals (
  id              INTEGER PRIMARY KEY,
  borrower        TEXT NOT NULL,
  amount          NUMERIC(40,0) NOT NULL,
  total_repayment NUMERIC(40,0) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  votes_for       INTEGER NOT NULL DEFAULT 0,
  votes_against   INTEGER NOT NULL DEFAULT 0,
  created_ledger  BIGINT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_proposals_borrower_idx ON loan_proposals (borrower);

-- `id` doubles as the originating loan_proposals.id: the contract reuses the
-- proposal's own id for the disbursed loan (see ourdao-contracts'
-- loans.rs::approve_and_disburse) rather than a separate counter, since a
-- proposal produces at most one loan.
CREATE TABLE IF NOT EXISTS loans (
  id             INTEGER PRIMARY KEY,
  borrower       TEXT NOT NULL,
  amount         NUMERIC(40,0) NOT NULL,
  outstanding    NUMERIC(40,0) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  approved_ledger BIGINT,
  repaid_ledger  BIGINT,
  defaulted_ledger BIGINT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loans_borrower_idx ON loans (borrower);
CREATE INDEX IF NOT EXISTS loans_status_idx ON loans (status);

CREATE TABLE IF NOT EXISTS treasury_proposals (
  id              INTEGER PRIMARY KEY,
  amount          NUMERIC(40,0) NOT NULL,
  destination     TEXT NOT NULL,
  private         BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'pending',
  votes_for       INTEGER NOT NULL DEFAULT 0,
  votes_against   INTEGER NOT NULL DEFAULT 0,
  created_ledger  BIGINT,
  executed_ledger BIGINT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  address    TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  ledger     BIGINT,
  tx_hash    TEXT,
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_address_idx ON notifications (address, read);
