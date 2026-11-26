# Review, feat/follow-ups, 2026-11-24

**Reviewed by**: GLM-5.3-Flash (author on Gemini 3.8 Flash, per the 2026-11-21 review)
**Scope**: 55 files, feat/follow-ups vs main (merge base 6c28397), working tree clean
**Verdict**: Changes requested

## Summary

The branch closes every item in the follow ups ledger: team mutations get a shared Redis limit, all six general limiters move onto the shared Redis store, business profile writes record audit rows in the same transaction, onboarding completion becomes terminal, and the shared email schema, job name constant, ESLint delegation, and auth guard comment land as promised. The backend and contract work is solid and well tested. The one real problem is in the newest commit: the theme aware logos ship as giant unoptimized PNGs, which roughly triples the first paint payload of the app shell for light theme users.

## Prior review findings (docs/reviews/2026-11-21-feat-follow-ups.md)

| Prior finding                                                 | Status                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minor: repeated onboarding writes another completion row      | Fixed. `completeOnboarding` locks the row and throws `ConflictError` on a repeat; the route maps it to 409 `ONBOARDING_COMPLETE`; the integration test proves a rejected repeat leaves the profile and the single audit row intact. |
| Minor: duplicate audit constants test in `business.test.ts`   | Fixed. Only the copy inside the describe remains.                                                                                                                                                                                   |
| Minor: fixed wait and exact counters in the shared Redis test | Fixed. The new general limiter suite polls with `expect.poll` for the async login decrement. The exact counter assertions stay, but they sit on increments that finish inside the request.                                          |
| Nit: `requestContext` actor fallback not trimmed              | Fixed. `getActorUserId` trims both sources and rejects blank values, and a test covers a blank context id.                                                                                                                          |
| Nit: fallback comment still said "team limiters"              | Fixed. The comment now covers all Redis backed limiters.                                                                                                                                                                            |
| Nit: integration test asserted alphabetical audit order       | Fixed. Assertions now go through a map by action; one order assertion remains beside it.                                                                                                                                            |
| Nit: ESLint regression test missing `toHaveLength(3)`         | Fixed. Added.                                                                                                                                                                                                                       |

No prior finding regressed.

## Major

### 🟠 Theme logos ship as megabyte PNGs rendered at 80px, `frontend/src/components/shell/shell.tsx:150`

**Problem**: `logo-light.png` is a 1024x1024 RGBA PNG of 1.46 MB and `logo-dark.png` is 424 KB. Both render into slots of 80px (sidebar) and 44px (mobile header) with `unoptimized`, so Next generates no sized variants and the browser downloads the full file. The largest ideal asset at 2x DPI is 160px wide. The light logo alone is almost three times the 538 KB `logo.png` it replaced. Because `next/image` renders lazy loading, the hidden variant is not fetched, so the per visit cost is the visible variant: 1.46 MB on a light theme first paint.

**Why it matters**: The app shell sits on every screen, and the product's market is mobile heavy. A first time visitor on a mobile connection waits several extra seconds for a decorative logo before the dashboard is usable. The regression is branch introduced (commit 59123ac) and the fix is trivial, so it is worth catching before merge.

**Suggested fix**: Re-export both logos sized for the largest rendered slot at 2x (160px square, or 160x240 for the dark portrait variant) in PNG or WebP, or drop `unoptimized` so Next serves properly sized variants. Keep `object-contain`, which already handles the aspect mismatch between the square light logo and the portrait dark logo.

## Minor

### 🟡 First paint shows the dark logo on a light background for system dark users, `frontend/src/app/globals.css:42`

**Problem**: The dark color palette only applies under `:root[data-theme='dark']`, and `data-theme` is set by an effect after hydration (`theme.tsx:56`). The new logo media query, however, applies as soon as CSS loads: with no `data-theme` attribute, `:root:not([data-theme='light'])` matches, so a system dark user sees the dark logo over the light default palette until React hydrates and sets the attribute.

**Why it matters**: On a slow device the hydration window can last seconds, and the mismatch reads as a flash of the wrong brand mark. The old single logo could not mismatch because it was theme neutral.

**Suggested fix**: Set `data-theme` before paint with a small inline script in the document head (reading localStorage and the media query), which is the standard theme flash fix and also removes the light first flash for colors. Alternatively, gate the logo switch on `data-theme` only and accept that the logo follows the toggle rather than the system preference before hydration.

