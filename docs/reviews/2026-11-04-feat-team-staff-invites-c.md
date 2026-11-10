# Review, feat/team-staff-invites, 2026-11-04 (third pass, -c)

**Reviewed by**: GLM-5.3-Flash Free (fresh reviewer; prior passes authored/reviewed on grok-4.7, GLM-5.3-Flash Free, and grok-4.7 per docs/reviews)
**Scope**: 79 files, branch vs main (merge base `350a5d7`), including all working-tree fix edits and the untracked new files
**Verdict**: Changes requested

_Pass intent: verify each fix from the second pass (`2026-11-04-feat-team-staff-invites-b.md`) in the current tree, then hunt for regressions the fixes introduced. All eight earlier findings are confirmed fixed; one regression found._

## Summary

All eight findings from the second pass are genuinely fixed, not papered over: the invite `Referrer-Policy` header is back with its test green, the signed-in password-reset hole is closed end to end (UI sends `{}`, service drops the password for a signed-in caller, a route test proves the stored hash survives an attacker-supplied password), the worker now refuses any job whose row is not `QUEUED`, a malformed `x-business-id` answers 400 before touching Postgres, the duplicate `startPg` hook is merged, the dead `existingUserName` field is gone, backend/AGENTS.md names `vitest.config.mts`, and an unmapped `ConflictError` now surfaces as a 500 instead of a mislabelled 409 `VALIDATION_ERROR`. But the password fix was made one guard too broad: it also discards the password for the AC-9 branch the fix's own comment says is sanctioned — a signed-in caller whose invited account has **no** password — and a unit test pins that wrong behavior with a passwordless fixture. That is the one thing to correct before merge. Suites verified locally: the backend suite passed 519/519 (+1 skipped) in three of five full runs, with the intermittent timeout on a pre-existing EXPLAIN test (`product.controller.route.test.ts:622`, confirmed as `Error: Test timed out in 5000ms`) accounting for the two red runs — a Minor below; frontend 316 passed, contracts 124 passed.

## Major

### 🟠 Signed-in accept for a passwordless account silently discards the password, `backend/src/application/services/team.service.ts:392`

**Problem**: The guard added to close the password-reset hole is `if (!callerUserId && request.password)`. That keeps the reset from happening, but it also blocks the legitimate AC-9 path the comment right above claims is sanctioned: "Setting a password is only sanctioned for a new account or one that has none." A **signed in** caller whose invited account has no password hits exactly that case, and the password is now dropped on the floor:

- The UI routes them there: `frontend/src/app/invite/[token]/page.tsx` `formMode` returns `'set-password'` whenever `accountExists && !hasPassword`, signed in or not, and renders a **required** password field with the copy "Your account has no password yet. Add one to finish joining."
- The bearer goes along with the body (`acceptInvite` uses `apiFetch`, and `optionalUserId` picks the user out of it), so `callerUserId` is set, the mismatch check passes, and `passwordHash` stays undefined.
- The repository would actually apply it — `acceptInvitation` writes `passwordHash` for the existing-user branch whenever one is supplied (`backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:672`) — only the service guard intervenes. The response is 200, the membership activates, and the password the user was forced to type is silently discarded. The account stays passwordless; the promised credential never exists.

The unit test that pins this (`backend/src/application/services/team.service.test.ts:592`, "ignores a password sent by a signed in caller, so accept is not a reset") is built on the `user()` fixture whose default `passwordHash` is **null** (line 93) — so the test named "not a reset" is really asserting that a passwordless account cannot set its first password through a signed-in accept. Before this fix wave the behavior was correct on this path; the fix introduced the regression.

Reachability: passwordless accounts that hold sessions are real. `oauthLogin` creates users with no password hash (`backend/src/application/services/auth.service.ts:89-94`) and `POST /api/auth/oauth/:provider` issues tokens to them (dev only, 501 in production). The production path is narrower today (migrated placeholder users kept for audit references under AC-22 cannot sign in at all), but the branch is foundation code and the API accepts this shape from any client — this will bite as soon as passwordless sign-in ships, and it bites in dev e2e workflows now.

