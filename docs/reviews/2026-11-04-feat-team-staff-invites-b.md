# Review, feat/team-staff-invites, 2026-11-04 (second pass, -b)

**Reviewed by**: GLM-5.3-Flash Free (fresh reviewer; author model not recorded in this session — prior passes were authored/reviewed on grok-4.7 per docs/scope/scope.md)
**Scope**: 78 files, branch vs main (merge base `350a5d7`), includes the uncommitted working-tree edits
**Verdict**: Blocked

## Summary

The invite slice is substantially complete and well tested: the data model, service, worker, rate limits, screens, and e2e all line up with spec 0009, and the newest edits (EmailDeliveryPort, business name via the token lookup, the late-job removal in the queue, strict ACTIVE filter, the lastSentAt contract field) are genuine improvements. Two things stop the merge: the newest `next.config.ts` header edit broke a committed test, so the frontend unit suite is red (verified locally), and it silently dropped a control the spec's security model names. One more real problem: the signed-in accept path forces a password into the form and the backend uses it to overwrite the account's password hash — an unverified credential reset that AC-8 does not sanction and that converts a stolen 15-minute access token into permanent account takeover. Backend `npm run test` passes 516/517 (1 skipped) against real Postgres and Redis; lint and typecheck are clean in all three workspaces.

## Blockers

### 🔴 Red frontend unit suite: invite `Referrer-Policy` header removed without updating its test, `frontend/next.config.ts:127` (assertion at `frontend/next.config.test.ts:79`)

**Problem**: The uncommitted edit to `frontend/next.config.ts` removed `Referrer-Policy: no-referrer` from the `/invite/:path*` header rule (the comment now argues the global `strict-origin-when-cross-origin` covers it), but the committed test `next.config.test.ts` ("keeps invite links out of referrers and search indexes") still asserts `headersByName(invite?.headers ?? [])['Referrer-Policy']).toBe('no-referrer')`. Verified locally: `npx vitest run` in the frontend workspace fails — **1 failed / 315 passed**.

**Why it matters**: The branch gate is CI on lint + typecheck + tests (root AGENTS.md), so the branch cannot merge green. More importantly, the spec's security model says explicitly: "Invite token in the URL: set `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex`." Dropping the header is a spec deviation made silently — `strict-origin-when-cross-origin` does protect the path cross-origin, but that reasoning lives only in a code comment; the spec and the test were never revisited.

**Suggested fix**: Either restore the `no-referrer` header on the invite route (aligns spec + test, zero cost), or make the change deliberately: update the test to assert the global policy covers invite links and amend the spec's security model line with the rationale. Either way, get the suite green before merge.

## Major

### 🟠 Signed-in accept silently resets the account's password, `frontend/src/app/invite/[token]/page.tsx:147` + `backend/src/application/services/team.service.ts:389` + `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:672`

**Problem**: For an existing account **with** a password signed in as the invited email (`formMode` → `'accept'`), the page renders a required password field (submit stays disabled until 8+ chars) and sends `body.password`. The service hashes any `request.password` unconditionally — there is no guard on `callerUserId` — and the repository then overwrites `users.password_hash` for the existing account. Nobody ever verifies the current password. AC-8 defines this accept call as `{}` plus bearer; the e2e (`team-invites.spec.ts:204`) and the unit test (`page.test.tsx`, asserting `acceptBody` equals `{ password: 'another-pass-123' }`) codify the off-contract behavior.

**Why it matters**: This is the only password-change path in the app, and it requires no knowledge of the current password. The app's own threat model (next.config.ts: "The browser holds the access token in localStorage, so a strict script policy is the main defense against token theft") means a stolen access token is the realistic attack, and this endpoint turns a 15-minute token into permanent account control. It also confuses the legitimate user: they are asked for a password that looks like a check but actually rewrites their credential.

**Suggested fix**: In `accept` mode render no password input and send `{}`. Defensively, in `TeamService.accept` ignore `request.password` whenever `callerUserId` is set (password setting is only sanctioned for a passwordless account, AC-9), and in the repository only write `passwordHash` for the passwordless-account branch. Update the two tests that pin the password-sending behavior.

## Minor

### 🟡 Worker stale-job check omits email status, `backend/src/application/services/invite-worker.ts:62`

**Problem**: The spec invariant says "The worker verifies the token hash, email status, accepted state, revoked state, and expiry on every attempt before sending." The implementation checks token hash, id, accepted, revoked, and expiry — but not `emailStatus`. The gap is reachable through the `enqueueInviteEmail` timeout race: the row is marked `FAILED`/`QUEUE_UNAVAILABLE`, the late job still lands, `job.remove()` fails if the worker already picked it up, and the email is sent anyway (the row then self-heals to `SENT` via `markEmailSent`).

