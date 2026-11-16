# Review, feat/team-staff-invites, 2026-11-09

**Reviewed by**: opencode/crouton-alpha-free (author on deepseek-v4.1-flash)
**Scope**: 102 files, branch vs main (merge base 350a5d7)
**Verdict**: Approve with nits

## Summary

This branch delivers spec 0009 end to end: a dedicated `invitations` table, hashed single-use tokens, owner-only team management with transactional last-owner protection, public preview and accept routes, a BullMQ/Resend worker in its own process, and matching team and invite screens. Concurrency, audit-in-transaction, token-security headers, and fail-open rate limiting are all handled at the right layer and covered by deep tests, including real-Postgres and real-Redis integration. What remains is two small real edges — a tenant-filter gap in the role-change re-read and a duplicate-ID responsive table — plus a few polish nits. Nothing blocks merge.

## Minor

### 🟡 Final member re-read omits the business filter, `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:550`

**Problem**: `updateMemberRole` filters the update by `businessId + membershipId`, but the follow-up select that builds the return DTO is `.where(eq(businessMembers.id, membershipId))` only, with no `businessId` predicate. The service pre-checks `findMemberById(businessId, membershipId)`, so today the missing filter is not reachable as a cross-tenant read, but the repository now contains one query that breaks the backend rule that every repository query filters on `businessId` explicitly.

**Why it matters**: Defense in depth fails — a future caller that skips the service check, or a refactor that reorders the two queries, would return a member row from another business. It also weakens the tenant-isolation audit the project relies on instead of a global query plugin.

**Suggested fix**: Add the `businessId` predicate to the final select so every team-repository query is business-scoped, and keep the update and the re-read consistent.

### 🟡 Role select rendered with a duplicate `id` on desktop and mobile, `frontend/src/app/settings/team/page.tsx:668`

**Problem**: The members list renders both a `DataTable` (`hidden md:block`) and a `RecordCard` grid (`md:hidden`) from the same data, and both invoke `MemberActions`, which renders `<Select id={\`role-${member.id}\`}>`with an associated`<label htmlFor>`. Both copies live in the DOM at once (one `display:none`by breakpoint), so the document contains two elements with the same`id` for every member.

**Why it matters**: Duplicate IDs are invalid HTML and break the label-to-control association for assistive technology; which control the label activates depends on DOM order, not viewport. The change must meet WCAG AA (AC-21), and automated checks for duplicate IDs will fail. The hidden copy is not read by screen readers, so impact is structural, not a visible break — a Minor, not a Blocker.

**Suggested fix**: Give the table and card selects distinct `id`s (for example a `table-` / `card-` prefix) or render only one copy per breakpoint, keeping the `sr-only` label pointed at the visible control.

## Nits

- ⚪ `frontend/src/app/invite/[token]/page.tsx:69`, `formMode` checks `alreadyMember` before `wrong-account`, so a signed-in visitor who is not the invited person sees “already a member” for someone else’s invite; secure (accept would 403), just a misleading message.
- ⚪ `frontend/src/app/settings/team/page.tsx:320`, a `FAILED` invitation’s date is labelled “Queued” per the spec wording, which reads oddly next to the adjacent “Email failed” badge.
- ⚪ `backend/src/domain/errors.ts:288`, `BusinessAccessDeniedError` is defined but never thrown and not mapped in `team.controller.domainStatus`; a future throw would fall through to a 500 instead of the intended 403.
- ⚪ `backend/src/worker.ts:99`, shutdown calls `closeInviteQueue()` in the worker process, which never created the producer `Queue`/`QueueEvents`; harmless no-op, but the comment implies shared cleanup.
- ⚪ `packages/contracts/src/team.ts:88`, `isoDate = z.string()` accepts any string; fine for response-only DTOs, a `z.iso.datetime()` variant would catch backend mapping regressions earlier.

## Strengths

- **Accept and rotation are race-safe at the database layer.** Accept locks the invitation `FOR UPDATE`, rechecks hash, expiry, revocation, and `ACTIVE`-membership rewrite inside the lock, retries a `users_email_lower_unq` collision without overwriting the winner’s password, and uses a hash-guarded rotate with a typed `INVITE_RESEND_CONFLICT` instead of handing out a dead link; last-owner demotion and removal serialize on the business row lock.
- **Token and audit hygiene is exacting.** Raw tokens appear only in the create/resend response, the Redis job payload, and the invite link; the DB stores only the SHA-256 hash, the team list omits it entirely, and every mutation writes its `audit_logs` row in the same transaction as the change.
- **Queue degradation and rate limits fail open sanely.** A 2-second enqueue deadline removes a late-accepted job, `removeOnComplete`/`removeOnFail` keeps the raw token out of Redis after settlement, stale jobs skip on hash/`emailStatus !== QUEUED`, and every limiter hashes its key and falls back to a per-process counter when Redis is down.

## Test coverage

Coverage is unusually thorough for `TESTS = configured`: 37 service tests pin the invite/resend/cancel/preview/accept state machines including all AC-8/AC-9 branches and the accept-vs-invite race; 14 worker tests cover every stale/expired/permanent/retry branch; 22+ Drizzle integration tests run last-owner and accept races against real Postgres; the route suite pins the 401/403 matrix, refresh cookie, and cross-business isolation; Redis limiter tests cover shared counters, decrement edge cases, per-token keys, and fail-open; config tests now import the real schema so a new production gate cannot silently default away; frontend page tests cover both screens’ states and the `BUSINESS_ACCESS_DENIED` session clear, and Playwright drives invite → accept → dashboard plus the signed-in accept path end to end. The two Minors above have no dedicated tests (no tenant-filter assertion on the role-change re-read, no duplicate-ID check), which is consistent with their minor severity.
