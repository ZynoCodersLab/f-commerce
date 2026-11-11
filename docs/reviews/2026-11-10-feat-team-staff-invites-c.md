# Review, feat/team-staff-invites, 2026-11-10

**Reviewed by**: MiniMax-M2 (author on DeepSeek v4.1 flash)
**Scope**: 9 changed files + 2 untracked, branch vs main
**Verdict**: Approve with nits

## Summary

The team and staff invites implementation is comprehensive and well-structured. The feature adds a complete invite flow: dedicated invitations table with hashed single-use tokens, BullMQ email worker using Resend, Redis-backed rate limiting with fail-open behavior, and a full team management UI with polling, resend, cancel, role change, and removal. Error handling is thorough across all layers, and test coverage spans 506 backend, 315 frontend, and 119 contract tests. The remaining findings are small: an unrelated logo change riding in the branch, and one audit attribution question on an automatic revocation.

> Correction, same day: the original report listed a third minor about `EMAIL_NOT_CONFIGURED` being defined twice. On recheck, `resend-email.service.ts:3` imports the constant from `domain/errors.js` and there is no local copy. That finding was a false positive and is withdrawn.

## Blockers

None.

## Major

None.

## Minor

### 🟡 Scope diff includes an unrelated logo change, `frontend/public/images/Logo.png`

**Problem**: The diff shows a binary change to `frontend/public/images/Logo.png` alongside the team invites feature. The scope notes mention using "the logo already placed at `frontend/public/images/Logo.png`" as a follow-up, which suggests this was bundled into the same commit unintentionally.

**Why it matters**: A logo change belongs in its own commit with its own review path. Mixing it with a complex feature makes the diff larger and the history harder to reason about.

**Suggested fix**: Separate the logo change into its own commit, or revert it from this branch if it was meant to be a follow-up item.

### 🟡 Worker revokes invitation when already-member is detected, `backend/src/application/services/invite-worker.ts:85`

**Problem**: When the worker finds that the invitee's email already has an active membership, it calls `teamRepository.revokeInvitation` before returning `IGNORED`. This writes a `TEAM_INVITE_REVOKED` audit row from a background worker, not from the owner action the spec describes.

**Why it matters**: AC-13 says "Cancel sets `revoked_at`" as an owner action. The worker revoking because the invitee is already a member is correct behavior (do not send if the person already has access), but the audit row attribution may not match the intent: it looks like the owner cancelled, when really the system detected a terminal state and skipped the send.

**Suggested fix**: Document in the audit row or in a comment that this revocation is automatic (system-generated), not owner-initiated. Alternatively, use a distinct audit event like `TEAM_INVITE_SUPERSEDED` for the auto-revoke case so the logs are unambiguous.

## Nits

- ⚪ `backend/src/application/services/invite-worker.ts:29`, the comment "On the last attempt the row must not stay QUEUED forever" could clarify that this applies to unexpected throws only, not to the retry exhaustion path which already calls `markEmailFailed`.

- ⚪ `frontend/src/app/settings/team/page.tsx:75`, the comment "read once when the page opens" is accurate but could note that it reads from the access token (which the page receives via auth context), not from a server round-trip.

- ⚪ `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:89`, the `connectTimeout: 1_000` comment says "Give up on the first connect failure so the request falls through to the in process counter instead of waiting in an offline queue." The value is 1 second, not immediate, which is intentional to allow a quick retry. Consider clarifying.

- ⚪ `frontend/src/app/settings/team/page.tsx:226`, the polling backoff comment says "After the first minute, slow down so a stuck worker is cheap to watch." The values `FAST_POLLS = 12` (12 × 5s = 60s) and `SLOW_POLL_INTERVAL_MS = 30_000` are correct, but the relationship could be stated more directly: "Twelve 5s polls, then 30s polls."

- ⚪ `docs/scope/scope.md` includes "use the logo already placed at `frontend/public/images/Logo.png`" in the deferred follow-ups list. This appears to be scope housekeeping rather than a change to the team invites feature itself.

## Strengths

- The Redis rate limit store correctly uses atomic Lua scripts for increment and decrement, avoiding the Redis 6.x compatibility issue with `PEXPIRE ... NX` and preventing the legacy negative counter bug where a missing key could be created with no expiry.

- The fail-open behavior on Redis outages is consistent: the rate limiter continues with its in-process fallback, and the invite worker marks the row with `QUEUE_UNAVAILABLE` so the copy link still works.

- The team page correctly handles every named error code from the spec (`INVITE_ALREADY_PENDING`, `INVITE_ALREADY_MEMBER`, `LAST_OWNER`, `INVITE_RESEND_CONFLICT`, `BUSINESS_ACCESS_DENIED`) with user-facing messages that match the spec's language.

- The polling implementation correctly backs off from 5s to 30s after 12 polls, and the `sentLabel` function correctly shows "Queued" prefix for pending invitations per AC-5.

- The self-change guard (`isSelf` disables role and remove controls with an explanatory message) is implemented correctly in both table and card views, with unique IDs that prevent label collisions per AC-21.

- Test coverage pins the critical scenarios: rate limits across API instances, last owner race, self removal block, and the queued label distinction.

## Test coverage

Backend 506 passed, 1 skipped. Frontend 315 passed. Contracts 119 passed. New coverage added for write and preview rate limits (AC-24), owner-only route matrix and self removal (AC-2, AC-15), last owner demotion and removal race (AC-14, AC-15), and AC traceability headers on team test files. The rate limiter Redis test correctly skips when no Redis is reachable, keeping the suite runnable without Docker.