**Why it matters**: It makes the delivery state unreliable exactly when the owner was told the send failed, and it is a straight spec-conformance gap in the stale-job rule.

**Suggested fix**: Guard the send with `invitation.emailStatus === 'QUEUED'` (SKIPPED/FAILED jobs are never legitimate to send), and pin it with a worker test that marks the row FAILED and asserts the send is skipped.

### 🟡 Malformed `x-business-id` now produces a 500, `backend/src/presentation/middlewares/auth.middleware.ts:69`

**Problem**: The new DB-backed membership check passes the raw header into `findBusinessMember`, which compares it against a uuid column. A non-UUID value raises Postgres error 22P02, the catch forwards it via `next(error)`, and the client gets a 500 instead of a clean 400/403. The team repository guards with `isUuid(...)`; the middleware does not. Before this branch the middleware read token claims only, so this failure mode is new.

**Why it matters**: A client bug or a probing caller now hits the error path and the logs on every request instead of getting an immediate 400. It also muddies the "a database failure must not look like a permission decision" intent — a malformed header is neither.

**Suggested fix**: Validate the header with the domain `isUuid` helper and answer 400 for a malformed value before touching the database; add a middleware test case.

### 🟡 Duplicate `beforeAll(startPg)` leaks a connection pool, `backend/src/presentation/controllers/team.controller.route.test.ts:38`

**Problem**: The file has two `beforeAll` hooks that both call `startPg()` (lines 38–41 and 104–106). `startPg` is not idempotent — it allocates a new `Pool` and overwrites the module-level handle — so two pools are created per run and `stopPg()` closes only the second; the first leaks until the process exits.

**Why it matters**: Test-only, but an open pool keeps the worker alive after the suite and occasionally surfaces as Vitest open-handle warnings; it is also a trap for the next person who edits the file.

**Suggested fix**: Merge the two hooks into one `beforeAll` (set the rate-limit flag and start the database together).

## Nits

- ⚪ `backend/src/domain/repositories/team.repository.ts:111`, `existingUserName?: string` is dead: the service never sends it and the implementation ignores it. Remove it.
- ⚪ `frontend/src/app/invite/[token]/page.tsx:147`, `password.trim()` strips leading/trailing spaces from a user-chosen password; passwords should be sent verbatim (a leading space silently changes the credential).
- ⚪ `backend/AGENTS.md` ("Test files must stay serial (`vitest.config.ts` sets `fileParallelism: false`)") is stale after the config moved to `vitest.config.mts` in both workspaces.
- ⚪ `backend/src/presentation/controllers/team.controller.ts:163`, the `conflictCode` fallback maps an unmapped `ConflictError` to 409 `VALIDATION_ERROR` — a nonsensical code/status pairing. Returning 409 with a generic conflict code (or letting `sendInternalError` handle it) would be more honest if it ever fires.

## Strengths

- Race safety is done properly and proven: `SELECT … FOR UPDATE` on the invitation, a business-row lock that serializes role changes and removals, unique indexes as the last word on one live invite and one membership — and the integration suite actually runs the races (last-owner demotion, removal vs demotion, accept vs cancel, accept vs resend) instead of asserting they cannot happen.
- Defense in depth on authorization matches AC-17 exactly: the DB-backed `requireBusinessRole`, ACTIVE-only token claims, the refresh handler rebuilding through the same filter, and the staff/401/403 route matrix all tested; the newest strict `m.status === 'ACTIVE'` filter removed the last `?? 'ACTIVE'` leniency.
- `enqueueInviteEmail` keeps the add promise after the timeout race wins and removes the late job — a subtle BullMQ failure mode handled with a test pinning it.
- Regression hygiene: every pre-existing feature suite (customers, orders, products, auth middleware) was updated for the DB-backed middleware with seeded memberships, so the whole backend suite (516 tests) passes against real Postgres and Redis.

## Test coverage

Strong and multi-level: unit tests at the service boundary, integration tests against real PostgreSQL (including the two owner races and every accept staleness case), route tests through real Express (permission matrix, audit rows, token-hash-at-rest, cookie flags), worker job tests (stale token, retries, final failure, unexpected-throw), queue tests, rate-limit tests against real Redis (shared counters across two servers plus the fail-open fallback), contract tests, frontend unit tests, and a Playwright e2e happy path plus cancel/duplicate/signed-in-accept. Gaps tied to the findings above: no test pins the worker's email-status staleness check (it does not exist), the malformed `x-business-id` behavior is untested, and the red `next.config.test.ts` case shows the header change escaped its own test. The e2e does not exercise resend, role change, or removal, but the backend route tests cover those paths.
