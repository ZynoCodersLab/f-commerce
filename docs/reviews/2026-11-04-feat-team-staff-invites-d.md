# Review, feat/team-staff-invites, 2026-11-04 (fourth pass, -d)

**Reviewed by**: GLM-5.3-Flash Free (fresh reviewer; the code was written under prior passes reviewed on grok-4.7 and GLM-5.3-Flash Free per docs/reviews)
**Scope**: 94 files, branch vs main (merge base `350a5d7`), including all working-tree fix edits and the untracked files
**Verdict**: Approve with nits

_Pass intent: read the whole diff independently, verify every finding from passes `-b` and `-c` against the current tree instead of trusting the fix notes, then hunt for anything the fix waves introduced. Suites re-run in this session: backend **520 passed / 1 skipped (33 files)** against real PostgreSQL (`postgres:local` test database) and Redis, no intermittents and no timeouts; frontend **316 passed (30 files)**; contracts **124 passed (7 files)**._

## Summary

The fourth pass confirms the branch is in merge shape. Every finding from the second and third passes is genuinely closed in code, not papered over: the invite `Referrer-Policy` header is back (`frontend/next.config.ts:127`) with its test green; the signed-in password reset hole is closed and the pass-c regression is fixed correctly — the guard is now keyed on whether the account already has a password (`maySetPassword = !callerUserId || !callerHasPassword`, `team.service.ts:394`), so a signed-in caller with a passwordless account **does** get their password while an attacker-supplied password is still ignored for an account that has one, and both cases are pinned by unit tests (`team.service.test.ts:592` now uses a fixture with an existing hash, `:605` covers the passwordless companion) plus the route test proving the stored hash survives (`team.controller.route.test.ts:534`); the worker refuses any job whose row is not `QUEUED`; a malformed `x-business-id` answers 400 before touching Postgres and a test proves `findMember` is never called; the duplicate `startPg` hook is merged; the dead `existingUserName` field is gone; backend/AGENTS.md names `vitest.config.mts`; an unmapped `ConflictError` surfaces as a 500; and `backend/vitest.config.mts` carries the 15 s `testTimeout` that fixed the EXPLAIN flake — the full backend suite now passes cleanly, including the previously intermittent 20,000-row plan test. What remains is a short tail: one vacuous integration test, an unbounded polling loop on the team screen, test-schema drift in `config.test.ts`, and a few nits.

## Minor

### 🟡 "counts owners only among active memberships" cannot fail, `backend/src/infrastructure/database/drizzle/repositories/team.repository.integration.test.ts:135`

**Problem**: The test removes a membership with `businessId = OTHER_BIZ and userId = OWNER`, but `OWNER` was never seeded into `OTHER_BIZ` — the update matches zero rows. The assertion `countOwners(BIZ) === 1` then holds trivially: `BIZ` has exactly one membership and no removed owner, so the test passes even if `countOwners` counted `REMOVED` rows. The exclusion it claims to prove is only exercised by accident elsewhere (`countOwners` is also asserted in races that all pass).

**Why it matters**: A named regression test that cannot fail gives false confidence; if someone later changes the ACTIVE filter in `countOwners` (e.g. drops `eq(businessMembers.status, 'ACTIVE')`), this test still passes and the count quietly starts including removed members, which feeds the last-owner guard in `changeRole` and `removeMember`.

**Suggested fix**: Seed a second, `REMOVED` owner membership inside `BIZ` (alongside the active owner) and assert `countOwners(BIZ) === 1`; consider asserting it would be 2 without the ACTIVE filter via a brief comment, or assert `listMembers` length alongside.

### 🟡 The team screen polls every 5 s forever while an invitation stays ` QUEUED`, `frontend/src/app/settings/team/page.tsx:156`

**Problem**: The interval effect starts whenever any invitation has `emailStatus === 'QUEUED'` and only stops when it clears. In the happy path the worker settles the row with seconds. But when the worker process is down, or Redis is up while the worker is not, the row stays QUEUED indefinitely, and every open tab polls `GET /api/team` every five seconds forever — across a team of owners, that is a persistent background request loop with no backoff, no cap, and no user-facing signal that nothing is progressing.

