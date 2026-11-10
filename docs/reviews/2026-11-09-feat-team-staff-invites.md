# Review, feat/team-staff-invites, 2026-11-09

**Reviewed by**: GLM-5.3-Flash Free (author on primary model)
**Scope**: 83 tracked files + 12 untracked files, branch vs `main` (merge base 350a5d7)
**Verdict**: Approve with nits

## Summary

This branch delivers spec 0009 end to end: a dedicated `invitations` table with SHA-256-hashed single-use tokens, owner-only team management with transactional last-owner protection, public preview/accept endpoints with layered rate limiting, a BullMQ/Resend worker in its own process, and matching team/invite screens. The code is a clean Clean Architecture slice with unusually good concurrency handling — the accept transaction locks the row, revalidates hash/expiry/revocation inside the lock, and refuses to rewrite an in-between `ACTIVE` membership — and every finding from the 2026-11-08 review passes is verifiably fixed and now pinned by tests (fallback key hashing, `APP_ORIGIN` production gate, in-transaction already-member check, passwordless signed-in accept, migration statement order). What remains is two small real edges — a 500 on an OAuth duplicate-email race and a concurrent-resend race that can return a dead link as success — and styling nits. Nothing blocks merge.

## Minor

### 🟡 OAuth duplicate-email race answers 500 instead of 409, `backend/src/presentation/controllers/auth.controller.ts:114`

**Problem**: The branch taught `oauthLogin` to map a `users_email_lower_unq` unique violation to `DuplicateEmailError` (auth.service.ts:106-111), which the register route catches and answers 409. The OAuth route's catch only handles `UnauthorizedError`, so the same `DuplicateEmailError` falls through to `sendInternalError` and answers 500. The two conversion paths the change added are therefore asymmetric: `register` wins the race politely, `oauth/:provider` does not.
**Why it matters**: The route is dev-only today (501 in production), so impact is low, but a first-time OAuth login racing a concurrent registration returns an opaque server error for the most common identity conflict, inconsistent with its sibling route.
**Suggested fix**: Add `DuplicateEmailError → 409` to the OAuth route's catch block, mirroring the register handler.

### 🟡 Concurrent resends can hand back a link that is already dead, `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:323`

**Problem**: `rotateInvitation` updates `WHERE id = :id AND business_id = :biz AND accepted_at IS NULL AND revoked_at IS NULL` without conditioning on the current `token_hash`. Two owners (or two tabs) resending the same invitation concurrently both succeed: the second `rotate` overwrites the first's hash, so the first owner's 200 response contains a link whose token no longer matches the stored hash and answers `INVITE_NOT_FOUND` when opened. The analogous create race is handled carefully (`invite` catches the unique violation and reports the winner); resend has no equivalent guard.
**Why it matters**: An owner who resends in one tab and shares from the other gets a link that looks confirmed but is rejected, with no signal on screen that they lost a race. The window is small (two rotates inside a few milliseconds) and recovery is a second resend, so this is an edge, not a data bug.
**Suggested fix**: Add `eq(invitations.tokenHash, previousHash}` to the rotate `WHERE` clause and, when no row updates, either surface a soft conflict or re-read and return the current link, so the response always carries a link that works.

## Nits

- ⚪ `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:156`, the comment says the disabled flag is read per request, but `config.RATE_LIMIT_DISABLED` is frozen at import time; behavior is fine (tests use `vi.resetModules()`), the comment overstates it.
- ⚪ `backend/src/presentation/controllers/team.controller.ts:48`, `new AuthService(authRepository)` builds a second `AuthService` instance beside the auth controller's; harmless (it is stateless), but a shared factory would make the duplication invisible.
- ⚪ `frontend/src/app/invite/[token]/page.tsx:70`, `formMode` checks `alreadyMember` before `wrong-account`, so a signed-in visitor who is not the invited person sees "You are already a member … Sign in to open it" for an invitation belonging to somebody else; secure (accept would 403), just a misleading message in a rare state.
- ⚪ `frontend/src/app/settings/team/page.tsx:320`, a `FAILED` invitation's date is labelled "Queued" per the spec's wording, which reads oddly next to the adjacent "Email failed" badge.
- ⚪ `packages/contracts/src/team.ts:86`, `isoDate = z.string()` accepts any string; fine for response-only DTOs, but a `z.iso.datetime()` variant would catch shape regressions in the backend's DTO mapping.

## Strengths

- **Concurrency is handled at the database level and proven against real Postgres.** The accept transaction selects the invitation `FOR UPDATE`, re-checks hash, expiry, revocation, and membership status inside the lock (including the in-between `ACTIVE` check added since the last review), the unique-violation retry never overwrites a winning account's password, and role change/removal take the business row lock before recounting owners — the integration tests race accepts, cancels, resends, and mutual demotions and assert exactly one outcome.
- **Every prior review finding is verifiably fixed and pinned by a test**: hashed keys in the memory fallback (`invite-rate-limit.fallback.test.ts`), `APP_ORIGIN` localhost rejection via the real schema (`config.test.ts`), in-transaction `ACTIVE` rewrite refusal, password required from a signed-in passwordless caller, `email_status = 'QUEUED'` guard in `settleEmail`, 429 link headers, the cancel panel clearing the dead one-time link, and the migration deletions reordered ahead of the unique lower-email index.
- **Queue degradation is genuinely defensive**: a 2-second enqueue deadline that still removes the late-accepted job, `removeOnComplete`/`removeOnFail` so the raw token does not linger in Redis, a stale-job skip via hash + `emailStatus !== 'QUEUED'`, and an idempotency key per invitation+hash so a lost response can never resend.

## Test coverage

Coverage is unusually thorough for `TESTS = configured`: 37 service tests pin the invite/resend/cancel/preview/accept state machines including all AC-8/AC-9 branches and the accept-vs-invite race; 14 worker tests cover every stale/expired/permanent/retry branch; 22+ Drizzle integration tests run last-owner and accept races against a real database; the route suite pins the 401/403 matrix, refresh cookie, and cross-business isolation; Redis limiter tests cover shared counters, decrement edge cases, per-token keys, and fail-open; config tests now import the real schema so a new production gate cannot silently default away; the backend scaffold test proves the production start-up exit; frontend page tests cover both screens' states and the `BUSINESS_ACCESS_DENIED` session clear, and Playwright drives invite → accept → dashboard plus the signed-in accept path end to end. The two Minors above have no dedicated tests (no concurrent-resend case, no OAuth duplicate-email case), which is consistent with their minor severity.
