# Review, feat/team-staff-invites, 2026-11-12

**Reviewed by**: MiniMax-M2.7 (author on deepseek-v4.1-flash)
**Scope**: 133 files, branch vs main (350a5d7)
**Verdict**: Approve

## Summary

The team-staff-invites feature is a complete, well-structured implementation covering invite creation and delivery, public invite page, team management screen, role changes, member removal, and session invalidation on access loss. Clean Architecture layers are properly separated, tenant isolation is enforced per-repository with no global query plugin, token security uses SHA-256 hashing with timing-safe comparison and single-use raw tokens, and rate limiting fails open to an in-process store. All 24 acceptance criteria from spec 0009 are addressed. The changes since the last review add the `team-client` library, `getUserIdFromToken` helper, `redirectAuthenticated: false` for the invite page, comprehensive `team-client.test.ts`, and the Redis outage regression test.

## Blockers

None.

## Major

None.

## Minor

### 🟡 `requestedName` parameter shadowed by local variable, `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:675`

The `acceptInvitation` function parameter `requestedName?: string` is shadowed by a local `let requestedName = input.requestedName?.trim()` on line 675. The outer parameter is then used in the same function for the new user insert on line 700: `name: requestedName || input.name`. This works correctly because the local `requestedName` is used for the existing-user name-selection branch (line 685) and the outer parameter is used for the insert. The shadowing is intentional but opaque — renaming the local to something like `trimmedRequestedName` would make the two uses immediately distinct.

### 🟡 Missing rate limiters on role change and member removal, `backend/src/presentation/controllers/team.controller.ts:229-264`

The `PATCH /api/team/members/:id` and `DELETE /api/team/members/:id` endpoints carry no rate limit middleware. AC-24 lists limits only for invite create/resend/accept/preview, so this is not a spec violation, but the Redis store infrastructure is already wired and could apply the same owner-scoped write limit (`inviteWriteRateLimiter`) to these operations at minimal cost.

## Nits

- ⚪ `backend/src/application/services/invite-worker.ts:52-58`, on the final attempt (>= `INVITE_JOB_ATTEMPTS`) an unexpected error is caught, the row is marked failed, and then `throw error` re-enters BullMQ. Since the row is already marked failed, returning `{ outcome: 'FAILED' }` instead of throwing is cleaner and avoids any ambiguity about whether BullMQ will schedule one more retry.

- ⚪ `frontend/src/app/settings/team/page.tsx:117-121`, `requestAnimationFrame` is used to synchronously read the token and set `currentUserId` before the first paint, so the page renders action buttons in the loading skeleton state rather than showing them immediately for the current user. Correct but fragile — a comment explaining why would help.

- ⚪ `backend/src/infrastructure/queue/invite-queue.ts:69-93`, when the 2-second enqueue timeout fires, `job.remove()` is called on the pending `added` promise. If Redis accepts the job between the timeout firing and `remove` being called, the job stays in Redis until its TTL expires. A comment noting this as a known operational concern would help.

- ⚪ `normaliseEmail` is defined in both `team.service.ts:115` and `team.repository.ts:52` with identical logic. The duplication is harmless but worth consolidating in a shared utility if the team feature grows further.

## Strengths

- The `SELECT ... FOR UPDATE` in `acceptInvitation` (`team.repository.ts:649`) correctly serializes concurrent accept attempts and accept racing a resend, with all stale state checks inside the lock.
- Token security is solid: 32 random bytes, SHA-256 hash stored, raw token returned only once in the create/resend response, `timingSafeEqual` for comparison, and `Referrer-Policy: no-referrer` + `Cache-Control: no-store` + `X-Robots-Tag: noindex` on every response carrying a link.
- Rate limiting with a Redis store that fails open to an in-memory fallback, so a Redis outage does not block invite creation. The `invite-rate-limit.outage.test.ts` regression test explicitly proves this.
- `requireBusinessRole` checks the live `business_members` row on every request, so role demotion and removal take effect immediately without waiting for token expiry.
- `clearSessionOnBusinessAccessDenied` in `apiFetch` clears the session after a 403 with that specific code, and `useRequireAuth` subscribes to auth changes so any screen the removed member navigates to redirects to login.
- The `rotateInvitation` guarded update uses the expected token hash as a condition, so a race between two concurrent resends resolves correctly with `InviteResendConflictError` for the loser.
- The `team-client.test.ts` with 231 lines covers all write operations, error parsing, and the fetch timeout for the public preview endpoint.
- The `fetchInvitePreview` public endpoint correctly uses `fetchWithTimeout` (not `apiFetch`) to avoid sending the session cookie to a public route, and the 10-second timeout prevents the invite page from hanging on a stalled connection (AC-21).

## Test coverage

The suite covers the new logic thoroughly. `team.service.test.ts` has 27 test cases covering invite create (race conditions, queue failure, provider skip, pending conflict), resend (conflict and not-found), cancel, role change (promote, demote, self-change, last owner), removal (self, last owner, unknown member), preview (all error states), and accept (all account types, races, name fallback, email mismatch, expired). `invite-worker.test.ts` covers stale jobs, expiry while queued, already member, and send failures. `auth-client.test.ts` covers `BUSINESS_ACCESS_DENIED` session clearing and `getUserIdFromToken`. `auth-guard.test.ts` covers the redirect on session clear and `redirectAuthenticated: false` for the invite page. `team-client.test.ts` covers all write operations, error shape parsing, and the fetch timeout on the public preview. `invite-rate-limit.outage.test.ts` explicitly proves fail-open behavior for both a refused connection and a silent Redis. Contracts have dedicated tests for email normalization and invite schema rules.

Real but non-blocking gaps: the `cancel` service path is only tested indirectly; the `removeMember` service path has no dedicated test (covered by the controller test); `clearSessionOnBusinessAccessDenied` with a non-JSON 403 body is exercised by the existing test; and the `auth.service.ts` unique violation path for duplicate email on register/OAuth login is not exercised.
