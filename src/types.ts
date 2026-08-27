// Domain types for the indexed off-chain view of the OurDAO contract.
// These mirror the shapes the frontend (ourdao-frontend/src/types/dao.ts)
// consumes, but represent large integers as strings so they survive JSON.

export type LoanProposalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'
export type LoanStatus = 'active' | 'repaid' | 'defaulted'
export type TreasuryProposalStatus = 'pending' | 'executed' | 'rejected'

export interface MemberRow {
  address: string
  joined_ledger: number | null
  contribution: string
  exited: boolean
  exit_share: string | null
  exited_ledger: number | null
  pending_claimed: string
  stake: string
  has_active_loan: boolean
  name: string | null
  updated_at: string
}

export interface LoanProposalRow {
  id: number
  borrower: string
  amount: string
  total_repayment: string
  status: LoanProposalStatus
  votes_for: string
  votes_against: string
  created_ledger: number | null
  updated_at: string
}

export interface LoanRow {
  id: number
  borrower: string
  amount: string
  outstanding: string
  total_repayment: string
  status: LoanStatus
  approved_ledger: number | null
  due_time: string | null
  repaid_ledger: number | null
  defaulted_ledger: number | null
  updated_at: string
}

export interface TreasuryProposalRow {
  id: number
  amount: string
  destination: string
  private: boolean
  status: TreasuryProposalStatus
  votes_for: string
  votes_against: string
  created_ledger: number | null
  executed_ledger: number | null
  updated_at: string
}

export type NotificationType = 'success' | 'error' | 'warning' | 'info'

export interface NotificationRow {
  id: number
  address: string
  type: NotificationType
  title: string
  message: string
  ledger: number | null
  tx_hash: string | null
  read: boolean
  created_at: string
}

export interface EventRow {
  id: string
  ledger: number
  closed_at: string
  contract_id: string
  symbol: string
  topics: unknown
  data: unknown
  tx_hash: string | null
  created_at: string
}

export interface DAOStats {
  totalMembers: number
  activeMembers: number
  totalLoanProposals: number
  totalLoans: number
  activeLoans: number
  totalTreasuryProposals: number
  totalStaked: string
  lastIndexedLedger: number | null
  secondsSinceUpdate: number | null
  indexerStale: boolean
}
