# Review, feat/team-staff-invites, 2026-11-10

**Reviewed by**: opencode/glm-5.3-flash-free (author on deepseek-v4.1-flash)
**Scope**: 114 files, branch vs main (merge base 350a5d7); committed plus uncommitted tracked changes. ~55 files examined in depth (all team/auth/queue/worker source, both frontend screens, contracts, migrations, config, CI, and the 0009 spec).
**Verdict**: Approve with nits

## Summary

The branch delivers spec 0009 end to end: a dedicated `invitations` table with hashed single-use tokens, owner-only team management protected by transactional last-owner checks, public preview/accept routes with sign-in-required semantics, a BullMQ/Resend worker in its own process with stale-job and idempotency guards, and the team and invite screens. The code is careful where it matters: every team mutation writes its audit row inside the change transaction, token hygiene never puts the raw token beyond the one-time response, both prior review Minors are fixed in this tree (the business-scoped role-change re-read and the duplicated role-select id), and the domain no longer carries the dead `BusinessAccessDeniedError`. Three real-but-small items remain: the 0007 migration was hand-edited and that edit is still uncommitted, the deployment doc describes a refresh-token FK failure mode the schema cannot produce, and the `BUSINESS_ACCESS_DENIED` session clear exists only on the team screen rather than app-wide as AC-15/AC-17 word it.

## Minor

### 🟡 Migration 0007 was hand-edited and the edit is not yet committed, `backend/drizzle/migrations/0007_tough_dark_phoenix.sql:32-38`

**Problem**: Compared with HEAD, the working tree moves `CREATE UNIQUE INDEX "users_email_lower_unq"` from before the placeholders cleanup to after it (and supplies the missing statement breakpoint). That reorder is sensible — placeholder users that duplicate a real account by `lower(email)` would otherwise make the index build fail before the cleanup could remove them — but it contradicts `backend/AGENTS.md` ("`db:generate` derives them; never edit the SQL by hand") and, as of this review, exists only as an uncommitted modification: `git status` shows the file modified against `fb3ca4a`.

**Why it matters**: CI and any teammate's fresh-database migration run apply migrations from the committed tree, so an environment seeded with a placeholder whose email duplicates a real account in different letter case migrates successfully on a checkout with the edit and fails on one without it. Environments can drift from the plan the rollback doc describes, and a future `db:generate` run might silently "restore" committed-file behavior without anyone noticing.

**Suggested fix**: Commit the reorder as its own commit, and record the deliberate manual step (one sentence in the 0007 header comment or under `docs/specs/0009-team-staff-invites/deployment.md`) so later runs of `db:generate` do not silently undo it.

### 🟡 Deployment notes claim a placeholder-referencing `refresh_tokens` row aborts the migration, but the FK cascades, `docs/specs/0009-team-staff-invites/deployment.md:28`

**Problem**: The doc's deploy step 1 says "a placeholder still referenced by another table (for example `refresh_tokens`) makes the migration abort with a foreign key error. That failure is deliberate". In `schema.ts:122-127` (unchanged on this branch) `refresh_tokens.user_id` is declared with `onDelete: 'cascade'`, so the opposite happens: the migration's placeholder `DELETE` (0007 line 32) silently cascades away any refresh-token rows and still deletes the user.

**Why it matters**: This is operator guidance for a destructive, irreplaceable migration step. An operator who trusts the doc prepares for an abort-and-restore that will never fire, while the actual failure mode (rows disappearing silently, matching the backup advice) is invisible. The documented "deliberate failure" check cannot be verified against the code, which undermines the rollback plan's premise.

**Suggested fix**: Rewrite that sentence to match reality: a placeholder referenced only by `refresh_tokens` is deleted along with its orphaned tokens; the abort can only come from a non-cascading reference — check whether any such table actually references `users`, and if none does, drop the abort scenario entirely and keep only the backup instruction.

### 🟡 `BUSINESS_ACCESS_DENIED` clears the session only on the team screen, `frontend/src/app/settings/team/page.tsx:135`

