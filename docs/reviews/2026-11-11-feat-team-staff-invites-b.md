# Review, feat/team-staff-invites, 2026-11-11

**Reviewed by**: GLM-5.3-Flash-Free (author model not stated for this pass; prior passes ran on GLM, grok-4.7, Crouton Alpha, MiniMax-M2.7)
**Scope**: 126 files, branch vs main (merge base 350a5d7), including the uncommitted working-tree edits and the untracked files (`invite-rate-limit.store.test.ts`, the three newest review docs, `frontend/public/logo.png`, and the stray `nul` file)
**Verdict**: Approve with nits

## Summary

The team and staff invites feature is a complete, well-engineered slice: hashed single-use tokens, a dedicated invitations table with the right partial unique index, a transactional accept with row locking, an immediate database membership check on every business request, a BullMQ worker with stale-job checks and sanitized failures, a Redis-backed fail-open rate limiter, and a full team/invite UI. Every acceptance criterion AC-1 to AC-24 traces to real code and a test that can fail, including the concurrency scenarios (last-owner races, accept vs cancel/resend, stale jobs). The uncommitted working-tree changes on top of the branch are benign: comment clarifications, the Lua-script increment with new tests, an accessibility improvement replacing a `title` tooltip with visible text, and a logo rename with no dangling references. I found no blockers and no majors; the findings below are real but not urgent.

## Blockers

_None._

## Major

_None._

## Minor

### 🟡 Application layer imports infrastructure types, `backend/src/application/services/invite-worker.ts:6-7`

**Problem**: The application-layer job handler imports `InviteEmailContent` from `infrastructure/services/invite-email.js` and `SendResult` from `infrastructure/services/resend-email.service.js`, and `InviteWorkerDeps.send` is typed against `SendResult`. Both are `import type`, so nothing reaches runtime, but the dependency direction is application → infrastructure — the reverse of the layering rule in the root AGENTS.md ("outer layers depend on inner layers, never the reverse"). Every other application service keeps its ports declared locally (`InviteEmailQueue`, `EmailDeliveryPort`, `InviteTokenIssuer` in `team.service.ts`), which makes this the one inconsistent seam.
**Why it matters**: It is exactly the kind of small leak that grows: the next person needing a field on `SendResult` will import the whole service, and the port stops being a port. The worker is also the piece most likely to be reused or replaced.
**Suggested fix**: Move `InviteEmailContent` and `SendResult` (or a narrowed `InviteSendOutcome`) next to `InviteWorkerDeps` in the application layer, and have the infrastructure sender import them from there, matching how `invite-job.ts` already anchors the job contract in application.

### 🟡 Resend-conflict notice points at a link that is not shown, `frontend/src/app/settings/team/page.tsx:240-242`

**Problem**: When a resend loses the race (`INVITE_RESEND_CONFLICT`), the notice reads "This invitation was just resent from somewhere else. The newest link is below." — but the branch never calls `setSent`, so no link panel is rendered below. The owner reloads the list and sees the invitation, not a link.
**Why it matters**: The message sends the owner looking for something that does not exist, and the 409 conflict means the _caller's_ generated link is dead, so the honest guidance is "reload and resend again."
**Suggested fix**: Change the copy to tell the owner to reload the list and resend the invitation again, or actually refetch and offer the resend action inline.

### 🟡 Two sequential user updates inside the accept transaction, `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:687-695`

**Problem**: For an existing user, the accept transaction issues one UPDATE for the name and, when a password is set, a second UPDATE for `passwordHash` — two round trips and two row versions for what is one change to one row.
**Why it matters**: Not a correctness bug (both are in the same transaction), but the accept path is the feature's most contended transaction; halving its statements is free.
**Suggested fix**: Merge the two into a single `.set({ name, passwordHash, updatedAt })` built from which values are present.

### 🟡 Stray `nul` file at the repository root, `nul`

**Problem**: An empty untracked file named `nul` sits at the repo root (created 2026-11-10). `nul` is a reserved device name on Windows; many Win32 APIs and archive/backup tools cannot open or copy it, and it will break Windows-based checkouts, zips, or container copies of the working tree even though Git tolerates it.
**Why it matters**: It is clearly accidental (zero bytes, nothing references it) and it is a landmine for any Windows tooling or a teammate on Windows running the branch.
**Suggested fix**: Delete it before merge (from WSL/Git Bash: `rm ./nul`, or `del \\?\G:\Bulbul\f-commerce\nul`). Worth finding out which command created it so it does not reappear.

## Nits

- ⚪ `backend/src/presentation/middlewares/invite-rate-limit.fallback.test.ts:12-20`, the failing-Redis stub still models the removed `multi()/exec()` API; the store now calls `eval`, so the test falls into the fallback only because `eval` is `undefined` and throws a TypeError. It still pins the right behavior (hashed key, no raw token), but update the stub to implement `eval` rejecting so it models the current call.
- ⚪ `frontend/src/app/invite/[token]/page.tsx:55-57`, the RATE_LIMITED problem copy says "Wait a minute, then open the link again", but the accept window is 15 minutes; a preview limit is a minute. One neutral sentence ("try again later") covers both.
- ⚪ `backend/src/infrastructure/queue/invite-queue.ts:25`, the jobId truncates the token hash to 12 hex chars; the full 64-char hash costs nothing in Redis and removes the (theoretical) truncation collision from the dedup key. Optional.
- ⚪ `frontend/src/app/settings/team/page.tsx:174`, the polling chain calls `load()` without a cancellation check while the initial load passes one; a poll resolving after unmount only sets state on an unmounted component (harmless in React 18), but the two paths could share the same pattern.

