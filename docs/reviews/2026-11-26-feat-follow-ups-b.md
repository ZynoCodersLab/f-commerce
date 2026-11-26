# Review, feat/follow-ups, 2026-11-26

**Reviewed by**: MiniMax-M2.7 (author on Gemini 4 Hydrogen)
**Scope**: 62 files, feat/follow-ups vs main (merge base 6c28397), working tree clean
**Verdict**: Approve with nits

## Summary

The branch closes every open item across three prior review passes and adds the team mutation rate limiter coverage, the shared email schema extraction, the theme-aware logo work, the pre-paint theme script, the auth-guard behavioral fix, and the ESLint root delegation fix. All 532 backend unit tests (excluding integration), 138 contracts tests, and lint/typecheck pass. No blocker or major surfaced. One nit from the prior pass was not closed, and one new observation is worth noting.

## Prior review findings (docs/reviews/2026-11-21-feat-follow-ups.md and docs/reviews/2026-11-24-feat-follow-ups.md and docs/reviews/2026-11-24-feat-follow-ups-b.md) — status against HEAD

| Prior finding                                                                     | Status                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Minor (2026-11-21): repeated onboarding writes another completion row             | Fixed — row lock + 409 + integration proof                                                                                |
| Minor (2026-11-21): duplicate audit constants test                                | Fixed — single copy remains                                                                                               |
| Minor (2026-11-21): fixed wait / exact counters in shared Redis test              | Fixed — `expect.poll` used                                                                                                |
| Nit (2026-11-21): `requestContext` actor fallback not trimmed                     | Fixed — `getActorUserId` trims                                                                                            |
| Nit (2026-11-21): fallback comment still said "team limiters"                     | Fixed — comment covers all Redis-backed limiters                                                                          |
| Nit (2026-11-21): integration test asserted alphabetical audit order              | Fixed — map-by-action assertions                                                                                          |
| Nit (2026-11-21): ESLint regression test missing `toHaveLength(3)`                | Fixed — added                                                                                                             |
| Major (2026-11-24): theme logos shipped as megabyte PNGs                          | Fixed — logos at 44 KB / 28 KB                                                                                            |
| Minor (2026-11-24): dark logo on light background before hydration                | Fixed — pre-paint script + `data-theme` CSS                                                                               |
| Minor (2026-11-24): legacy onboarding write paths bypass invariants               | Fixed — `onboardingComplete`/`clearDraft` removed from `updateProfile`                                                    |
| Minor (2026-11-24): three dead logo assets                                        | Fixed — all deleted                                                                                                       |
| Minor (2026-11-24-b): repository still exposes un-audited write path              | Fixed — `audit` is required on `IBusinessRepository.updateProfile` and the Drizzle implementation has no unaudited branch |
| Minor (2026-11-24-b): theme re-applied after paint in client effect               | Fixed — `useIsomorphicLayoutEffect` used                                                                                  |
| Minor (2026-11-24-b): theme script tests miss stored-light and storage-fail paths | Fixed — both cases added (lines 43–50 and 52–61 of `theme-script.test.ts`)                                                |

No prior finding regressed.

## Minor

### 🟡 `invite-rate-limit.middleware.ts` still re-exports three symbols from `redis-rate-limit-store.ts` as a compatibility shim, `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:5-12`

**Problem**: The re-export of `RedisRateLimitStore`, `closeRateLimitStore`, and `createRateLimitRedisClient` was preserved from the older test setup. The three test files (`invite-rate-limit.redis.test.ts`, `invite-rate-limit.store.test.ts`, and `team.controller.rate-limit.test.ts`) now import directly from `redis-rate-limit-store.ts` per the 2026-11-24-b nit, but the re-export itself remains.

**Why it matters**: Dead export shim that carries no runtime purpose; it misleads future readers about the API boundary.

**Suggested fix**: Delete the re-export at lines 5–10 and confirm the three test files import from the correct module.

## Nits

- ⚪ `frontend/src/components/shell/shell.tsx:294`, `pl-13` is a non-standard Tailwind arbitrary value (`padding-left: 3.25rem`). The linter accepts it, so it is not an error, but it stands out against the rest of the spacing scale.

## Strengths

- The business audit design is trustworthy: entries computed from locked before/after rows, no-op saves write nothing, pure domain builders with a thorough unit suite, and transactional integration coverage.
- The terminal onboarding fix is airtight: row lock, `ConflictError` inside the transaction, 409 `ONBOARDING_COMPLETE` mapping, and integration proof that a repeat leaves the first profile and the single audit row untouched.
- The shared `EmailSchema` cleanly removes auth/team duplication and centralizes the 254-character bound, trim, and lowercase in one place with `TeamEmailSchema = EmailSchema` as the alias.
- The Redis rate limit store is production-grade: Lua scripts for atomic increment-with-TTL and decrement-that-never-creates-a-negative, fail-open fallback to in-process counter, `enableOfflineQueue: false` so a disconnected Redis never holds a request open, and a 500 ms command timeout.
- The pre-paint theme script handles all three paths (stored preference wins, system preference fallback, light default) and catches `localStorage` failure gracefully.
- The `teamMutationRateLimiter` runs after `requireBusinessRole(OWNER_ONLY)` so the 30-per-15-min quota is only consumed by owners who are actually eligible to manage members.
- The `MemoryFallbackStore.sweep` guard (`size < 1000` skips the loop) prevents expensive iteration on every increment in a healthy deployment.

## Test coverage

New logic is covered: business audit builders (unit), onboarding completion and profile diffs (unit + integration), Redis rate limit store increment/decrement/reset paths (unit + Redis integration), `teamMutationRateLimiter` on `DELETE /invitations/:id`, `PATCH /members/:id`, and `DELETE /members/:id` (route + Redis integration), pre-paint theme script (5 cases: stored-dark, stored-light, system-dark, system-light with stored preference, storage-fail fallback), shell logo switching (4 cases: light in light mode, dark in dark mode, toggle, system scheme change), `useRequireAuth` with `redirectAuthenticated: false` on a protected route, and the shared `EmailSchema` boundary at 254 and 255 characters. All 532 backend unit tests, 138 contracts tests, and 2 ESLint config integration tests pass. Frontend tests (excluding Playwright E2E) also pass. Lint and typecheck are clean across all three workspaces.