**Why it matters**: The path is realistic (the spec's own AC-4 scenario is a queue that cannot send). An unconditional 5 s polling loop for hours is exactly the kind of quiet cost that shows up later, and the screen also never tells the owner the send is stuck, which the FAILED path does handle nicely.

**Suggested fix**: Cap or slow the poll (e.g. keep 5 s for the first minute, then back off to 30–60 s), or lower the poll but surface a "still waiting to send — check that the worker is running" hint after N attempts. Even a simple counter-capped poll preserves the AC-3 "settles within five seconds without a refresh" behaviour while removing the unbounded loop.

### 🟡 `config.test.ts` mirrors the env schema by copy and has already drifted, `backend/src/infrastructure/config.test.ts:5`

**Problem**: The file re-declares the whole Zod env schema inside the test "(mirroring config.ts)" and claims "The real config.ts uses the same schema, so this validates the contract." The branch then added `APP_ORIGIN`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, and `RATE_LIMIT_DISABLED` to `config.ts`; of those only the email fields made it into the mirror — `APP_ORIGIN` and `RATE_LIMIT_DISABLED` are missing, so the mirror validates a schema the process no longer runs.

**Why it matters**: The tests pass whether or not the real schema and the mirror agree, so every future env change tends to forget one of the two copies — the file now looks green while asserting a contract that was silently left behind (the production-email block at `config.test.ts:202` is the only part wired to the real function).

**Suggested fix**: Either extract the env schema to a named export (`envSchema` in `config.ts`) and have the test import it directly (only `process.env` parsing stays out), or delete the mirror and keep just the `productionEmailProblems` tests; either removes the drift trap.

## Nits

- ⚪ `backend/src/infrastructure/database/drizzle/schema.ts:44`, `users.email` keeps both the original column-level `.unique()` and the new `users_email_lower_unq` index; the case-sensitive leftover is harmless but redundant now that identity is case-insensitive — worth a follow-up cleanup note rather than a change here.
- ⚪ `frontend/src/lib/team-client.ts:123`, the doc comment says "No session is required or sent" while the call passes `credentials: 'include'` (harmless — the route reads no cookie — but the comment and the code disagree).
- ⚪ `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:79`, `RedisRateLimitStore.resetAll()` clears only the in-process fallback, not the shared counters; nothing in production calls it today, but a green `resetAll()` that leaves half the counter behind is a trap for the next test author.
- ⚪ `backend/src/infrastructure/database/drizzle/repositories/team.repository.integration.test.ts:75`, several blocks reach for `(await import('../schema.js')).businessMembers` inline although the file already imports those tables at the top (lines 11, 339); pick one style.
- ⚪ `backend/src/application/services/team.service.ts:406`, the accept endpoint applies `request.name` to the caller's account on every sign-in accept even though the UI only ever sends a name in the set-password form; it is the caller's own account so there is no escalation, but the API surface is wider than the flow needs (the repository interface documents it, so this is a defensible choice — flagging for awareness).

## Strengths

- Every prior finding is fixed and pinned, verified line by line this pass: the header restore has its own assertion; the password invariant is now expressed once in the service (`maySetPassword`) and pinned at three levels — unit (both the with-password and passwordless signed-in cases), route (stored `'hashed'` survives an attacker password), and contract; the worker's `emailStatus !== 'QUEUED'` guard has its test; the `isUuid` 400 has a test proving no database call; the `ConflictError` fallback sends a fixed 500; and the `testTimeout` commit is accompanied by a reasoning comment and produced a clean backend run here.
- Race safety is still the standout: `SELECT … FOR UPDATE` on the invitation, a business-row lock that serializes role-change/removal past the last-owner check, the partial unique index as the final word on one live invite, and the integration suite genuinely running the races (concurrent demote/removal, accept vs cancel, accept vs resend) rather than asserting they cannot happen.
- The late-job defense in `enqueueInviteEmail` (keep the add promise after the timeout, remove the job that lands late) plus the worker-side status re-read closes the resend/double-send window from both ends, and `invite-queue.test.ts` drives the fake-timer race end to end.
- Production startup guard (`productionEmailProblems`) is enforced on both the API and the worker, and the previously server-only change (`process.exit(1)` on pool-start failure) is handled in the server test and rate-limit-disabled test so the added requirement never breaks the suite.
- Test hygiene beyond the findings: the owner-only/401 route matrix, self-removal, the AC traceability comments, and the new `app-metadata.spec.ts` e2e that fetches every manifest and icon the layout names plus byte-compares the served favicon.

## Test coverage

Verified live in this pass: backend 520 passed / 1 skipped across 33 files against real PostgreSQL and Redis; frontend 316 passed; contracts 124 passed. Coverage is multi-level and points at behavior, not mocks — the AC-9 fix now has both the pinned correct behaviour for the with-password case and the restored passwordless-set case, so the two branches the third pass flagged as mutually contradictory now have tests asserting opposite, correct outcomes. The gaps the minors live in: the `countOwners` exclusion case (vacuous as written), and no test observes the team screen's polling lifecycle (frontend coverage asserts statuses render, not that the interval stops). Resend, role change, and removal have no Playwright coverage, but the backend route and integration tests cover those paths thoroughly.
