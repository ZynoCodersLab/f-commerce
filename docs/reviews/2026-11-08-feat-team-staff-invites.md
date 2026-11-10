# Review, feat/team-staff-invites, 2026-11-08

**Reviewed by**: GLM-5.3-Flash Free (author model not specified)
**Scope**: 79 files, branch vs main (merge base 350a5d7)
**Verdict**: Approve with nits

## Summary

The change implements the complete team/staff invite loop: an `invitations` table with hashed single-use tokens, a BullMQ worker delivering through Resend with 1/2/4-minute backoff, public preview/accept routes, an immediate per-request database membership check, owner-only management with last-owner/self-change guards, audit rows in the same transaction, fail-open Redis-backed rate limits, the legacy `INVITED` migration, and the team/invite screens. The layering is respected, the security model matches spec 0009 closely, and the test suite is unusually strong (concurrency races verified against real PostgreSQL). No blocking or major problems were found; the minors below are small resource-hygiene, stubiness, and layering-boundary items.

## Major

None.

## Minor

### 🟡 `decrement` can create TTL-less negative counters, `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:63`

**Problem**: When the Redis store falls back and an owner's rate limit is later corrected via `decrement`, the plain `redis.decr(key)` auto-creates the key with value `-1` and **no TTL**. The same applies to a `decr` that lands after the counter expired.
**Why it matters**: TTL-less keys accumulate in Redis (no expiry ever clears them), and a leaked negative counter skews the next real window (first `incr` after `decr-from-nothing` yields 0, silently forgiving one hit). Small, but permanent drift in a security counter.
**Suggested fix**: Replace `decr` with the same MULTI pattern used in `increment` plus a PTTL/NX, or delete-and-report instead of `decr` on keys that may not exist.

### 🟡 Application layer imports infrastructure, `backend/src/application/services/invite-worker.ts:1-11`

**Problem**: The application-layer job processor imports `config` from `infrastructure/config.js`, `InviteEmailJobData`/`INVITE_JOB_ATTEMPTS` from `infrastructure/queue/invite-queue.js` (the module that constructs BullMQ `Queue`), and `inviteUrlFor` from `infrastructure/services/invite-email.js`. `worker.ts:21-23` claims the application layer "never reaches for" the queue, but it reaches into the queue module (expression-index of the reverse dependency rule in the root/backend AGENTS.md: outer layers depend on inner layers, never the reverse).
**Why it matters**: Same-feature discipline is inconsistent — `TeamService` carefully receives `appOrigin`, the queue port, and the delivery port through constructor injection, while `invite-worker.ts` reaches back out. The reverse dependency makes the processor harder to reuse or test in isolation and invites DB/framework coupling to creep into `application/`.
**Suggested fix**: Move `INVITE_JOB_ATTEMPTS`/`InviteEmailJobData` into the application layer (or a domain-side port module), inject `emailReplyTo` (or a reply-to resolver) and a `buildLink` function the way `TeamService` does. `auth.service.ts` already imports `config`, so the codebase precedent exists, but this feature's own service shows the better pattern worth extending.

### 🟡 Every provider failure is retried, including permanent ones, `backend/src/application/services/invite-worker.ts:105-107`

**Problem**: `RETRY` is returned for any `errorCode`, including `EMAIL_NOT_CONFIGURED` and `PROVIDER_UNAUTHORIZED` (invalid/restricted API key), which cannot succeed on retry. The worker will spend the 1/2/4-minute schedule on four doomed attempts per invitation.
**Why it matters**: With a misconfigured key every invite burns a full retry cycle, so a batch of invites extends hours behind the backoff and hides the `PROVIDER_UNAUTHORIZED` signal in the delay, rather than failing fast (the row still ends `FAILED`, just ~7 minutes late per invite and with avoidable provider calls).
**Suggested fix**: Treat the two known-permanent codes as terminal (go straight to `FAILED` on first attempt), keep retrying only transient codes (`PROVIDER_RATE_LIMITED`, `EMAIL_SEND_FAILED`, network errors).

## Nits

