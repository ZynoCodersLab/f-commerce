# Review, feat/team-staff-invites, 2026-11-12

**Reviewed by**: MiniMax-M2.7 (author on DeepSeek V4.1 Flash Free)
**Scope**: 85 changed files, branch vs main
**Verdict**: Approve with nits

## Summary

A well-structured team and staff invites feature with solid architecture: Clean Architecture layers properly separated, token security using SHA-256 hashing with timing-safe compare, accept transaction using `SELECT ... FOR UPDATE` to serialize race conditions, Redis-backed rate limiting that fails open, and a worker with proper stale job detection, retry backoff, and graceful shutdown. All 24 acceptance criteria from spec 0009 are addressed. The invite acceptance flow, role authorization, membership revocation, and session clearing on `BUSINESS_ACCESS_DENIED` all work as designed. The main gaps are the absence of rate limiting on member write operations (role change, removal) and a few untested error paths.

## Blockers

None.

## Major

None.

## Minor

### 🟡 Missing rate limiters on role change and member removal, `backend/src/presentation/controllers/team.controller.ts:229-264`

The spec (AC-24) names rate limits for invite create/resend/accept/preview, but the `PATCH /members/:id` and `DELETE /members/:id` endpoints carry no rate limit middleware. A compromised owner account could rapidly change roles or repeatedly remove/re-add members at no shared cost. AC-24 does not list these operations, so this is not a spec violation, but the same Redis store infrastructure is already wired up for invites and could apply here at minimal cost.

### 🟡 `processInviteEmailJob` catches and re-throws on the final attempt, `backend/src/application/services/invite-worker.ts:52-58`

When an unexpected error reaches the `catch` block on attempt 4 (the last), the code marks the email failed, then `throw error`. BullMQ receives this as a job failure and may schedule one more retry depending on how it counts attempts relative to `INVITE_JOB_ATTEMPTS = 4`. The spec guarantees "initial attempt plus three retries," which this code does satisfy, but the re-throw is redundant since the job will be discarded anyway. Safer to `return { outcome: 'FAILED' }` instead of throwing.

## Nits

- ⚪ `backend/src/application/services/invite-worker.ts:52`, `INVITE_JOB_ATTEMPTS` is 4 but the spec says "initial attempt plus three retries" (1, 2, 4 minutes). The comment in `invite-job.ts` says "four total attempts." These are consistent, but the spec text "initial attempt plus three retries" should match the comment. Not actionable — the code is correct.
- ⚪ `frontend/src/app/settings/team/page.tsx:117-121`, `requestAnimationFrame` is used to read the token and set `currentUserId` before the first render. This is a minor performance trick, but it means the page briefly renders without knowing the current user's role, showing action buttons in the loading skeleton state. Correct but fragile.
- ⚪ `packages/contracts/src/team.ts:38`, `InviteEmailStatusEnum` uses `z.enum` but the email status values are never validated at runtime against the schema — the backend writes them as plain text. This is safe because the DML always uses the domain constants, but a future code change that uses the raw string could bypass validation. No action needed.
- ⚪ `backend/src/infrastructure/queue/invite-queue.ts:69-93`, when a timeout occurs, the `added` promise continues in the background. The `job.remove()` is called on it, but if Redis is slow rather than down, the job might complete before `remove` fires, making the remove a no-op. The job then stays in Redis until its TTL expires. Minor operational concern only.

## Strengths

- The `SELECT ... FOR UPDATE` in `acceptInvitation` (`team.repository.ts:649`) correctly serializes concurrent accept attempts and accept racing a resend, with all stale state checks inside the lock.
- Token security is solid: 32 random bytes, SHA-256 hash stored, raw token returned only once in the create/resend response, `timingSafeEqual` for comparison, and `Referrer-Policy: no-referrer` + `Cache-Control: no-store` + `X-Robots-Tag: noindex` on every response carrying a link.
- Rate limiting with a Redis store that fails open to an in-memory fallback, so a Redis outage does not block invite creation.
- `requireBusinessRole` checks the live `business_members` row on every request, so role demotion and removal take effect immediately without waiting for token expiry.
- `clearSessionOnBusinessAccessDenied` in `apiFetch` clears the session after a 403 with that specific code, and the `useRequireAuth` guard subscribes to auth changes — any screen the removed member navigates to redirects them to login.
- `activeMemberships` in `auth.service.ts` filters to `status === 'ACTIVE'` only, so a removed membership does not appear in refreshed tokens.
- The `rotateInvitation` guarded update (`team.repository.ts:328-348`) uses the expected token hash as a condition, so a race between two concurrent resends resolves correctly with one getting `InviteResendConflictError`.
- Comprehensive unit tests in `team.service.test.ts` covering all critical paths: race conditions, last owner, self-change, expired invitations, concurrent accept, and the email/queue failure modes.
- The `invitation-token.ts` `INVITE_TTL_MS` constant centralizes the seven-day expiry in one place used by both the service (for create/resend) and the worker (for expiry checks).

## Test coverage

The suite covers the new logic well. `team.service.test.ts` has 27 test cases covering invite create (including race conditions, queue failure, provider skip, pending conflict), resend (including conflict and not-found), cancel, role change (promote, demote, self-change, last owner), removal (self, last owner, unknown member), preview (all error states), and accept (all account types, races, name fallback, email mismatch, expired). `invite-worker.test.ts` covers stale jobs, expiry while queued, already member, and send failures. `auth-client.test.ts` covers the `BUSINESS_ACCESS_DENIED` session clear and the `getUserIdFromToken` helper. `auth-guard.test.ts` covers the redirect on session clear and the `redirectAuthenticated: false` mode for the invite page.

Gaps that are real but not blocking: the `cancel` service method is tested only indirectly through `revokeInvitation`; the `removeMember` service path has no dedicated test (the controller test covers the HTTP 204); the `clearSessionOnBusinessAccessDenied` code path in `apiFetch` when the response body is not JSON is exercised by the existing test ("keeps the session when a 403 body is not JSON"); the `auth.service.ts` unique violation catch blocks in `register` and `oauthLogin` for duplicate email are not exercised (rare race condition).
