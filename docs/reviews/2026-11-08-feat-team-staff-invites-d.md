# Review, feat/team-staff-invites, 2026-11-08

**Reviewed by**: Crouton Alpha (author on primary model)
**Scope**: 82 files, branch vs base
**Verdict**: Approve with nits

## Summary

This branch implements spec 0009 end to end: a dedicated `invitations` table with hashed single-use tokens, a BullMQ + Resend worker with 1/2/4-minute retries, team CRUD with last-owner protection, public preview/accept endpoints, per-request membership checks, and matching team/invite UI plus tests. Security hygiene is strong throughout — only hashes persist, the raw link appears once, rate-limit keys are hashed, and email HTML escapes user text. The findings below are real but not urgent: a migration statement-order wart, a small spec deviation on retrying permanent email failures, token issuance outside the accept transaction, and signed-out expiry formatting in the provider default timezone rather than the invited business's timezone.

## Minor

### 🟡 Unique index is created before the cleanup deletes it is meant to precede, `backend/drizzle/migrations/0007_tough_dark_phoenix.sql:31`

**Problem**: The migration creates `users_email_lower_unq` at line 31 and only afterwards deletes legacy `INVITED` memberships (line 32) and `Pending Invite` placeholders (lines 33–38). If the database still holds two case-variant accounts for the same address that the deletes would have removed, the unique index fails first and the cleanup never runs.
**Why it matters**: Case-variant duplicates can only exist from the old case-sensitive code path, so this is a narrow deploy abort rather than a data bug — but it blocks the migration on exactly the databases the cleanup exists to repair. The deployment notes already tell operators to resolve duplicates by hand, so the failure mode is documented and recoverable.
**Suggested fix**: Move the two `DELETE` statements before the `CREATE UNIQUE INDEX` statements, or leave the order and keep the manual-duplicate-check step in the deployment notes as the documented path.

### 🟡 Permanent provider errors skip the specified 1/2/4-minute retries, `backend/src/application/services/invite-worker.ts:23`

**Problem**: `PERMANENT_EMAIL_ERRORS` (`EMAIL_NOT_CONFIGURED`, `PROVIDER_UNAUTHORIZED`) ends the job with `FAILED` on the first attempt instead of retrying three times. AC-3 requires the initial attempt plus three retries at 1, 2, and 4 minutes before marking the row `FAILED`.
**Why it matters**: The outcome (row `FAILED` with a sanitized code) matches the acceptance criterion, but the retry timing does not for these two codes, so the verify step "provider fails on the initial attempt and all three retries, at roughly 1, 2, and 4 minutes" fails for an invalid-key case. Failing fast on a bad key is good engineering, so this reads as a deliberate spec deviation rather than a bug.
**Suggested fix**: Either record the deviation in the spec's Consequences or remove the permanent-error short-circuit so all provider failures take 4 total attempts.

### 🟡 Session tokens are issued outside the accept transaction, `backend/src/application/services/team.service.ts:466`

**Problem**: `acceptInvitation` commits the membership and marks the invitation accepted; `tokenIssuer.issueTokensForUser` then opens a separate write that creates the refresh token. A crash between the two leaves the invitation consumed and the invitee without a session.
**Why it matters**: The user is not permanently stuck — they can sign in with the password they just set — but the accept request errors after committing, and a blind retry answers 409 `INVITE_ALREADY_ACCEPTED` instead of returning a working session.
**Suggested fix**: Move the refresh-token creation into the same transaction (or document the sign-in recovery path), so commit implies the session exists.

### 🟡 Invite-page expiry renders in the signed-out default timezone, `frontend/src/app/invite/[token]/page.tsx:235`

**Problem**: The page formats `preview.expiresAt` with `timezone` from `BusinessSettingsProvider`. For a signed-out visitor the provider returns `DEFAULT_TIME_ZONE` (`Asia/Dhaka`), not the invited business's stored timezone, because `InvitePreviewSchema` carries no timezone (`packages/contracts/src/team.ts:133`).
**Why it matters**: The displayed expiry hour can be wrong by the offset between the business zone and the default zone for a visitor who is not yet a member. This follows the frontend rule (dates always render via `formatDateTime`, nothing before mount), but it does not meet the spec's value-sourcing line that preview dates use the business timezone.
**Suggested fix**: Add an optional `timezone` to the preview contract (validated with `TimezoneSchema`) and format with it when present, falling back to the provider value.

### 🟡 A member race writes create-then-revoke audits for an invisible invitation, `backend/src/application/services/team.service.ts:210`

**Problem**: When an accept commits while a new invitation is being inserted, the service revokes the fresh row and throws 409. The invitation already has a `TEAM_INVITE_CREATED` audit row, so the audit trail gains a created-plus-revoked pair for an invitation that never appeared on the team screen.
**Why it matters**: Audit noise only — the access decision is correct and no link is delivered from that row — but it slightly weakens the "one audit row per visible change" mental model in AC-19.
**Suggested fix**: Accept the noise (it is an honest record of a real insert-then-revoke) or insert the audit rows only for the happy path.

## Nits

- ⚪ `frontend/src/components/shell/shell.tsx:47`, Team reuses the Customers `Users` icon; a distinct icon would help distinguish the two entries.
- ⚪ `backend/.env.example:31`, `EMAIL_FROM` ships with the sandbox default even though production requires an explicit verified sender; consider shipping it blank so the example cannot be mistaken for a production-ready value.
- ⚪ `backend/src/presentation/middlewares/memory-fallback-store.ts:58`, expired buckets are swept only once the map reaches 1,000 entries; fine for a fallback, but a small periodic sweep would bound memory tighter.
- ⚪ `backend/src/application/services/team.service.ts:293`, the service-level `countOwners` pre-check duplicates the repo's locked count including error case; the repo check is the authoritative one, so the service check could be removed or kept as a fast-path hint.

## Strengths

- The accept path is carefully race-safe: the invitation row is locked `FOR UPDATE`, the hash is re-validated, expiry/revoked/accepted are decided inside the lock, and the unique-violation retry for concurrent account creation never overwrites an existing password.
- Last-owner protection is enforced twice and correctly: the service checks, then the role-change/removal transactions lock the business row and recount before writing, so concurrent demotions cannot strand a business.
- Token and delivery hygiene is consistent: SHA-256 hash at rest, link shown once, `no-referrer`/`no-store`/`noindex` on link-carrying responses and the `/invite/*` page, stale-job hash checks, and a 2-second enqueue timeout that degrades to `FAILED` + `QUEUE_UNAVAILABLE` while keeping the copy link usable.

## Test coverage

Coverage is broad and meaningful: 37 service tests cover the team logic including races, name fallback, and case handling; 14 worker tests cover retry, expiry-while-queued, stale-job, and already-member cases; route tests exercise the 401/403 matrix and error codes; Drizzle integration tests run against real Postgres; Redis rate-limit tests cover the store and its fallback; frontend component tests and the Playwright `team-invites.spec.ts` suite cover the pages and the full flow. Gaps are minor: the permanent-error fast-fail (Minor above) has no test documenting the deviation, and no test asserts the signed-out expiry timezone. Neither gaps the core acceptance criteria, and the verify.md checklist maps each AC to a manual or automated check.
