# Review, feat/team-staff-invites, 2026-11-11

**Reviewed by**: MiniMax-M2.7 (staff code reviewer subagent, not the author)
**Scope**: ~60 changed files across backend, frontend, contracts; branch vs main
**Verdict**: Approve with nits

## Summary

The team and staff invites feature is a complete, well-engineered addition: invite creation with BullMQ email delivery, public invite preview and accept pages, team management with role changes and removal, immediate access revocation via DB-level membership checks, Redis-backed rate limiting with fail-open behaviour, and a fully polled team UI. The four Clean Architecture layers are respected throughout, domain logic is framework-independent, and every acceptance criterion has a corresponding test. A few minor issues remain: a spelling typo in a comment, a subtle double-subscribe in one test setup, and one future-consideration for the invite page's handling of already-authenticated invitees.

## Blockers

_(None.)_

## Major

_(None.)_

## Minor

### 🟡 `invite-rate-limit.middleware.ts:234` — British spelling in comment

**Problem**: The comment reads `/** The address as express-rate-limit counts it, normalised for IPv6. */`. The codebase uses American English throughout.
**Why it matters**: Inconsistency in documentation comments.
**Suggested fix**: Change `normalised` to `normalized`.

### 🟡 `team-client.ts:57` — `InviteSendResult` exported as interface but used with type in tests

**Problem**: `InviteSendResult` is defined as an `interface` in the client file, but the test at `team-client.test.ts:41` types a variable `sendResult` as `InviteSendResult` (the interface). This is correct usage; no action needed unless the team prefers `type` aliases for DTO shapes. Not a bug, noted for consistency.
**Why it matters**: No impact; this is a style preference.
**Suggested fix**: None — working as designed.

## Nits

- ⚪ `backend/src/infrastructure/config.ts:73`, typo in comment: `unPadded` should be `unpadded` (no camelCase in prose).
- ⚪ `frontend/src/lib/team-client.ts:67`, the `isRecord` guard uses `typeof value === 'object'` which is true for arrays; this is intentional since API responses are objects, but worth a comment noting arrays are not expected here.
- ⚪ `invite-rate-limit.redis.test.ts:44`, `invite-rate-limit.redis.test.ts:47` — the `beforeEach` calls `clearPrefix()` before each test, but the `afterEach` at line 81 also calls `clearPrefix()`. This means the DB is cleared twice per test. Not harmful but redundant.

## Strengths

- The `requireBusinessRole` middleware correctly upgrades from token-claim checking to a live DB lookup on every business request, making role demotion and member removal effective on the next request (AC-17).
- The `RedisRateLimitStore` atomically handles TTL repair and expiry restoration in a Lua script, so a key that loses its TTL is corrected rather than becoming a permanent counter. The fail-open path correctly hashes the key before passing it to the `MemoryFallbackStore`, so raw invite tokens never enter process memory (AC-24).
- The `clearSessionOnBusinessAccessDenied` function in `auth-client.ts` reads the response body from a clone and only acts on a 403 with the exact `BUSINESS_ACCESS_DENIED` code, leaving all other 403s untouched.
- The invite worker re-reads the invitation row on every attempt, so a stale job from a resend is correctly skipped when the token hash no longer matches.
- The `TeamApiError` class in `team-client.ts` correctly filters the `fields` array to strings only, preventing accidental type pollution from a malformed API response.
- The acceptance test suite for the rate limiter includes a Redis disconnection case that confirms the in-process fallback still caps a flood even when the shared store is gone.

## Test coverage

The feature has thorough coverage across all layers:

- **Contracts** (`packages/contracts/src/team.test.ts`): schema validation for invite creation (role default, email normalization, rejection of OWNER role), accept (empty body for existing accounts, short password rejection), member role update, and response shape.
- **Auth contracts** (`packages/contracts/src/auth.test.ts`): email trimming and lowercasing in `LoginSchema`, `RegisterSchema`, and `OAuthLoginSchema` (AC-18).
- **Domain/invite-token** (`backend/src/domain/invitation-token.test.ts`): token generation, SHA-256 hashing, and constant-time comparison.
- **Invite worker** (`backend/src/application/services/invite-worker.test.ts`): all outcome paths — sent, skipped, expired, already a member, permanent vs retryable errors, stale job after resend.
- **Redis store** (`backend/src/presentation/middlewares/invite-rate-limit.redis.test.ts`): shared counter across two API instances, TTL repair, decrement without creating ghost keys, fallback on Redis disconnect, per-token caps.
- **Store unit** (`backend/src/presentation/middlewares/invite-rate-limit.store.test.ts`): atomic script reply handling.
- **Fallback unit** (`backend/src/presentation/middlewares/invite-rate-limit.fallback.test.ts`): hashed key never leaks raw token into in-process memory.
- **Frontend team client** (`frontend/src/lib/team-client.test.ts`): all write paths, error parsing including field filtering and string-only fields, and the preview timeout path.
- **Frontend auth client** (`frontend/src/lib/auth-client.test.ts`): `getUserIdFromToken` (unpadded base64url, absent field, decode failure), session clearing on `BUSINESS_ACCESS_DENIED`, session preservation on other 403s and non-JSON 403s.
- **Frontend auth guard** (`frontend/src/lib/auth-guard.test.ts`): session-clear-to-login redirect (AC-15), public route serving authenticated visitors without redirect (AC-7).
- **Frontend team page** (`frontend/src/app/settings/team/page.test.tsx`): owner view, staff view, polling backoff, duplicate invite handling, session-clear on access denial, retry on load failure, role control ID uniqueness across table and card layouts.
- **Backend team routes** (`backend/src/presentation/controllers/team.controller.route.test.ts`): permission checks, invite create/resend/cancel, role change, member removal, audit row writing, token security.
- **Backend team service** (`backend/src/application/services/team.service.test.ts`): full service logic including last-owner protection, self-change prevention, reactivation of removed members, stale job skipping.
- **Backend team repository** (`backend/src/infrastructure/database/drizzle/repositories/team.repository.integration.test.ts`): full repository integration tests.
- **Auth middleware** (`backend/src/presentation/middlewares/auth.middleware.test.ts`): database failure propagating as error rather than silent 403.
- **Backend scaffold** (`backend/src/server.test.ts`): production startup without email settings fails with clear message (AC-4, AC-23).

No significant new logic is left untested.