**Why it matters**: It is a silent 200 that discards required user input on a stated acceptance criterion (AC-9: "An existing account with no password may set one through the invite and then accept... the password is hashed with the same rules as registration and the account can sign in with it afterwards"). Either the criterion holds or the UI must not ask for the password; right now it does both.

**Suggested fix**: Key the guard on the thing the invariant actually cares about — whether the target account already has a password — which the service already has in hand: hash when `request.password && (!existingUser || !existingUser.passwordHash)`. That still ignores the password for a signed-in caller whose account **has** one (the reset hole stays closed; the anonymous side is covered by the existing `SignInRequiredError` branch), and it restores AC-9 for both the anonymous and signed-in passwordless cases. Fix the test at `team.service.test.ts:592` to use a fixture with a password hash, add a companion test that a signed-in caller with a passwordless account gets the password through, and keep the route test that proves the stored hash survives.

## Minor

### 🟡 Pre-existing EXPLAIN test intermittently times out at Vitest's 5s default, `backend/src/presentation/controllers/product.controller.route.test.ts:622`

**Problem**: A full backend run intermittently fails with `Error: Test timed out in 5000ms.` on "uses the text pattern index for the name prefix search" (observed twice in five runs; the failing run leaves 1 failed | 518 passed | 1 skipped). The test seeds 20,000 products, runs `ANALYZE`, then executes two `EXPLAIN` queries plus a transaction — which takes 5.4s wall clock on this machine and more under CI load. It predates this branch, and the branch's migrations do not touch `products`; the regression exposure is that this branch's CI gates on the backend suite and the branch gave the **frontend** Vitest config a `testTimeout: 15000` allowance for slow interactive tests (`frontend/vitest.config.mts:15`) while the new `backend/vitest.config.mts` sets none, so the default 5000ms still governs the heaviest test in the suite.

**Why it matters**: An intermittent red suite blocks merges and erodes trust in the gate; the failure is environmental, not behavioral, so it cannot be triaged by reading the assertion.

**Suggested fix**: Follow the frontend's precedent — set a `testTimeout` (or a per-test timeout argument on this one test) in `backend/vitest.config.mts` with the same reasoning comment about slow, real-database tests.

## Nits

- ⚪ `backend/src/application/services/team.service.test.ts:592`, the test name says "accept is not a reset" but the fixture is passwordless, so it does not exercise a reset at all — rename or change the fixture alongside the Major above (listed here so it is not lost if the Major is deferred).

## Strengths

- Fix quality is high, and every fix is pinned: the second pass's blocker is closed with the header restored **and** its test asserting it; the password-reset fix is proven at the route level (stored hash still `'hashed'` after an attacker password is sent) and at the service level; the new middleware test proves the malformed header never reaches the database (`expect(findMember).not.toHaveBeenCalled()`).
- The late-job problem now has working defense in depth: `enqueueInviteEmail` keeps the add promise and removes the job that lands after the timeout (`backend/src/infrastructure/queue/invite-queue.ts`), the worker refuses non-`QUEUED` rows, and `backend/src/infrastructure/queue/invite-queue.test.ts` (new) drives the fake-timer race end to end instead of mocking it away.
- The `ConflictError` fix is exactly right: mapped conflicts keep their codes, an unmapped one is treated as the programming mistake it is and goes to `sendInternalError` with a fixed body, so no client ever sees `409 VALIDATION_ERROR` again.
- Test hygiene improved beyond the findings: the owner-only/401 route matrix, self-removal, and a new `app-metadata.spec.ts` e2e that fetches every manifest/icon the layout names; AC traceability comments were added to the worker, token, and route test files.

## Test coverage

Strong and verified locally in this pass: backend 519 passed / 1 skipped in three of five full runs against real PostgreSQL and Redis, with the intermittent `product.controller.route.test.ts:622` timeout accounting for the two red runs (see the Minor — same suite, no behavioral failure); frontend 316 passed (includes the restored `next.config.test.ts` invite-header case); contracts 124 passed (includes the new AC-18 email normalization tests). The new `invite-queue.test.ts` covers the timeout/late-job race both ways. The gap is the one behind the Major: signed-in caller + passwordless account is asserted to drop the password (`team.service.test.ts:592`) rather than to apply it, and no integration or e2e test exercises that combination either.
