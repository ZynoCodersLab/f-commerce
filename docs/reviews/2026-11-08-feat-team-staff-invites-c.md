# Review, feat/team-staff-invites (whole branch), 2026-11-08

**Reviewed by**: Crouton Alpha (author on unknown)
**Scope**: 82 changed files + 41 untracked new files, branch vs `main` (base diff from merge base 350a5d7)
**Verdict**: Approve with nits

## Summary

The branch delivers spec 0009 end to end: an invitations table with hashed single-use tokens, owner-only team management, a BullMQ/Resend worker in its own process, a public preview/accept surface with rate limits, the team screen, and the invite page. The implementation is disciplined Clean Architecture with transactional race handling (`FOR UPDATE` accept lock, business-row locks for last-owner checks, one live invite per business+email via partial unique index) and strong token hygiene. No blockers or majors remain; the findings below are small real edges that are worth a fix soon but do not block merge.

## Minor

### 🟡 Accept reactivates an active row without an in-transaction check, `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:698`

**Problem**: `acceptInvitation` updates `business_members` for `(business_id, user_id)` without first checking `status`. The service does check `findMemberByEmail` (ACTIVE only) before the transaction and throws `INVITE_ALREADY_MEMBER` there, but inside the transaction an `ACTIVE` row that appeared between the check and the lock would be silently rewritten to `STAFF`/`ACTIVE` instead of returning 409.
**Why it matters**: Today the one-live-invite index plus the invitation lock makes that interleaving near-unreachable, so this is defense in depth rather than a live exploit. If it ever did happen it would demote an `OWNER` to `STAFF` on the accept path and bypass the “already a member” contract.
**Suggested fix**: Re-read the membership status inside the accept transaction after locking the invitation; if it is `ACTIVE`, throw `InviteAlreadyMemberError` before the update.

### 🟡 Memory fallback keeps raw invite tokens as rate-limit keys, `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:80`

**Problem**: The Redis path hashes every limiter key via `keyFor` before storing it, but the fail-open path calls `this.local.increment(key)` with the unhashed key. For the token limiters that key is `token:<raw-token>`, so during a Redis outage raw bearer secrets live in process memory maps.
**Why it matters**: The spec states the token is never stored raw outside the active job and the rate limiter comment explicitly says the store hashes every key so the raw token is never stored. The fallback violates that invariant in exactly the degraded mode where operators are most likely to inspect dumps.
**Suggested fix**: Give the memory fallback the same hashed key the Redis path uses (or hash the token in `tokenKey`) so both stores count the same opaque key.

### 🟡 `APP_ORIGIN` silently defaults to localhost in production, `backend/src/infrastructure/config.ts:32`

**Problem**: `APP_ORIGIN` is `z.string().url().default('http://localhost:3000')`, so a production deploy that forgets to set it still starts and builds every invite link (email and copy-link) pointing at `http://localhost:3000/invite/...`. Only `RESEND_API_KEY`/`EMAIL_FROM` have a production gate.
**Why it matters**: AC-4 and the deployment notes call `APP_ORIGIN` required in production. With the default, the failure mode is not a loud startup error but every delivered link being useless while the API reports success.
**Suggested fix**: Mirror the email production gate for `APP_ORIGIN` — require an explicit non-localhost value when `NODE_ENV=production`, keeping the localhost default for development and test.

### 🟡 Signed-in passwordless account can accept without setting a password, `backend/src/application/services/team.service.ts:383`

**Problem**: When `callerUserId` is present the code path never requires `request.password`, even if the signed-in account still has no `passwordHash`. The anonymous passwordless path does require a password, and the spec table shows `{ password, name? }` for that account type.
**Why it matters**: An account that accepts while passwordless ends up with an active membership but still no password. It can use the fresh tokens, but once the refresh token expires (7 days) password login is impossible and there is no later invite to set one.
**Suggested fix**: Require a password for any accept where the resolved user has no `passwordHash`, whether the caller is anonymous or signed in.

### 🟡 Concurrent duplicate registration answers 500 instead of 409, `backend/src/application/services/auth.service.ts:21`

**Problem**: `register` checks `findUserByEmail` then creates the user with no catch for the new `users_email_lower_unq` unique violation. Two simultaneous registrations for the same address in different cases both pass the check; the loser hits the index and bubbles as `sendInternalError` 500.
**Why it matters**: Case-insensitive identity makes this collision more likely than before the change, and the client cannot distinguish “email taken” from “server error” for the most common registration conflict.
**Suggested fix**: Catch the lower-email unique violation in `register` (and symmetrically in `oauthLogin` if it can create) and map it to the existing `DuplicateEmailError` 409.

## Nits

- ⚪ `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:401`, `settleEmail` guards on token hash + accepted/revoked only, so a late job finishing after a timeout marked `FAILED` can still flip the row to `SENT` — add an `emailStatus = QUEUED` guard.
- ⚪ `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:157`, the 429 `RATE_LIMITED` handler runs before the controller and never sets `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag`, which the successful create/resend/preview/accept responses do set.
- ⚪ `frontend/src/app/settings/team/page.tsx:99`, the one-time link panel (`sent`) is not cleared when an invitation is cancelled via the confirm dialog, so a now-dead link stays on screen until Done.
- ⚪ `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:198`, `ownerKey` falls back to `anonymous`, but `requireAuth` already 401s before the write limiter runs, so the fallback is dead.

## Strengths

- **Concurrency is taken seriously and proven with real database races.** The accept lock re-verifies the token hash inside the lock so a resent link is instantly invalid, and role change/removal take the business-row lock so two last-owner demotions cannot both pass. The invite-create path now re-checks membership after insert and revokes the fresh row, closing the accept-during-invite race from the previous review.
- **Token, email, and tenant hygiene are consistently right.** Only the SHA-256 hash is stored, the raw token appears only in create/resend responses and the worker payload, HTML email escapes names, `requireBusinessRole` and token building both filter to `ACTIVE` memberships only, and every team write audit row shares its change transaction.

## Test coverage

Very strong for `TESTS = configured`. Service tests (716 lines) pin the invite/resend/cancel/preview/accept state machines, expired-invite replacement, queue-unavailable and skipped outcomes, and the AC-8/AC-9 sign-in branches; repository integration tests run last-owner and accept-vs-cancel/resend races against real Postgres; route tests pin the 401/403 owner-only matrix and refresh-cookie on accept; Redis limiter tests cover shared counters, decrement edge cases, and fail-open; worker tests cover every stale/skip/expired/permanent branch; frontend page tests cover both pages’ states and `BUSINESS_ACCESS_DENIED` session clear, with Playwright e2e driving invite → accept → dashboard through the real stack. The fixes noted above have no dedicated tests yet: no concurrent registration-duplicate test, no missing-`APP_ORIGIN`-in-production startup test, and no test that a passwordless signed-in accept is refused without a password.
