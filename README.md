# OurDAO Backend

[![CI](https://github.com/ourdao/ourdao-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/ourdao/ourdao-backend/actions/workflows/ci.yml)

Off-chain **indexer + read API** for the [OurDAO](https://github.com/ourdao) lending DAO on Stellar/Soroban.

The Soroban contract (`ourdao-contracts`) is the source of truth for all state, but on-chain data has [state expiration (TTL)](https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival) and keeps no queryable history. This service fills that gap: it tails the contract's emitted events into Postgres and serves fast, aggregated, history-aware read APIs that the frontend (`ourdao-frontend`) consumes.

It is **strictly read-only and event-driven** — it never holds keys and never signs. Every state change still happens on-chain via the user's wallet.

## Architecture

```
Soroban RPC ──getEvents──▶ indexer (worker.ts) ──▶ Postgres ──▶ REST API (index.ts) ──▶ frontend
```

- **`src/indexer`** — a poll loop over the Soroban RPC `getEvents`, resuming from a persisted cursor. Each event is written to an append-only `events` log and folded into derived tables (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`) inside one transaction.
- **`src/stellar/events.ts`** — the event catalog: the exact topic-symbol → data-tuple mapping published by the contract (`joined`, `loan_req`, `loan_vote`, `tre_exec`, `staked`, …), decoded with `scValToNative`.
- **`src/api`** — a [Fastify](https://fastify.dev) server exposing the read endpoints below.

The API process and the indexer worker are separate entrypoints so they can be scaled/deployed independently, but both apply the schema on boot.

## Quick start

```bash
# 1. Install
npm install

# 2. Start Postgres (or point DATABASE_URL at your own)
docker compose up -d

# 3. Configure
cp .env.example .env
#   set CONTRACT_ID to your deployed OurDAO contract id (starts with C)

# 4. Run the API (http://localhost:4000)
npm run dev

# 5. In another terminal, run the indexer
npm run dev:worker
```

Production build:

```bash
npm run build
npm start          # API
npm run start:worker   # indexer
```

## Configuration

See [`.env.example`](./.env.example). Key values:

| Variable | Purpose |
|---|---|
| `CONTRACT_ID` | Deployed OurDAO contract id. **Required** for the indexer. |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint (defaults to public testnet). |
| `NETWORK_PASSPHRASE` | Testnet by default; switch for mainnet. |
| `DATABASE_URL` | Postgres connection string (or use `PG*` vars). |
| `START_LEDGER` | Ledger to index from on a cold start (`0` = recent window). |
| `POLL_INTERVAL_MS` | How often to poll `getEvents`. |
| `POLL_MAX_BACKOFF_MS` | Cap for exponential backoff after consecutive poll failures (default 60s). |

## API

Base path: `/api`

| Method & path | Description |
|---|---|
| `GET /health` | Liveness + configured contract id. |
| `GET /api/stats` | Aggregate counts + last indexed ledger. |
| `GET /api/members` | Active members. |
| `GET /api/members/:address` | Single member. |
| `GET /api/proposals/loan` | Loan proposals with vote tallies. |
| `GET /api/loans` | Loans (optional `?borrower=`, `?before=<id>`). |
| `GET /api/loans/:id` | Single loan. |
| `GET /api/proposals/treasury` | Treasury proposals with vote tallies. |
| `GET /api/notifications?address=` | Notifications for an address. |
| `PATCH /api/notifications/:id/read` | Mark one notification read. |
| `PATCH /api/notifications/read-all?address=` | Mark every unread notification for an address read. |
| `GET /api/events` | Raw event feed (optional `?symbol=`, `?before=<ledger>`). |
| `GET /api/admin/log` | Admin/governance audit trail (init, admin add/remove, threshold, policy, pause/unpause). |

All list endpoints accept `?limit=` (default 50, max 200). `?before=` is a cursor — pass the `id`/`ledger` of the last row you saw to page further back. On-chain `i128` amounts are returned as decimal **strings** to preserve precision; ledger sequence numbers are returned as regular JSON numbers.

## Testing

```bash
# One-time: create the test database (separate from the dev DB above)
docker exec <postgres-container> psql -U ourdao -d postgres -c "CREATE DATABASE ourdao_test;"

npm test          # vitest, against ourdao_test — never touches dev data
npm run lint
npm run typecheck
```

Tests apply the real `schema.sql` and truncate between runs (see `test/db.ts`); route tests build a real Fastify instance and exercise it with `inject()` rather than mocking. CI runs all of this (plus `npm run build`) against a Postgres service container on every push/PR.

## Status

MVP — the indexer and read API are implemented for the full event catalog, with test coverage across the indexer handlers and API routes. Planned next: IPFS pinning for document metadata and commit-reveal ballot coordination for private voting (both frontend/contract-facing), and indexer reorg handling.

## License

MIT
