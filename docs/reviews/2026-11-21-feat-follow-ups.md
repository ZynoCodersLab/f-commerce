# Review, feat/follow-ups, 2026-11-21

**Reviewed by**: DeepSeek V4.1 Flash Free (author on Gemini 3.8 Flash)
**Scope**: 45 files, feat/follow-ups vs main (merge base 6c28397), including 8 uncommitted test edits
**Verdict**: Approve with nits

## Summary

The follow ups branch closes the ledger cleanly. Team mutations now share a Redis backed limit of 30 requests per 15 minutes per owner with an in process fail open fallback and visible 429 feedback. Business profile writes record audit rows in the same transaction as the change, and all six general limiters use the shared Redis store. No blocker or major issue surfaced. The remaining items are small: a repeated onboarding request writes another completion row and can overwrite later profile edits, one contract test is duplicated, and a few test and comment details can be tightened.

## Minor

### 🟡 Repeated onboarding writes another completion row, `backend/src/infrastructure/database/drizzle/repositories/business.repository.ts:143`

**Problem**: `completeOnboarding` does not check `previous.onboardingComplete`. Every call updates the profile fields and inserts a `BUSINESS_ONBOARDING_COMPLETED` row. A double submit, a retry, or a direct call after onboarding finishes writes a second completion record and bumps `updatedAt`.

**Why it matters**: The audit trail then reports more than one completion. A delayed retry can also overwrite a name, address, timezone, or logo the owner saved later from Settings. The draft route already treats completion as terminal with a 409, so this route is the outlier.

**Suggested fix**: Guard the transition. Only insert `BUSINESS_ONBOARDING_COMPLETED` when the flag flips from false to true. For a business that is already complete, either return 409 `ONBOARDING_COMPLETE` or treat the request as a normal profile update and write the profile, timezone, and logo audit rows. Add one repository or route test for the repeated call.

### 🟡 Duplicate audit constants test, `packages/contracts/src/business.test.ts:103` and `packages/contracts/src/business.test.ts:116`

**Problem**: The same `it('exports stable business audit action and entity constants', ...)` block appears inside `describe('business response contract')` and again at top level. Both copies assert the same two objects.

**Why it matters**: The suite reports one extra test and future changes to the constants must update two places. The top level copy also runs outside the contract describe, so it is easy to miss.

**Suggested fix**: Delete the top level copy and keep the one inside the describe.

### 🟡 Fixed wait and exact counters in the shared Redis test, `backend/src/presentation/middlewares/rate-limit.redis.test.ts:139`

**Problem**: The login decrement check sleeps for 25 ms before reading Redis, and several tests assert exact counters such as `5`, `60`, and `100`. A loaded CI runner can deliver the asynchronous decrement after the sleep, and any extra request on the same key changes the count.

**Why it matters**: These tests guard an important production path, so a timing flake can fail a safe pull request or hide a real regression when the test is retried. The exact values are useful, but the fixed sleep is the weak part.

**Suggested fix**: Poll the key until it reaches the expected value with a short deadline, or expose and await the decrement path directly. Keep the exact final counter assertion after the poll.

## Nits

- ⚪ `backend/src/presentation/controllers/business.controller.ts:27`, the token path trims and rejects a blank user id, but the `requestContext` fallback returns the value untrimmed. Match the token check so a whitespace only context id cannot reach the audit insert.
- ⚪ `backend/src/presentation/middlewares/memory-fallback-store.ts:11`, the comment still says “team limiters” even though all six general limiters now use this store.
- ⚪ `backend/src/infrastructure/database/drizzle/repositories/business.repository.integration.test.ts:253`, rows written in one transaction share `createdAt`, so the expected order is alphabetical by action rather than insertion order. Asserting through a map by action would make that explicit.
- ⚪ `frontend/eslint.config.test.ts:13`, the first case only checks that no errors were returned. If a path stops matching, ESLint can return zero results and the test still passes. Add `expect(results).toHaveLength(3)` to keep the regression test honest.

## Strengths

- The audit change is transactional and race safe. `updateProfile` and `completeOnboarding` lock the business row, compute entries from the locked before and after rows, and insert the audit rows in the same transaction. A no op profile save writes nothing.
- The shared `RedisRateLimitStore` is a clean extraction. One multiplexed client serves every limiter, commands are bounded by a 500 ms timeout with offline queuing off, and Redis failure falls back to a local counter without holding the request.
- The team mutation limiter is separate from the invite write quota, runs after the owner role check, and has route, fallback, outage, and cross instance Redis coverage. The UI shows a specific `RATE_LIMITED` message for role changes and confirm dialog actions.
- The `/health` skip happens before the store is touched, and the global limiter test proves the health request leaves no Redis key.
- The ESLint delegation was verified from the repository root against real frontend files, including the bracketed `[token]` route, so the regression test is not vacuous today.
- The shared `EmailSchema` removes the auth and team duplication, and the `INVITE_JOB_NAME` constant closes the last hardcoded job name.

## Test coverage

The new audit behavior has unit coverage in `backend/src/domain/business-audit.test.ts` and repository integration coverage for completion, profile, timezone, and logo rows. The rate limit work has route level tests, an in process fallback test that proves the hashed key is stored, outage tests for a refused and a silent Redis, and shared Redis tests across two app instances. The frontend has tests for the new `RATE_LIMITED` messages and the ESLint root config. The contracts suite covers the shared email schema and the new audit constants.

I ran the contracts `business.test.ts` and `email.test.ts` suites (15 tests), the backend `business-audit.test.ts` suite (7 tests), the backend rate limit middleware and fallback suites (11 tests), the team controller rate limit suite (2 tests), and the frontend ESLint config test (2 tests). All passed. The PostgreSQL integration suites and the cross instance Redis suites were not run in this pass. The repeated onboarding case and the `requestContext` actor fallback have no direct test.
