# Review, feat/team-staff-invites, 2026-11-15

**Reviewed by**: MiniMax-M2.7 (author on deepseek-v4-1-flash)
**Scope**: 133 files, branch vs main (350a5d7)
**Verdict**: Approve with nits

## Summary

The team-staff-invites feature is complete and correct. The genuinely new material since the 2026-11-12 reviews — the canonical `normaliseEmail` in the domain layer, the Redis rate limit fail-open fix with its regression test, and the command timeout bound on a live-but-silent Redis — all land cleanly. The invite queue job naming is consistent. All 24 acceptance criteria from spec 0009 remain addressed. No blockers or majors.

## Blockers

None.

## Major

None.

## Minor

None (carried from prior reviews — `PATCH`/`DELETE /members/:id` have no rate limiter; the `invite-worker.ts` last-attempt re-throw is redundant).

## Nits

### ⚪ Hardcoded job name in `invite-queue.ts:71`

The string `'send-invitation'` is passed to `active.add()` as the job name. A named constant `INVITE_JOB_NAME = 'send-invitation'` (exported alongside `INVITE_QUEUE_NAME`) would keep the string in one place. Non-blocking — the deduplication logic uses `jobId` (`invite-${invitationId}-${tokenHash}`), so the name is cosmetic only.

### ⚪ `normaliseEmail` in domain vs `TeamEmailSchema` in contracts

The domain exports `normaliseEmail(email: string): string` as a plain function. The contracts package has `TeamEmailSchema` and `EmailSchema` (in `auth.ts`) that use the same `trim().toLowerCase().pipe(z.string().email())` pipeline as schemas. The service normalizes before passing to the repository, so the database always receives a normalized value — this is correct. But `auth.ts` still defines its own `EmailSchema` locally rather than using `TeamEmailSchema` from `team.ts` or a shared utility. Not actionable — the auth schemas are separate from team invites and the duplication is harmless.

### ⚪ `auth-guard.ts:58` redirect logic for signed-in invite page visitors

The guard formula for a public route with `redirectAuthenticated: false` is `shouldRedirect = authed !== null && (requireAuth ? !authed : redirectAuthenticated && authed)`. When `requireAuth: false` and `redirectAuthenticated: false`, this is `authed !== null && false` = always `false`. This is the intended behavior, but a comment noting that `redirectAuthenticated` is intentionally ignored when `requireAuth: false` would make the intent clearer.

## Strengths

- The canonical `normaliseEmail` in `backend/src/domain/email.ts` finally consolidates the duplicate that both prior reviews flagged. The domain export is imported and used consistently across `auth.service.ts`, `team.service.ts`, and `team.repository.ts`.
- The Redis rate limit fail-open is now rigorously defended: `enableOfflineQueue: false` prevents commands from queuing during reconnect, `commandTimeout: 500` bounds a stalled command, and `invite-rate-limit.outage.test.ts` explicitly proves both the unreachable-Redis and the silent-Redis fallback paths settle in under a second.
- The `invite-queue.ts` `active.add()` call uses a deterministic `jobId` (`invite-${invitationId}-${tokenHash}`) so the same invitation can never have two jobs in flight, even if the caller retries.
- The `acceptInvitation` name selection chain (`trimmedRequestedName || storedName || input.name` for existing users; `trimmedRequestedName || input.name` for new users) correctly implements AC-9 priority: body name wins, then stored name, then email local part as last resort.
- The `invite-rate-limit.outage.test.ts` 86-line test covers two scenarios the integration tests cannot: an outright connection refused and a socket that stays open but never replies. The silent socket test bounds the 500ms command timeout precisely (`expect(elapsed).toBeGreaterThanOrEqual(350)` / `expect(elapsed).toBeLessThan(1_500)`).

## Test coverage

The suite covers all new logic. `email.test.ts` tests the domain normalizer with trimmed and canonical addresses. `invite-rate-limit.outage.test.ts` proves the fail-open behavior for both Redis failure modes. The `auth.test.ts` and `team.test.ts` contract tests verify email normalization through the schemas. All previously-identified gaps (the `cancel` service path tested only indirectly, `removeMember` without a dedicated unit test, the `BUSINESS_ACCESS_DENIED` non-JSON 403 path) remain as noted in the prior reviews and are not new findings.
