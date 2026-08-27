<p align="center">
  <img src="assets/logo.png" alt="OurDAO logo" width="96" />
</p>

# OurDAO Backend

[![CI](https://github.com/ourdao/ourdao-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/ourdao/ourdao-backend/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Off-chain **indexer + read API** for the [OurDAO](https://github.com/ourdao) lending DAO on Stellar/Soroban.

The Soroban contract ([`ourdao-contracts`](https://github.com/ourdao/ourdao-contracts)) is the single source of truth for all state, but on-chain data has [state expiration (TTL)](https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival) and keeps no queryable history — there's no way to ask the contract "list every loan proposal" or "show me this address's notification feed." This service fills that gap: it tails the contract's emitted events into Postgres and serves fast, aggregated, history-aware read APIs that [`ourdao-frontend`](https://github.com/ourdao/ourdao-frontend) consumes.

It is **strictly read-only and event-driven** — it never holds keys, never signs a transaction, and cannot move funds. Every state change still happens on-chain via the user's own wallet; this service only mirrors what already happened.

This repository is one of three that make up OurDAO:

| Repo | Role |
|---|---|
| [`ourdao-contracts`](https://github.com/ourdao/ourdao-contracts) | The Soroban contract — the single source of truth for all DAO state |
| **`ourdao-backend`** (this repo) | Off-chain indexer + read API |
| [`ourdao-frontend`](https://github.com/ourdao/ourdao-frontend) | Next.js web app members actually use |

## Table of contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Database schema](#database-schema)
- [Event catalog](#event-catalog)
- [API reference](#api-reference)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Status](#status)
- [Contributing](#contributing)
- [License](#license)

## Architecture

```
Soroban RPC ──getEvents──▶ indexer (worker.ts) ──▶ Postgres ──▶ REST API (index.ts) ──▶ frontend
```

- **`src/indexer`** — a poll loop over the Soroban RPC `getEvents`, resuming from a persisted cursor (`indexer_cursor` table) rather than re-scanning from genesis on every restart. Each raw event is written to an append-only `events` log, then folded into the relevant derived table (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`) inside a single database transaction, so a crash mid-poll can never leave the derived tables and the raw log inconsistent. Poll failures back off exponentially (capped, configurable) instead of hammering the RPC endpoint.
- **`src/stellar/events.ts`** — the event catalog: the exact topic-symbol → data-tuple mapping the contract publishes, decoded via `scValToNative` and converted to JSON-safe primitives (bigints become strings, since JSON has no native 128-bit integer type).
- **`src/api`** — a [Fastify](https://fastify.dev) server exposing the read endpoints in the [API reference](#api-reference) below.
- **`src/db`** — the Postgres schema (applied idempotently on boot by both the API and worker processes) and a thin query helper over [`pg`](https://node-postgres.com/).

The API process and the indexer worker are separate entrypoints (`index.ts` / `worker.ts`) so they can be scaled or deployed independently — e.g. one long-running indexer worker behind several stateless, horizontally-scaled API instances.

## Quick start

```bash
# 1. Install
npm install

# 2. Start Postgres (or point DATABASE_URL at your own instance)
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
npm start              # API
npm run start:worker   # indexer
```

## Configuration

All configuration is environment-driven — see [`.env.example`](./.env.example) for the full annotated list. Key values:

| Variable | Purpose |
|---|---|
| `CONTRACT_ID` | Deployed OurDAO contract id. **Required** for the indexer to run. |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint (defaults to public testnet). |
| `NETWORK_PASSPHRASE` | Testnet by default; switch for mainnet. |
| `DATABASE_URL` | Postgres connection string (or set the individual `PG*` vars). |
| `START_LEDGER` / `START_LOOKBACK_LEDGERS` | Where to start indexing on a cold start. Public Soroban RPC only retains ~24h of events, so an old start ledger gets clamped to the oldest the RPC still serves. |
| `POLL_INTERVAL_MS` / `EVENTS_PAGE_LIMIT` | Indexer poll cadence and page size. |
| `POLL_MAX_BACKOFF_MS` | Cap for exponential backoff after consecutive poll failures (default 60s). |
| `DRAIN_MAX_PAGES` | Max pages per poll drain cycle when catching up (default 20). |
| `DRAIN_MAX_MS` | Max wall-clock ms for a single drain cycle (default 30s). |
| `INDEXER_STALE_AFTER_MS` | How long (ms) the cursor can be idle before `/ready` reports stale (default 120s). |
| `CORS_ORIGIN` | Comma-separated allowed origins for the API (the frontend's URL). Defaults to `http://localhost:3000`. Set to `*` to allow all origins (a warning is logged at startup). |
| `RATE_LIMIT_MAX` | Global rate limit: max requests per window per IP (default 100). |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in milliseconds (default 60000). |
| `RATE_LIMIT_EVENTS_MAX` | Stricter rate limit for `GET /api/events` (default 30). |
| `TRUST_PROXY` | Set to `"true"` behind a reverse proxy so rate limits apply per client IP. |
| `TEST_DATABASE_URL` | Separate database `npm test` runs against — never the dev DB. |

## Database schema

Postgres, applied by `src/db/migrate.ts` on every boot — both the API and the worker call it at startup, so it's safe with no separate migration-runner step to remember to run.

`src/db/schema.sql` is the bootstrap baseline: idempotent `CREATE TABLE/INDEX IF NOT EXISTS` statements describing the *current* desired shape. That's sufficient for a brand-new database, but `IF NOT EXISTS` silently no-ops on a table that already exists — including when a column was added or a type changed. Those changes instead live as numbered files in `src/db/migrations/` (e.g. `0001_widen_vote_columns.sql`), applied in order and tracked in a `schema_migrations` table so each one runs exactly once per database. A fresh database created from `schema.sql` already has every migration's end state, so its migrations are recorded as applied without re-running their SQL; an existing database gets the real `ALTER` statements. A Postgres advisory lock serializes `migrate()` across the API and worker so they don't race to apply the same migration concurrently on startup.

To add a schema change: update `schema.sql` to the new desired shape (for fresh databases) *and* add a new numbered file under `src/db/migrations/` with the `ALTER`/`CREATE`/etc. needed to get an existing database there (for everyone else).

| Table | Purpose | Notable columns |
|---|---|---|
| `schema_migrations` | Tracks which numbered migrations have been applied | `version`, `name`, `applied_at` |
| `indexer_cursor` | Single-row resume state for the poll loop | `paging_token`, `last_ledger`, `contract_id` (cursor is discarded on a cold start if it belongs to a different contract) |
| `events` | Append-only raw event log — the source everything else is derived from | `symbol`, `topics` (JSONB), `data` (JSONB), `tx_hash` |
| `members` | Current membership state | `contribution`, `stake`, `has_active_loan`, `pending_claimed`, `name` (from the registry) |
| `loan_proposals` | Loan votes in flight | `status` (`pending`/`approved`/`rejected`), `votes_for`, `votes_against` |
| `loans` | Disbursed loans | `status` (`active`/`repaid`/`defaulted`), `outstanding`, `total_repayment` (carried over from the originating proposal), `due_time`. **`id` doubles as the originating `loan_proposals.id`** — the contract reuses the proposal's own id for the disbursed loan rather than a separate counter, since a proposal produces at most one loan. |
| `treasury_proposals` | Treasury withdrawal votes | `private` (routed through commit-reveal instead of open voting), `status` |
| `notifications` | Per-address notification feed | `type`, `read`, indexed on `(address, read)` |

On-chain `i128` amounts are stored as `NUMERIC(40,0)` (an i128's max value is ~1.7×10³⁸, which fits under 10³⁹) and returned from the API as **decimal strings**, never JSON numbers, to avoid silent precision loss — this was in fact a real bug found and fixed during development: `pg` returns Postgres `BIGINT` columns as JS strings by default, and the original code assumed they came back as numbers.

## Event catalog

The full topic-symbol → data-tuple mapping this service decodes (kept in sync with `ourdao-contracts`'s `env.events().publish(...)` calls):

| Symbol | Fields | Derived-table effect |
|---|---|---|
| `joined` | `member, fee` | upserts `members`, notifies the member |
| `exited` | `member, share` | marks the member exited |
| `claimed` | `member, pending` | tracks claimed yield |
| `loan_req` | `id, borrower, amount, total_repayment` | inserts a pending `loan_proposals` row |
| `loan_edit` | `proposal_id, borrower, new_amount, total_repayment` | updates the proposal |
| `loan_vote` | `proposal_id, voter, support` | increments the vote tally |
| `loan_appr` | `id, borrower, amount` | marks the proposal approved, opens a `loans` row, flags the borrower's `has_active_loan` |
| `loan_rpy` | `loan_id, borrower, outstanding` | updates outstanding balance; marks `repaid` when it hits zero |
| `loan_dflt` | `loan_id, borrower, penalty` | marks the loan `defaulted`, clears the borrower's `has_active_loan` |
| `interest` | `interest, active` | no per-member payload — retained in the raw event log only |
| `tre_prop` | `id, amount, destination, private` | inserts a pending `treasury_proposals` row |
| `tre_vote` | `id, voter, support` | increments the vote tally |
| `tre_exec` | `id, amount, destination` | marks the proposal executed, notifies the recipient |
| `staked` / `unstaked` | `member, amount, new_stake` | updates the member's stake |
| `name_reg` | `name, owner` | updates the member's registered name |
| `committed` | `proposal_id, voter` | notifies the voter their commit was recorded |
| `revealed` | `proposal_id, voter, support` | tallies the same as an open vote |
| `doc_attn` | `kind, proposal_id, caller` | (raw log only — the content hash itself is read live from the contract, not indexed) |
| `init`, `admin_add`, `admin_rem`, `threshold`, `policy`, `paused`, `unpaused` | varies | admin/governance events — surfaced via `/api/admin/log`, not folded into a derived table |

## API reference

Base path: `/api`.

| Method & path | Description |
|---|---|
| `GET /health` | Liveness check + the currently configured contract id. No DB round trip. |
| `GET /ready` | Readiness probe — checks Postgres reachability and indexer freshness. Returns `503` with a `reason` when Postgres is down or the indexer cursor is stale. |
| `GET /api/stats` | Aggregate counts (members, loans, proposals) + the last indexed ledger. |
| `GET /api/members` | Active members. |
| `GET /api/members/:address` | Single member. |
| `GET /api/proposals/loan` | Loan proposals with vote tallies. |
| `GET /api/loans` | Loans. Optional `?borrower=`, `?before=<id>` for pagination. `status` is `active`, `repaid`, or `defaulted` — a loan is marked defaulted once it's past due plus the policy's grace period (permissionless on-chain, see `ourdao-contracts`). |
| `GET /api/loans/:id` | Single loan. |
| `GET /api/proposals/treasury` | Treasury proposals with vote tallies. |
| `GET /api/notifications?address=` | Notifications for an address. |
| `PATCH /api/notifications/:id/read` | Mark one notification read. |
| `PATCH /api/notifications/read-all?address=` | Mark every unread notification for an address read. |
| `GET /api/events` | Raw event feed. Optional `?symbol=`, `?before=<ledger>`. |
| `GET /api/admin/log` | Admin/governance audit trail — init, admin add/remove, threshold changes, policy changes, pause/unpause. |

All list endpoints accept `?limit=` (default 50, max 200). `?before=` is a cursor: pass the `id`/`ledger` of the last row you saw to page further back. On-chain `i128` amounts are returned as decimal **strings** to preserve precision (see [Database schema](#database-schema)); ledger sequence numbers are returned as regular JSON numbers.

## Testing

```bash
# One-time: create the test database (separate from the dev DB above)
docker exec <postgres-container> psql -U ourdao -d postgres -c "CREATE DATABASE ourdao_test;"

npm test          # vitest, against ourdao_test — never touches dev data
npm run lint
npm run typecheck
```

48 tests across 8 files, covering:
- Event decode logic (`decodeEvent`, `toJsonSafe`) in isolation.
- Every indexer handler (membership, loan lifecycle including defaults, treasury, staking, registry, commit-reveal privacy) against a real Postgres instance — not mocked.
- Every API route, exercised through a real Fastify instance via `.inject()`.

Tests apply the real `schema.sql` and truncate all tables between runs (`test/db.ts`). CI runs all of the above plus `npm run build` against a Postgres service container on every push and PR (`.github/workflows/ci.yml`).

## Security notes

- **No custody, ever.** This service holds no private keys and has no code path that constructs, signs, or submits a transaction. It is a read model over public on-chain events.
- **Fail-soft, not fail-open.** If the indexer falls behind or the RPC endpoint is unreachable, reads degrade to stale/empty data (surfaced to the frontend as such) rather than the API crashing or serving incorrect state.
- **CORS is explicit.** `CORS_ORIGIN` defaults to `http://localhost:3000` in both code and config — a production deployment should set this to the real frontend origin. Setting it to `*` is supported as an explicit opt-in but logs a warning at startup.
- **Input handling.** All route parameters (addresses, ids, cursors) are validated before being used in parameterized queries — no raw string interpolation into SQL anywhere in the codebase.
- **Rate limiting.** Global rate limiting (`@fastify/rate-limit`) is applied to all API endpoints, with a stricter per-route limit on `GET /api/events`. Health and readiness probes are exempt. Behind a reverse proxy, set `TRUST_PROXY=true` so limits apply per client IP. With in-process limiting, the effective global limit is `RATE_LIMIT_MAX × instance count`.

## Status

MVP — the indexer and read API are implemented for the full event catalog, including loan defaults, with test coverage across every indexer handler and API route. Known gaps:

- No reorg handling — Soroban/Stellar finality makes deep reorgs very unlikely in practice, but the indexer doesn't currently detect or recover from one if it happened.
- Single indexer instance — no leader-election or multi-instance coordination if you wanted to run more than one worker for redundancy.
- IPFS pinning for document metadata is a frontend/contract-facing concern (`ourdao-frontend`'s `lib/ipfs.ts`), not something this service indexes today beyond the raw `doc_attn` event.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, how to run the test suite against a real Postgres, and the backend-specific rules (read-only boundary, append-only event log, transactional event folding). Please claim an issue before opening a pull request.

Found a security vulnerability? Don't open a public issue — use GitHub's private vulnerability reporting on this repo.

## License

MIT