### 🟡 Legacy write paths on the repository interface bypass the new invariants, `backend/src/domain/repositories/business.repository.ts:19`

**Problem**: `updateProfile` still accepts `onboardingComplete` (and now `onboardingDraft: null`) in its data, and with an audit actor a flip of that flag writes no `BUSINESS_ONBOARDING_COMPLETED` row and skips the terminal guard that `completeOnboarding` enforces. Separately, `clearDraft` now has no production caller: the service calls `completeOnboarding`, which clears the draft in the same transaction, so the method survives only on the interface and in tests.

**Why it matters**: No current caller does this, but the interface invites a future caller to complete onboarding or clear drafts around the audit trail and the 409 guard. The repository now owns two ways to do one thing, and only one of them is safe.

**Suggested fix**: Drop `onboardingComplete` from `updateProfile`'s data (the dedicated method owns that transition) and remove `clearDraft` from the interface and implementation, or write the completion audit row when the flag flips in `updateProfile` so both paths stay consistent.

### 🟡 Three dead logo assets remain in public, `frontend/public/logo.png`

**Problem**: After the shell switched to `logo-light.png` and `logo-dark.png`, the old `logo.png` (526 KB), `logo-solid.png` (1.2 MB), and `logo-old.png` (11 KB) have no references anywhere in the app.

**Why it matters**: They ship in every deployment and stay publicly fetchable for no purpose, about 1.7 MB of dead weight. The branch's own hygiene theme removed the scratch test images earlier, so this is the same cleanup left half done.

**Suggested fix**: Delete the three files from `frontend/public`.

## Nits

- ⚪ `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:12`, the re-export of `RedisRateLimitStore`, `closeRateLimitStore`, and `createRateLimitRedisClient` exists only so older test imports keep working. Re-point the three test files and drop the shim.
- ⚪ `backend/src/presentation/middlewares/rate-limit.middleware.test.ts:16` and `backend/src/presentation/middlewares/rate-limit.redis.test.ts:12`, the `GENERAL_PREFIXES` list and the SCAN and delete loop are duplicated across the two suites. A tiny shared test helper would keep the prefixes in one place.
- ⚪ `frontend/eslint.config.test.ts:84`, the first case asserts zero errors on three real source files, so a genuine lint error in those files later fails this test under a misleading "config resolution" name. A synthetic clean snippet would keep the test about the config.

## Strengths

- The terminal onboarding fix is done properly, not patched: the row is locked, the guard throws inside the transaction so nothing partial commits, the route maps it to 409 `ONBOARDING_COMPLETE`, and the integration test proves a rejected repeat leaves the first profile and the single audit row untouched.
- The store extraction kept the Lua scripts and hashing identical and improved the lifecycle: the client is created lazily so imports and `/health` probes open no socket, and `closeRateLimitStore` now falls back to `disconnect()` when `quit()` rejects, so shutdown settles even with Redis unreachable.
- The audit design is easy to trust: entries are computed from locked before and after rows, no-op saves write nothing, and the domain builders are pure functions with a thorough unit suite.
- The rate limit test work is unusually careful: cross instance Redis suites for all limiters, `expect.poll` instead of a fixed sleep for the async decrement, a test proving `/health` writes no Redis key, and register key clearing so runs stay independent of shared Redis state.

## Test coverage

I ran the suites that cover this diff. Contracts: 138 tests pass, including the shared `EmailSchema` boundary cases at 254 and 255 characters and the pinned audit constants. Backend: 97 tests over the audit builders, service, controllers, queue, and store pass; the rate limit suites (23 tests) and outage and fallback suites (3 tests) pass with the local Redis reachable, so the shared store cases actually ran. Frontend: 43 tests over the shell logo switching (including the system scheme listener), team page rate limit and last owner messages, dialog retention, the removal happy path, and the auth guard pass, plus the ESLint config test from both roots (2 tests). Lint, typecheck, and format checks pass across the workspaces.

The PostgreSQL integration suite (`business.repository.integration.test.ts`) could not run in this environment because no PostgreSQL server is reachable here. Its new cases (completion with one audit row, 409 on repeat, per field rows, unchanged fields, no-op saves) are written and were reviewed by reading them, but they were not executed in this pass. Nothing new outside that file lacks coverage; the logo payload and first paint findings are asset and CSS issues that unit tests cannot catch.
