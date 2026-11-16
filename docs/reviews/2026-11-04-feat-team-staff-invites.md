# Review, team-staff-invites, 2026-11-04

**Reviewed by**: grok-4.7 (author on <author-model>)  
**Scope**: 78 files, branch vs base  
**Verdict**: Approve

## Summary

The feature implements full team and staff invite management with a dedicated `invitations` table, BullMQ worker for Resend delivery, hashed single-use tokens, immediate membership checks, role changes, removal (with `removed_at`), and a public accept flow. Backend services, repositories, queues, controllers, contracts, and frontend pages (team listing, invite preview/accept) are complete and follow the tracer-bullet approach. All AC-1–AC-24 are addressed, including rate limits, audit logging, case-insensitive email handling, and business-timezone dates. The previous review is addressed. No blockers or majors; the implementation is solid.

## Strengths

- Clean separation of domain/application/infrastructure/presentation layers with DTOs and named exports only.
- BullMQ worker is correctly configured as its own process with graceful shutdown and production startup validation.
- Accept flow uses `FOR UPDATE` and handles existing `REMOVED` rows reactively.
- Team list filters properly for owners vs staff and shows pending/expired states correctly.
- Rate limiting fails open and uses appropriate per-owner/IP limits.

## Nits

Two candidate nits were checked against the code after the review and withdrawn, because neither holds:

- `inviteUrl` is the only identifier in use across the service, worker, contracts, tests, and frontend. There is no `inviteLink` identifier, and the UI phrase "Invite link copied" is prose. `team.controller.ts:142` is `domainStatus`, not an invite response.
- Each invitation already renders under `<RecordCard key={invitation.id}>` on mobile and under keyed table rows. The Resend button inside `InviteActions` does not need its own React key, and `page.tsx:289` is `sentLabel`.

No verified nits remain.

## Test coverage

All new logic (invite create/resend/cancel, role/promote/demote, remove, accept for new/existing/no-password accounts, stale-job skipping, queue failure, expired-while-queued, last-owner race, migration audit reference, case-insensitive email) is covered by unit, integration, and Playwright tests. No untested new logic. The previous review at `docs/reviews/2026-11-03-feat-team-staff-invites.md` is now fixed and verified to hold.
