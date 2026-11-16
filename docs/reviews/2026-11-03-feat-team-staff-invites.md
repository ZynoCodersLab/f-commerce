# Review, team-and-staff-invites, 2026-11-03

**Reviewed by**: GLM-5.3-Flash Free (author on a different model, not recorded)
**Scope**: 71 files, branch vs main (merge base `350a5d7`)
**Verdict**: Changes requested

## Summary

This change delivers the full invite slice: an `invitations` table with hashed single-use tokens, a BullMQ worker with Resend, immediate database membership checks on every business request, team management (resend, cancel, promote, demote, remove), public preview/accept routes with rate limiting, two new screens, an extensive test suite (backend 506 + frontend 315 + contracts 119, plus real DB integration races), migration 0007/0008, and CI running Redis and the worker. The quality is genuinely high: token handling is careful, the last-owner races are serialized behind a business row lock and actually tested, and the rate limiter fails open as specified. The headline problems are one real race the locked-row design was meant to close but doesn't (the accept transaction reads the invitation state it needs, then ignores it), and a contract that lets an invite be created directly with the OWNER role despite the spec's "invites always start as STAFF" invariant.

## Major

### 🟠 Accept transaction ignores the locked invitation state — cancel, resend, and expiry races all succeed — `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:619-631`

**Problem**: `acceptInvitation` opens a transaction and does `SELECT ... FOR UPDATE` on the invitation, reading `accepted_at`, `revoked_at`, and `expires_at` into `lockedRow` — and then never consults any of them. Validation (revoked/accepted/expiry) happens only in the service's earlier, non-transactional read (`backend/src/application/services/team.service.ts:339-343`), and the final `UPDATE invitations ... WHERE accepted_at IS NULL` (line 701-704) is the only in-transaction guard; it neither filters on `revoked_at`/`expires_at` nor re-verifies the token hash, and its result is not checked. Three concrete races become live:

1. **Cancel vs accept**: the owner cancels (or the stale-link rotation completes) at the same moment the invitee posts the accept. If the revoke commits between the service check and the `FOR UPDATE` lock, the accept proceeds on a cancelled invitation — AC-13's "the link stops working immediately" fails in that window, which matters for a compromised link being revoked.
2. **Resend vs accept**: an accept arriving with the _old_ token can still complete after a resend commits, because the transaction never compares the row's `token_hash` against the token the caller used. AC-12's "the previous link is invalid" has the same window.
3. **Expired while waiting**: an invitation whose `expires_at` passes while the accept transaction waits on the lock is still accepted.

There is also a related hole the integration test masks: a _second_ accept by the signed-in owner of the invited address after the first commits re-reads `accepted_at`, ignores it, and the reactivation `UPDATE business_members` matches the member created by the first accept, succeeds, and returns 200 with fresh tokens instead of 409. The existing test (`refuses a second accept on the same invitation`, `team.repository.integration.test.ts:539`) exercises the new-account path, where the `users(lower(email))` unique index happens to produce 409; the signed-in re-accept path is unguarded.

**Why it matters**: these are exactly the transitions the spec handed to the row lock ("Accept runs in a transaction, selects the invitation row with SELECT ... FOR UPDATE": `docs/specs/0009-team-staff-invites/index.md`, Accept row). The lock is taken (blocking commits) but the values it protects are discarded, so link invalidation is eventually consistent in the happy path only. Each race window is one request round-trip wide, but a cancel-the-link-now response to a suspected phishing invite is precisely a moment when the old accept lands.

**Suggested fix**: inside the transaction, after `FOR UPDATE`, re-derive from `lockedRow` what the service checked: throw/`no-op` when `accepted_at`, `revoked_at` are set or `expires_at` has passed, and when the row's `token_hash` no longer equals the hash of the token that was accepted (pass the expected hash into `acceptInvitation`); map those to `InviteAlreadyAcceptedError` / `InviteRevokedError` / `InviteExpiredError` / stale. Also inspect the invitation `UPDATE`'s affected-rows count so a silently unsatisfied update cannot be reported as success. Then add integration tests for accept-vs-revoke, accept-vs-resend, and the signed-in second accept.

## Minor

### 🟡 `POST /api/team/invitations` accepts `role: 'OWNER'`, contradicting "invites always start as STAFF" — `packages/contracts/src/team.ts:66-69`, `backend/src/application/services/team.service.ts:178`