- ⚪ `backend/src/presentation/controllers/team.controller.ts:1-3`, `express` (and `CookieOptions` from it) is imported in two separate statements; merge them.
- ⚪ `backend/src/application/services/auth.service.ts:56` and `:26`, the `passwordHash` parameter actually receives the **raw** password — misleading name, touched in this change; rename to `password`.
- ⚪ `backend/src/application/services/team.service.ts:200`, `InviteAlreadyPendingError(pending?.id ?? '')` fabricates an empty id when the winner's row cannot be re-read; the controller then omits `invitationId` and the screen shows generic copy. Consider a distinct code/message when the id is unknown.
- ⚪ `backend/src/application/services/auth.service.ts:145-147`, `issueTokensForUser`'s sort comparator is not antisymmetric (two non-preferred items compare 0 both ways while order is user-visible for landing business); fine at current sizes, but a one-line reorder (filter preferred first, append the rest) removes the reliance on a non-total comparator.
- ⚪ `frontend/e2e/team-invites.spec.ts:71,127,164`, `page.locator('code')` matches any `code` element on the page; a role/aria-label-scoped locator would survive an unrelated inline `code` in the invite panel.
- ⚪ `backend/drizzle/migrations/0007_tough_dark_phoenix.sql:33-38`, the placeholder-user delete checks memberships and `audit_logs` but not other `user_id` FKs (e.g. `refresh_tokens`); a referenced placeholder would abort the migration with an FK error rather than being skipped. Acceptable (loud failure, backup is in the plan), just worth a line in the runbook.

## Strengths

- **Race conditions are actually tested, against a real database**: last-owner demote race and remove/demote race (`team.repository.integration.test.ts:356,378`), accept vs cancel and accept vs resend with row locks (`:616,642`), plus the two-accept concurrency case. These are the paths most codebases only claim to handle.
- **Token hygiene is right end to end**: 32 random bytes, SHA-256 hash at rest, constant-time hash compare before a job acts, the raw token appearing only in the create/resend response and the transient job payload, per-token Resend idempotency key, and no-referrer/no-store/noindex on both API responses and the Next `/invite/:path*` route.
- **`requireBusinessRole` now checks the live membership row on every business request** (AC-17) and correctly distinguishes a DB failure (`next(error)`) from a permission denial — a removed or demoted member stops on the very next request, verified by middleware and route tests.
- **The fail-open rate limiter is well built and well tested**: shared Redis counters with two actual server instances, hashed keys, and the in-process fallback verified to still cap a flood during a Redis outage.
- **Deep AC traceability**: every test file and repository method carries the AC numbers it satisfies, and request-shaped edge cases (name fallbacks for passwordless accounts, email case-insensitivity, expired-while-queued, stale job after resend) all have named tests.

## Test coverage

Very strong for a feature of this size. Covered with meaningful assertions: service-level invite/resend/cancel/role/remove guards and unique-violation races; Drizzle repository behavior including the partial live-invite unique index and every business-scoped filter; full route tests through Express + real Postgres (401/403/409/410 paths, `BUSINESS_ACCESS_DENIED`, removed-member refusal, audit rows); the worker's full outcome matrix (sent, stale-hash ignore, accepted/revoked/not-queued ignore, expired-while-queued, retry vs terminal failure, unexpected-throw-on-last-attempt); email template escaping and error sanitisation; rate limiter shared-store and fail-open behavior; auth middleware DB-backed role checks (including demotion taking effect immediately and REFRESH rebuilding ACTIVE-only claims); frontend invite/team page interaction tests plus Playwright e2e for the real flow, cancel, duplicate invite, and signed-in acceptance.

Gaps, none individually severe: `MemoryFallbackStore`'s own window-expiry/sweep logic is only exercised indirectly (no standalone unit test); `enqueueInviteEmail`'s Redis-rejection path (`add` rejecting rather than timing out) is untested — only the timeout path is; the worker process entry point (`worker.ts`) startup/signal handling is validated manually and by the CI readiness log rather than a test; frontend page tests cover cancel-failure but not the role-change (promote/demote, LAST_OWNER) UI path — that behavior is covered at the service/route level. None gates the merge; they are candidates for `/test` follow-up.