**Problem**: AC-15 (and the spec's security model, mirrored in the server's 403) reads "the frontend clears the active business on `BUSINESS_ACCESS_DENIED`". A grep of `frontend/src` shows that code handled only here and in this page's tests. `orders`, `customers`, `products`, and `dashboard` still let `apiFetch` throw a generic 403 error into their local error states, leaving the member signed in with a business they can no longer open.

**Why it matters**: After an owner removes them, the removed member navigates their usual screens (their access token is valid for up to fifteen minutes) and hits a wall of per-request errors with no explanation and no sign-out. The requirement that makes removal take effect from the user's point of view — session cleared, back to `/login` — only works if the request happens to land on the one screen that knows the code. Not a security hole (the server refuses every request), but user-facing state drift that AC-15 explicitly calls out.

**Suggested fix**: Centralize the clear in the shared fetch layer: when a response body carries `error: 'BUSINESS_ACCESS_DENIED'`, invoke a shared accessor that clears auth and removes the business-settings cache (reuse the team page's `handleAccessLost` logic), or surface it through `useRequireAuth` so every page reacts without individual handlers.

## Nits

- ⚪ `backend/src/infrastructure/queue/invite-queue.ts:51`, a `QueueEvents` instance is constructed and closed but never read; every API process that enqueues one invite pays for an idle Redis connection and a sub socket that serves nothing. Drop it (or add the listener it was for).
- ⚪ `frontend/src/app/settings/team/page.tsx:322`, a `FAILED` invitation's date is still labelled "Queued" per the spec wording, which sits oddly beside the neighbouring "Email failed" badge (carried over from the 2026-11-09 review).
- ⚪ `frontend/src/app/invite/[token]/page.tsx:70`, `formMode` checks `alreadyMember` before `wrong-account`, so a signed-in visitor who is not the invited person sees "already a member" for someone else's invite; secure (the accept would 403), just a misleading message (also carried over).
- ⚪ `nextTask.txt:1`, leftover agent-working notes ("Heads up: the same silent skeleton pattern…") remain in a tracked file; move them to the spec's follow-up list or delete the file.

## Strengths

- **Concurrency correctness is earned at the database layer, and it survived review.** Accept locks the invitation `FOR UPDATE` and re-verifies hash, expiry, revocation, and the `ACTIVE`-membership rewrite inside the lock (team.repository.ts:649-766); role change and removal serialize on a business row lock with the owner count re-counted under it (team.repository.ts:478-605); the rotate is hash-guarded so a lost resend race answers `INVITE_RESEND_CONFLICT` instead of handing out a dead link; and the create path re-checks and revokes when an accept beats it into the partial unique index. Each of these races has a matching test.
- **Token and email hygiene match the security model exactly.** The raw token appears only in the create/resend response, the Redis job payload, and the link; the store keeps only the SHA-256 hash; the team list DTO omits it; the rate-limit store hashes every key (including the bearer-token limiter key) before it reaches Redis or process memory; link responses, 429s, and the invite page all carry the no-referrer/no-store/noindex set; and provider errors are reduced to sanitized codes before storage.
- **Both findings from the previous review are fixed in this tree** — the role-change re-read is now business-filtered (`team.repository.ts:551`) and the table/card role selects got distinct `id`s via `idPrefix` (`page.tsx:669-679`) — plus the dead `BusinessAccessDeniedError` class is gone.

## Test coverage

Comprehensive for `TESTS = configured`: the service suite (39 tests) pins every invite/resend/cancel/preview/accept branch including the accepted-while-creating, user-creation, and password-never-overwritten races; the worker suite covers stale hash, accepted, revoked, expired-while-queued, permanent-vs-transient failures, and the last-attempt cleanup; 35 Drizzle integration tests run the last-owner and dual-accept races against real Postgres; the Redis limiter suite exercises the shared counter, the decrement/NX edge cases, per-token hashing, the fail-open fallback, and the production-disabled flag; route tests pin the 401/403 matrix; and both new pages plus the Playwright invite-to-dashboard flow cover the UI paths. The three Minors above fall outside that net — the migration reorder is asserted nowhere, the deployment doc is prose, and no test loads a non-team screen expecting the session clear — which is consistent with their severity; none of them blocks an otherwise well-tested change.