**Problem**: `InviteCreateSchema` allows `role: TeamRoleEnum`, and `TeamService.invite` stores `request.role ?? 'STAFF'`. The spec's key invariant is "Invites always start as STAFF. Only an owner can later promote an active staff member to OWNER." (index.md, Key invariants; AC-1 fixes the stored role to `STAFF`). Nothing prevents `{ email, role: 'OWNER' }` from minting an invitation that creates or reactivates an OWNER membership on accept, and no test covers that path.
**Why it matters**: blast radius is limited (the caller already owns the business), so this is not escalation, but it silently bypasses the documented promotion flow — including the `TEAM_ROLE_CHANGED` audit shape and the promote-only UX — and any future forgetting of the rule starts here.
**Suggested fix**: hardcode `role: 'STAFF'` in the service (or restrict the schema value to `['STAFF']`), and add one test that an owner-role invite request stores `STAFF`.

### 🟡 Queued invites lose their queued date on screen — `backend/src/application/services/team.service.ts:92` + `frontend/src/app/settings/team/page.tsx:519-521`

**Problem**: AC-5 requires "the sent date is `sent_at` when the status is `SENT`, otherwise `last_sent_at` labeled Queued". `toInvitationDto` only emits `sentAt` and drops `lastSentAt` entirely (it never reaches the `TeamInvitationRecord` DTO or the contract), so for a `QUEUED`/`FAILED`/`SKIPPED` invitation the screen renders its hard-coded "Not yet" even though the row has a `last_sent_at` from creation or resend.
**Why it matters**: an owner watching "Sending" + "Not yet" cannot tell when the invite was queued — a visible spec miss on a new screen.
**Suggested fix**: add `lastSentAt` to `TeamInvitationSchema`, map it in the DTO, and render `date(lastSentAt)` labelled "Queued" whenever `status !== 'SENT'`.

### 🟡 Resend audit row stores the wrong before/after values — `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:331-339`

**Problem**: in `rotateInvitation`, `previousValue` is built from the _post-update_ `RETURNING` row, so it records the new, currently-live token hash as the "previous" value, and its `expiresAt` is hard-coded `null` (the comment on `updateMemberRole` even warns about exactly this `RETURNING` behavior; `updateMemberRole` handles it correctly with an explicit read-first query). AC-19 requires before-and-after values, and this leaks the live token hash into `audit_logs` (harmless by itself — routes hash their input — but pointless alongside the mislabeled value).
**Why it matters**: the resend audit row does not prove which token preceded which, weakening the audit trail's stated purpose, and `expiresAt: null` misstates the previous expiry.
**Suggested fix**: read the pre-update `token_hash`/`expires_at` first (like `updateMemberRole` does) and use those in `previousValue`.

### 🟡 Registration does not trim or lowercase the email (AC-18) — `packages/contracts/src/auth.ts:3-8`, `backend/src/application/services/auth.service.ts:23-49`

**Problem**: AC-18 says registration, login, invite, and accept all trim and lowercase the email. Invite/accept do (via `TeamEmailSchema` and `normaliseEmail`), and the repository compares case-insensitively for login — but `RegisterSchema` accepts the raw string and `createUser` writes it as typed, so an account can exist with stored emails like `Jane@x.com`.
**Why it matters**: comparisons stay consistent thanks to `users_email_lower_unq` and `lower()` lookups, so real harm is surface inconsistency (team list, `findUserByEmail` output, audit rows show mixed case; the invite-page "Signed in as" match compares against an already-normalised invited email), and the AC as written is only half-implemented.
**Suggested fix**: apply the same trim/lowercase the team path uses to the register (and OAuth) email, plus a normalisation test.

### 🟡 The application layer imports an infrastructure implementation — `backend/src/application/services/team.service.ts:38`

**Problem**: `TeamService` imports `isEmailConfigured` from `infrastructure/services/resend-email.service.js`. Every other collaborator is a port defined in the application layer (`InviteEmailQueue`, `InviteTokenIssuer`); this import points application → infrastructure and also pulls the whole Resend adapter into the service's module graph.
**Why it matters**: this is the root AGENTS.md rule ("outer layers depend inward, never the reverse"); it makes the service untestable without the Resend module's config being evaluated and sets a precedent other services will copy.
**Suggested fix**: expose e.g. `emailDelivery: { configured: boolean }` (or a `isEmailConfigured(): boolean` port, implemented at the controller/worker composition root, as done for the queue).

### 🟡 A worker crash on the final attempt leaves the invitation QUEUED forever — `backend/src/application/services/invite-worker.ts:117-129`

