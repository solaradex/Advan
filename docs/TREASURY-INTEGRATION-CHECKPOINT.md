# Treasury integration checkpoint — 2026-10-26

## Purpose

This checkpoint captures the current Treasury governance implementation and defines the verification gate before any runtime integration is enabled. It is a source-code checkpoint, not a claim that the Treasury flow is production-ready.

## Included in this branch

- Deterministic policy evaluation and authenticated local JSON policy/approval routes.
- Quote/intent and transaction-message digest primitives in `src/treasury/executionGuard.ts`.
- A local-file reservation ledger with idempotency and one-time authorization primitives.
- A server-only PostgREST adapter in `src/treasury/postgres.ts`.
- SQL migrations for atomic exposure reservation, bound approval creation, approval decisions, expiry cleanup, and one-time approval consumption.
- Unit tests for policy evaluation, local store/ledger, and execution guard.

## Blocking gaps — do not enable guarded execution

1. The HTTP approval routes still use the local JSON store; the Postgres adapter has not been integrated into those routes. Do not assume the SQL controls are active.
2. `decidedBy` in the current JSON approval route is caller-supplied text, not authenticated identity. It is not proof of authorization.
3. The existing evaluation route accepts caller-supplied risk values and must not be used as authoritative risk or production authorization.
4. The current swap endpoint is not guarded by the Treasury ledger or Postgres approvals.
5. The unsigned Jupiter transaction is not yet instruction-inspected against the approved wallet, mints, amounts, destination, program allowlist, and slippage at both approval and handoff time.
6. The migrations have not been applied to a development or production Supabase database. No live database integration test has been run.
7. Expiry cleanup and on-chain reconciliation need tests and operational scheduling. A committed reservation is not proof of a confirmed swap.

## Required completion order

1. Add a real server-side operator identity verifier. Derive operator ID and approval role from verified claims; never accept an identity from request JSON.
2. Integrate the Postgres adapter into the Treasury control plane as the single source of truth; remove split local/Postgres approval state.
3. Build a server-validated intent path that obtains the quote and risk data from trusted services, decodes the unsigned transaction, and derives its transaction-message digest.
4. Atomically reserve exposure and create the approval against the exact intent, quote, transaction digest, and reservation.
5. Add authenticated approve/reject operations and an atomic one-time guarded unsigned-transaction handoff. Keep signing and broadcasting disabled.
6. Validate the transaction's fee payer, signers, programs, input/output mints, amounts, destination, and slippage against the approved intent both before approval and at handoff.
7. Add disposable-Postgres integration tests, concurrency/idempotency tests, expiry/release tests, and transaction-tampering tests.
8. Pass lint, typecheck, unit tests, build, and package-bin check in CI before marking this checkpoint verified.

## Verification status at checkpoint creation

- Previous CI run for commit `765e96f0285bb218bbb287b90567d48494c28545` failed at lint because of three unused imports in `src/http/app.ts`.
- Those unused imports were removed in commit `5597ef0591c7a759af3b896c14e14d70362afa7b`.
- A successful build/test run for that fix has not yet been confirmed.
- Do not enable autonomous execution, sign transactions, broadcast transactions, or describe this checkpoint as production-safe until all blocking gaps above are closed and CI is green.