## Strengths

- The accept transaction is genuinely correct under concurrency: the invitation row is locked `FOR UPDATE`, the token hash, revoked, accepted, and expiry states are all re-decided from the locked row, the membership is re-read inside the lock so an active member can never be rewritten to the invited role, and the integration tests actually race accept against cancel and resend (`team.repository.integration.test.ts:693,719`).
- The last-owner invariant is enforced twice with a deliberate design: a cheap pre-check in the service and the authoritative count under a `businesses` row lock in the repository, with integration tests for two owners demoting each other and a removal racing a demotion (`team.repository.integration.test.ts:406,428`).
- Token hygiene holds end to end: the database stores only the SHA-256 hash, the raw token appears only in the create/resend responses and the BullMQ payload, jobs are deleted on settle (`removeOnComplete/removeOnFail`), the rate-limit store hashes every key including per-token keys before it reaches Redis or the in-process fallback, and every response that touches an invite link sets the no-referrer/no-store/noindex headers.
- The worker closes the real races, not just the obvious ones: stale jobs are skipped by hash, a row that is no longer `QUEUED` is never sent (closing the enqueue-timeout race), an invitation that expired while queued becomes `FAILED` with `INVITE_EXPIRED`, and a send for someone who already joined revokes the invitation with an audit trail.
- The `RedisRateLimitStore` increment is a single atomic Lua script with TTL repair, which keeps the shared counter correct on Redis 6.x and after any TTL loss, and it fails open exactly as AC-24 requires while still capping a flood per process.
- The rate-limit unit tests over real Redis assert the cross-instance counter, the TTL repair, and the ghost-key-free decrement — the kind of tests most teams skip.
- The E2E suite (`frontend/e2e/team-invites.spec.ts`) drives the whole loop against the real stack — invite, one-time link, accept on a fresh browser context, cancelled link refusing with 410, duplicate invite rejection with an upper-cased address, and a signed-in accept landing on the invited business.

## Test coverage

Coverage is unusually thorough and, spot-checking the assertions, the tests say what they claim:

- **AC-1/4/5/6/7/8/9/10/11/12/13/14/15/18/20** at the service boundary (`team.service.test.ts`, 29 cases), including the queue-unavailable and skipped-provider paths, the expired-invite replacement, the create-vs-accept race undo, and the resend optimistic-concurrency guard.
- **Repository integration** against real PostgreSQL (`team.repository.integration.test.ts`, 39 cases): tenant isolation ("never returns another business members"), case-insensitive member lookup, the live-invite partial unique index in both letter cases, email settle guarded to `QUEUED`, and all the concurrency races.
- **HTTP contract** (`team.controller.route.test.ts`, 33 cases): owner/staff/anonymous permission matrix on every route, cross-business 404s, refresh cookie on accept, audit rows through the real routes.
- **Worker** (`invite-worker.test.ts`, 14 cases): every outcome including permanent errors ending the job early and the last-attempt generic failure.
- **Auth changes** (`auth.service.test.ts`, `auth.middleware.test.ts`): refresh rebuilds claims through the ACTIVE filter (AC-17 pinned), DB failure in `requireBusinessRole` becomes a 500 not a silent 403.
- **Rate limiting** (`invite-rate-limit.redis.test.ts`, `invite-rate-limit.store.test.ts`, `invite-rate-limit.fallback.test.ts`, `rate-limit-disabled.test.ts`): shared counters, fail-open, production ignoring the disable flag, and hashed fallback keys.
- **Frontend** (`team page`, `invite page`, `team-client`, `auth-client`, `auth-guard` tests): polling backoff, one-time link lifecycle, BUSINESS_ACCESS_DENIED session clearing, password confirmation never posted, and visible self-change explanation.

Two small gaps, neither blocking:

- The 1/2/4-minute retry contract (AC-3) is implemented as BullMQ exponential backoff over `INVITE_JOB_BACKOFF_MS = 60_000` with `attempts: 4` (`invite-queue.ts:12-27`), and the worker tests verify attempt counting — but no test pins the delay math itself. A one-line options assertion on `inviteJobOptions` would lock AC-3's timing so a future "tune the backoff" change cannot silently move it.
- The team E2E covers invite/accept/cancel/duplicate but not role change or removal in a browser; those are covered at the route and repository level, so this is a nice-to-have, not a hole.

## Verdict rationale

No blockers and no majors: the concurrency-critical paths are locked down and pinned by real-database race tests, tenant isolation holds in every repository method, the token never leaks, and the acceptance criteria are all implemented and tested. The four minors are a layering cleanup, one misleading string, one query consolidation, and a stray file — all safe to fix in a short follow-up, though the `nul` file should go before merge.