**Problem**: the worker's handler only calls `markEmailFailed` inside `processInviteEmailJob`'s result handling; an unexpected throw there (database blip, a malformed row) on the _last_ attempt propagates to BullMQ, which exhausts attempts and removes the job (`removeOnFail: true`) without ever marking the row. The invitation stays `email_status = 'QUEUED'` indefinitely — the team screen keeps polling every 5 s forever.
**Why it matters**: an ops-visible stuck state with no recovery path; retrying is fine, but silently giving up is not (the provider-failure path carefully sets `FAILED`).
**Suggested fix**: wrap the processor body so any thrown error is translated on the final attempt into `markEmailFailed(..., 'EMAIL_SEND_FAILED')` (or rely on BullMQ's `worker.on('failed')` to settle the row when `job.attemptsMade + 1 >= attempts`).

### 🟡 Enqueue timeout race reports QUEUE_UNAVAILABLE while the job actually lands — `backend/src/infrastructure/queue/invite-queue.ts:73-96`

**Problem**: `Promise.race` against the 2 s timeout returns `false` (the service marks the row `FAILED`/`QUEUE_UNAVAILABLE`) but the raced `add` is not cancelled — it can still commit the job to Redis afterwards. The worker then sends and `markEmailSent` overwrites the FAILED status the owner was told about.
**Why it matters**: recovery is real here (the email does send), so harm is limited, but the status flip from FAILED → SENT after the owner was told it failed is surprising, and the raw token now lives in Redis in a state the response implied had not been persisted.
**Suggested fix**: once the timeout wins, ignore the eventual add (e.g., `Promise.race` plus a flag used by the worker's stale-check on `email_status = 'FAILED'` with `QUEUE_UNAVAILABLE`, or delete the job if it appears).

## Nits

- ⚪ `backend/src/application/services/invite-worker.ts:25,112`, `deps.businessName` and the module-level `businessNameFor` are dead — the processor uses `context.businessName`.
- ⚪ `backend/src/presentation/middlewares/memory-fallback-store.ts:58-60`, `init0()` is a stray method with no call site.
- ⚪ `backend/src/application/services/team.service.ts:309-311`, `invitation.email ? ... : null` is dead branching — `email` is `NOT NULL`.
- ⚪ `backend/src/application/services/invite-worker.ts` mocks aside, `InviteAlreadyPendingError('')` from `team.service.ts:186` surfaces a 409 with no `invitationId` in the concurrent-invite race (the normal path supplies it); the frontend handles it, but the contract shape differs between the two triggers.
- ⚪ `frontend/next.config.ts:126-133`, the `/invite/:path*` block adds `Referrer-Policy: no-referrer` while the global block already sends `strict-origin-when-cross-origin`; both match and the winner depends on Next's header merge order — the backend responses' `no-referrer` covers the actual invite traffic, but a test asserting the page's header against both sources would prevent a silent regression.
- ⚪ `backend/src/application/services/auth.service.ts:123`, `(m.status ?? 'ACTIVE') === 'ACTIVE'` silently defaults a missing status to access-granted; since the repository always returns `status`, the default only invites the classic forgotten-field bug this codebase warns about — either require the field or default to refuse-and-log.
- ⚪ `frontend/src/app/invite/[token]/page.tsx:103-135`, `load` and the inline `useEffect` duplicate the same preview fetch; `load` can drive both.
- ⚪ `frontend/src/app/settings/team/page.tsx:137-162`, same duplicated initial-fetch/`load` pattern as the invite page.

## Strengths

- The last-owner correct-under-concurrency design is exactly right: both role change and removal take the `businesses` row lock first, re-count owners inside the transaction, and there are real concurrent integration tests (`team.repository.integration.test.ts:356,378`).
- Token handling is genuinely careful: raw tokens only appear in the two create/resend responses, the worker validates `token_hash`/accepted/revoked/expiry on every attempt (`settleEmail` even filters stale updates by hash and terminal timestamps), and Resend idempotency keys are derived per token so a lost response cannot send twice.
- The email template escapes business and inviter names into HTML and text variants, and the invite URL/headers story (no-store, no-referrer, noindex) is covered at both the API and the page side.
- The rate limiter is an honest implementation of "shared counters with a fail-open local fallback", including a Redis-outage test that still caps floods in-process.
- Route matrix tests are exhaustive — staff and unauthenticated 403/401 on every management call, removed-member refusal, tenant-isolation tests ("never returns another business members") — including the new owner-only matrix and self-removal cases asked for in this review scope.

## Test coverage

Coverage is strong overall (unit for service/middleware/worker logic, real-Postgres repository integration for locks/races/audit, route-level integration for the full error matrix, contracts, browser tests, and Playwright e2e for the happy path plus cancel/duplicate/signed-in-accept). Gaps worth noting, in priority order:

1. **No test covers accept racing a cancel or a resend** (and the signed-in second accept) — the same blind spot as the top finding; existing concurrency tests cover accept-vs-accept and the owner-count races only.
2. **No test for inviting with `role: 'OWNER'`** (contract accepts it, service stores it) — one assertion that it stays `STAFF` would lock the invariant in.
3. **No test for registration email normalisation**, so the AC-18 half-implementation passes unnoticed.
4. The frontend tests don't assert the queued-invite date on the team screen (AC-5's `last_sent_at` display), so the DTO gap ships.
5. The worker's exception-on-final-attempt behavior (after `attempts` are exhausted) is untested; only the orderly `RETRY`/`FAILED` paths are.
