# Review, feat/team-staff-invites (whole branch), 2026-11-08

**Reviewed by**: GLM-5.3-Flash-Free (review subagent, fresh model)
**Scope**: 81 changed files + 12 untracked new files, branch vs `main` (base diff from merge base 350a5d7)
**Verdict**: Approve with nits

## Summary

The branch delivers spec 0009 end to end: an invitations table with hashed single-use tokens, owner-only team management, a BullMQ/Resend delivery worker in its own process, a public preview/accept surface with rate limits, the team screen, and the invite page. The implementation is disciplined Clean Architecture (BullMQ, Drizzle, and Resend never leak into the application or domain layers), the security model is enforced in SQL (one live invite per business+lowercased email via a partial unique index, `FOR UPDATE` accept lock, business-scoped business-row locks serializing role changes), and last-owner/race/count logic is transactional. The test suite is the strongest part of the change: 153 backend new tests including real-Postgres races (two concurrent owner demotions, accept racing cancel, accept racing resend), Redis-backed limiter tests, worker stale-job tests, route-level 401/403 matrices, and Playwright e2e through the real UI. I found no blocker or major issues; the findings below are small real edges, not design problems.

## Minor

### 🟡 Invite can be created for an email that just became a member, and nothing cleans it up — `backend/src/application/services/team.service.ts:166-203`

**Problem**: `invite()` checks `findMemberByEmail` and `findLiveInvitationByEmail` before inserting. If the live invitation for that email is accepted between the checks and the insert, the membership becomes `ACTIVE` while the new invitation inserts successfully (the partial unique index only blocks two _live_ invitations; the accepted invitation is no longer live, so `(business_id, lower(email))` is free again). Nothing re-checks membership after the insert — neither the service, the response, nor the worker's pre-send validation (`invite-worker.ts:65-89` validates token hash, accepted/revoked/expiry and email status, but not membership).

**Why it matters**: The owner sees a confirmed pending invitation for someone already on the team and the worker happily emails a link whose accept will only ever answer 409. Harm is bounded (the invite page shows a clear "already on this team" state), but the team screen can show a permanent stale pending row that only a manual cancel clears, and the email noise goes out for a re-invite that succeeded a moment too late.

**Suggested fix**: Re-check membership after `createInvitation` and revoke the fresh row (or fail with `INVITE_ALREADY_MEMBER`) when the racing accept wins. A membership re-check in the worker's stale-job validation would also close the "email about to 409" case as an extra line of defence.

### 🟡 Any unique violation on accept is reported as `INVITE_ALREADY_MEMBER` — `backend/src/application/services/team.service.ts:413-416`

**Problem**: The catch around `acceptInvitation` maps _every_ unique violation to `InviteAlreadyMemberError`. The transaction inside can also hit `users_email_lower_unq` when two invitations for the same email race to create the _account_ (the membership row for this business is genuinely absent in that flow, which is why `existingMember` was null). The repository already produces the right specific errors (`InviteAlreadyAcceptedError`, `InviteRevokedError`, …) from locked-row checks, so this catch is reachable mainly for the account-insert case it does not distinguish.

**Why it matters**: The invitee who loses an account-creation race receives "This person is already a member of this business" — wrong, they are not a member — closing off a path that retrying would resolve. Misleading error codes on the public accept surface are worth the small extra discrimination.

**Suggested fix**: Have `acceptInvitation` translate the `users` unique violation at the lower layer (e.g. re-read what won: if an active membership exists for that email → `InviteAlreadyMemberError`, otherwise return the result of retrying against the existing user, or at least a `ConflictError` with a distinct message).

### 🟡 Accept/preview per-IP limits inherit the spoofable `X-Forwarded-For` key — `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:200-214`

**Problem**: `inviteAcceptRateLimiter` (5/15 min) and `invitePreviewRateLimiter` (30/min) key on `req.ip`, with `trust proxy = 1`. Per backend AGENTS.md, the per-IP model already depends on the host/Next proxy _overwriting_ XFF; on a host that does not strip a client-supplied XFF chain, the hop counted is attacker-controlled.

**Why it matters**: These two limiters are the only public-surface throttles in the feature, and per-IP + spoofable header means an attacker can rotate keys freely, defeating the flood protection exactly where it is not behind an owner session. The 256-bit token makes guessing links infeasible, so this is abuse/DoS protection, not brute-force defence — but the spec's AC-24 guarantees rest on a header the code cannot itself make trustworthy.

**Suggested fix**: At minimum, key the public limiters additionally on the token (a slow per-token counter, e.g. `ip:token` pair) so flooding still trips even with rotating IPs. Document the host requirement alongside the existing login-by-IP caveat; the deployment notes are the right place.

### 🟡 Team client write methods have no unit tests — `frontend/src/lib/team-client.ts:70-144`

**Problem**: `frontend/src/lib/team-client.test.ts` covers only `fetchInvitePreview` (timeout + success shape). `createInvite`, `resendInvite`, `cancelInvite`, `updateMemberRole`, and `removeMember` — including the `TeamApiError` field/code propagation the team page's error branches depend on — are untested at this layer. They are covered transitively via the page tests and e2e, but the error-parsing contract (`TeamApiError` from a 409 body carrying `invitationId`, etc.) is only exercised happy-path-adjacent.

**Why it matters**: The branch's whole error-handling UX (specific 409 message on the team screen, `BUSINESS_ACCESS_DENIED` session clear, 429 copy) hangs on this parsing; if it regresses, page tests whose mocks bypass the client still pass.

