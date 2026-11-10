# Review, feat/team-staff-invites, 2026-11-05 (pass b, sixth)

**Reviewed by**: GLM-5.3-Flash Free (fresh reviewer, sixth pass; earlier .agents/skills/* additions and prior docs/reviews/*.md files treated as not code under review)
**Scope**: 80 tracked files plus 24 untracked (test files, configs, worker test, e2e specs) — branch vs main (merge base `350a5d7`)
**Verdict**: Approve with nits

_Suites re-run in this session, independently: contracts **124 passed**; frontend unit **321 passed**; backend **525 passed / 1 skipped (33 files)** against the local real PostgreSQL — the Redis shared-counter cases self-skipped because no local Redis was reachable this session, which that suite announces explicitly; this is a machine limitation, not a suite failure. `npm run lint`, `npm run typecheck`, and `npm run format:check` all clean. The Playwright e2e suite was **not** run (it needs the full dev stack including Redis, which is not started on this machine) — that is stated plainly rather than guessed._

## Summary

The branch is the completed spec-0009 invite loop and it is in very good shape: the three previously open minors (failed-confirmation dialog UX, the invite page's missing password confirmation, the `format:check` red state) are all verifiably fixed in this tree. The headline question for this pass — whether the previously reported production `EMAIL_FROM` startup gate issue persists — is **resolved**: `EMAIL_FROM` is now schema-optional with no default (`config.ts:40`), the guard (`config.ts:62-76`) fires at import in both the API and the worker, and it was verified empirically here: `NODE_ENV=production` with blank `EMAIL_FROM`/`RESEND_API_KEY` exits 1 with `Invalid environment variables: RESEND_API_KEY is required in production. EMAIL_FROM is required in production.`, and with the key set but no sender the worker alone exits 1 with the sender message. `config.test.ts:219-242` now walks the real `envSchema` so a future default cannot silently defeat the gate again. What remains is small: one security-relevant filter that broke its own test mocks' shape (the test passes vacuously now), one error path that abandons the API's JSON envelope, and one public request with no timeout.

## Major

None.

## Minor

### 🟡 The ACTIVE-membership token filter is never asserted — the existing mocks predate it, `backend/src/application/services/auth.service.test.ts:104`

**Problem**: `activeMemberships` (`auth.service.ts:113-135`) now filters token claims to memberships whose `status === 'ACTIVE'`. The only upstream tests that drive it mock `findUserBusinesses` with rows like `{ businessId: 'biz1', role: 'OWNER' }` — no `status` field. Those rows are silently dropped by the new filter, and `jwt.sign` is mocked, so no assertion can tell the difference; the tests would pass unchanged if the filter were deleted. There is no test anywhere in the backend corpus that a `REMOVED` (or legacy `INVITED`) row is excluded from the refresh- or accept-minted token payload (verified by grep: no "REMOVED" appears in `auth.service.test.ts` or `auth.controller.test.ts`).

**Why it matters**: AC-17 says only `ACTIVE` memberships appear in access tokens _including when the refresh handler rebuilds them_ — this is exactly the branch, and it is security-flavoured. Today the enforcement point is genuinely covered (`requireBusinessRole` re-reads the row and is tested for `REMOVED` at `auth.middleware.test.ts:160-176`, and middleware ignores claims entirely), so a broken filter would not grant access — but a token would keep advertising a removed membership to any client that decodes it, and the filter is the only place the spec's "rebuilds through the same ACTIVE filter" invariant lives.

**Suggested fix**: Update the register/login/refresh mocks to return rows shaped like `findUserBusinesses` really does (`role`, `status: 'ACTIVE'` / mixed) and assert one negative case: a row with `status: 'REMOVED'` yields an empty or reduced memberships payload in `jwt.sign`. The test at `auth.service.test.ts:104` is currently asserting the old shape; per the project's own rule, changed behaviour with no test update is a finding.

### 🟡 A database failure in `requireBusinessRole` escapes the JSON error envelope, `backend/src/presentation/middlewares/auth.middleware.ts:86-91`

**Problem**: When the membership lookup throws, the middleware calls `next(error)`. `server.ts` installs no terminal error middleware, and every router routes its own errors through `sendInternalError`; nothing catches what a middleware raises. The response therefore comes from Express 5's default error handler — an HTML page (with a stack trace when `NODE_ENV` is not production), not the `{ error, message }` JSON every other failure on this API produces. The comment on lines 87-89 says the intent is "a plain server error", but the actual shape is a plain _HTML_ error.

**Why it matters**: A Postgres blip hits every business route: frontends that inspect `error`/`code` from the body (`TeamApiError.code`, the 429/403 handlers on the team screen) get `null` code and a misleading HTML document instead of `INTERNAL_ERROR`. The stack-in-dev default also contradicts the care `sendInternalError` takes to keep driver detail out of responses.

**Suggested fix**: Register one terminal `app.use((err, req, res, next) => sendInternalError(res, err))`-style handler in `server.ts` (or resolve the middleware itself, responding 500 through `sendInternalError`). It also backstops every router's own missed rejections.

### 🟡 The only unauthenticated request in the app has no timeout, `frontend/src/lib/team-client.ts:127-132`

**Problem**: `fetchInvitePreview` uses raw `fetch` without an `AbortController`. Every other request in the codebase goes through `apiFetch`, which aborts after `REQUEST_TIMEOUT_MS` (`auth-client.ts:58, 68-89`). A proxy that accepts the connection but never responds leaves the public invite page in its loading skeleton indefinitely (`page.tsx:203-217`), with no error state and no retry affordance — the worst place for a hard hang, since the visitor has no other page to fall back on (the "Try again" button only renders in the error state).

**Why it matters**: AC-21 requires error states on the invite page; a stall (as opposed to a clean failure) makes them unreachable. It is also the only caller for which credentials are deliberately omitted, so it is easy to assume `apiFetch` could not be reused — but `apiFetch` merely _adds_ headers when a session exists; for this endpoint they are ignored by the route, and a credentials-free variant with the same timeout is a two-line change.

**Suggested fix**: Give the preview request the same 10 s abort (a profile-less `apiFetch`-style helper or an `init`-augmented call), and let the existing `catch → problem` state handle the abort.

## Nits

- ⚪ `backend/src/infrastructure/services/resend-email.service.ts:63`, `new Resend(apiKey)` is constructed on every send; hoist a module-scoped client (the key is fixed per process by the startup gate).
- ⚪ `frontend/src/lib/auth-client.ts:101-103`, `getUserIdFromToken` does not re-pad the base64url segment before `atob`; a decode failure is swallowed and reported as "not the caller", which only degrades UI affordances (the server enforces everything this feeds), but padding it (`===` slice on length) would make the check honest.
- ⚪ `backend/src/presentation/controllers/team.controller.ts:196,212`, the `no-referrer`/`no-store`/`noindex` headers are set only after the service succeeds; error paths (409/429) skip them while `invitationRouter` sets them in both branches (`:290-299, 324-326`). Error bodies on those routes carry no token, so this is consistency, not exposure.
- ⚪ `backend/src/presentation/middlewares/auth.middleware.ts:78`, `new DrizzleAuthRepository()` per request; trivially cheap, but every other call sites the repository once at module scope.

## Strengths

- The previously-reported issues are really closed, verified line by line: the failed cancel/remove dialog now stays open with the error inside it (`page.tsx:287-298`, tested at `page.test.tsx:310`), the invite page has a real confirm-password field that is never posted (`page.tsx:355-373`, tested at `page.test.tsx:212,236`), `format:check` is clean, `setEmailAttempts` now pins the `tokenHash` like its siblings, and `MEMBER_NOT_FOUND` ships via `TeamErrorCode`.
- The production email gate is now both correct and regression-proof: optional-in-schema enforce-in-guard with an explanatory comment on why there is deliberately no default (`config.ts:30-40`), a worker-side re-check, and schema-level tests that would catch a re-introduced `.default()` (`config.test.ts:217-242`).
- The concurrency story remains the standout: accept runs under `SELECT … FOR UPDATE` on the invitation with a token-hash re-check inside the transaction (`team.repository.ts:627-652`), role change and removal serialize on the business row so the owner count cannot be raced (`:462, :561`), the partial unique index is the final word on one live invite, and the worker re-validates hash/status/accepted/revoked/expiry on every attempt and markers pin the hash so a late job can never resurrect a row (`invite-worker.ts:57-117`, `team.repository.ts:401-420`). The enqueue timeout race is handled by removing a late-accepted job instead of letting it send (`invite-queue.ts:87-109`).
- Coverage is genuinely multi-level and behaviour-driven: 33 backend files including a real-Postgres integration suite racing accepts and owner demotions, a 28-case route matrix (403/401/400/409/410 installs, header assertions, the stored-hash-vs-attacker-password check), worker defensive skips, limiter fail-open, plus frontend tests for each manage flow and a real Playwright suite for the user loop.
- CI starts Redis and the worker and waits for the worker's ready log before e2e (`.github/workflows/ci.yml`), and `worker.on('ready')` exists on BullMQ's Worker, so that wait is real.

## Test coverage

Run in this pass: contracts **124 passed**; frontend **321 passed**; backend **525 passed / 1 skipped (33 files, real PostgreSQL)** — the skip is the Windows-only SIGTERM signal test, and the Redis-backed limiter cases skipped themselves for lack of a local Redis; they run in CI (which the branch extends for exactly that). Lint, typecheck, and format:check are clean. E2E not run here (no Redis/full stack on this machine). The one flaky first-run failure the previous pass saw did not reproduce; this pass's backend run was clean end to end.

Gaps worth a line of work: the ACTIVE-filter assertion above (the one new unconditional gap), the now-stale mock shapes in `auth.service.test.ts:104`, and nothing observing DB-failure shape on a business route (the second Minor).