**Suggested fix**: One small table-driven test of `parseResponse`/`TeamApiError` construction against a representative error body would pin it.

## Nits

- ⚪ `backend/src/presentation/controllers/team.controller.ts:43-47`, `refreshCookieOptions` duplicates the identical object in `auth.controller.ts` — one shared exported constant would keep the two policies from drifting.
- ⚪ `backend/src/presentation/controllers/team.controller.ts:51-56`, the controller builds its own `new AuthService(...)`, `TeamService`, and repositories; the composition at process entry (as `worker.ts` does) would keep server-side wiring in one place.
- ⚪ `backend/src/domain/invitation-token.ts:18-23` vs `backend/src/infrastructure/services/invite-email.ts:105-107` and `backend/src/application/services/team.service.ts:469-471`, the invite URL builder exists three times (`inviteUrl`, `inviteUrlFor`, template) — one would do.
- ⚪ `backend/src/infrastructure/queue/invite-queue.ts:49-51`, the second `createRedisConnection('producer')` is the QueueEvents connection; a `role` label of `'events'` would make prod connection inspection honest.
- ⚪ `frontend/src/app/invite/[token]/page.tsx:163-166`, after a `SIGN_IN_REQUIRED` answer the flow says "sign in first, then come back to this link" but the sign-in page has no return-to-invite path; a `?next=` round trip would let the invitee land back on the link (spec AC-8 says the accept call requires sign in; the UX cost is the user keeping the email tab open).
- ⚪ `backend/drizzle/migrations/0007_tough_dark_phoenix.sql:38`, file lacks a trailing newline (generated, cosmetic).
- ⚪ Migration 0007 does not lowercase existing `users.email` values; all reads/writes are case-insensitive now, so this is inert, but the rows stay mixed-case until a future cleanup (the scope file already tracks it).

## Strengths

- **Concurrency is treated as a first-class concern and proven against a real database.** The accept transaction takes `SELECT ... FOR UPDATE`, re-verifies the token hash inside the lock (so a stale link after resend is an instant 404), and re-applies the accepted/revoked guards in its final `UPDATE ... WHERE`; role change and removal both take a `businesses` row lock so the last-owner count cannot be raced past. The tests actually pit two concurrent transactions against each other (`team.repository.integration.test.ts:356-399`) instead of pretending.
- **The queue/worker edge cases are handled thoughtfully**: the enqueue race after a timeout explicitly removes the late job; the worker re-reads the invitation and validates token hash, status, accepted/revoked state and expiry on _every_ attempt; the stale-job skip, the "create timed out and marked FAILED" ordering tangle, and the idempotency key `invite:<id>:<tokenHash>` are all correct and tested.
- **Test breadth is exemplary**: 500+ backend tests with real Postgres and real Redis, route-level 401/403/409/410 matrices, rate limiter behavior including the fail-open path, worker retries, config production gates verified by spawning the real server process, frontend state-machine page tests, contract tests, and Playwright e2e that signs the invitee through the real link.
- **Cross-cutting security hygiene is present everywhere it matters**: only the SHA-256 hash is stored, the raw token is never logged (console sites audited), link-carrying responses and the `/invite/*` route send `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`, the accept page hides the invitation from search and referraers on both the API and the Next side, and the one-time link is shown exactly once.
- **Convention adherence is clean**: layers hold (application `invite-worker.ts` imports no BullMQ/Drizzle/Resend, its deps arrive as narrow ports from `worker.ts`), DTOs not entities cross into presentation, env validation got a real-schema contract test instead of a mirror copy, and no host name is hardcoded.

## Test coverage

Very strong. Highlights:

- Service tests cover create/resend/cancel/preview/accept state machines, the expired-invite-replaced flow, the unique-index race translated to a named pending conflict, queue-unavailable (`FAILED` + `QUEUE_UNAVAILABLE`) and provider-absent (`SKIPPED`) outcomes, and the AC-8/AC-9 branches (sign-in required, email mismatch, passwordless set-first-password, name fallbacks including the signed-in caller who already has a password).
- Repository integration tests run against real PostgreSQL and cover tenant isolation (`never returns another business members`), the partial unique index for letter case, last-owner races, accept-racing-cancel and accept-racing-resend, and stale-token refusal.
- Route tests pin the owner-only matrix (401/403 per endpoint), removal cutting access on the next request, the refresh cookie on accept, and cross-business 404s.
- Limiter tests exercise the Redis store (shared counters across "instances", decrement script edge cases including legacy negative keys, fail-open under a dead Redis) and the AC-24 caps for write/preview/accept.
- Worker tests cover every stale/skip/expired/permanent-error/retry-exhaustion branch plus the unexpected-throw-on-final-attempt failure recording.
- Frontend page tests cover invite display/accept states, password confirmation never posted, poll backoff, staff read-only view, one-time link panel, and the `BUSINESS_ACCESS_DENIED` session clear; Playwright e2e drives invite → accept → dashboard through the real stack in CI with Redis and the worker started.

Gaps worth a line, not a rework: `team-client` write methods (above), no route-level end-to-end assertion that the 6th accept actually returns 429 (the limiter tests cover counting; the handler is generic), the 1/2/4-minute backoff is trusted to BullMQ's exponential function rather than asserted, and no route-level test for `EMAIL_MISMATCH` 403 (service-level test exists).
