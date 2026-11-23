# Review, feat/follow-ups, 2026-11-24 (follow-ups branch, second pass)

**Reviewed by**: Flint 40B (author on Gemini 4 Hydrogen)
**Scope**: 60 files, feat/follow-ups vs main (merge base 6c28397) plus the uncommitted fixes, working tree
**Verdict**: Approve with nits

## Summary

Second-pass review of the `feat/follow-ups` branch closing the follow-ups ledger. The branch lands team mutation rate limiting, the shared Redis limiter store, business profile audit writes, terminal onboarding completion, the shared email schema, the job-name constant, the auth-guard comment, and the theme-aware logo work. The working tree additionally carries the post-2026-11-24-review fixes: compressed logos (44 KB / 28 KB), the dead logo assets deleted, a pre-paint theme script with tests, theme CSS and layout `data-theme` changes, and removal of the legacy onboarding write paths from the service and repository. All six findings from the prior pass are fixed in the current tree and none regressed; the previously raised logo payload finding is closed by the compression, and the dark-first-paint finding by the pre-paint script. No new blocker or major surfaced in this pass.

## Blockers

(none)

## Major

(none)

## Minor

### 🟡 Repository still exposes an un-audited write path behind an optional audit flag, `backend/src/domain/repositories/business.repository.ts:6` (implementation `backend/src/infrastructure/database/drizzle/repositories/business.repository.ts:37`)

**Problem**: `updateProfile` still accepts an optional `audit` and the Drizzle implementation branches on it, with an un-audited update fallback. The service now requires an actor and always passes one, so the fallback is unreachable from production today, but the optional flag is the same invitation the branch just cleaned up, and any future caller can reintroduce a write that skips the audit trail and the locked before/after diff.
**Why it matters**: The business invariant is that every profile write records an audit row in the same transaction as the change; enforcing that on the port (required `audit`) is stronger than relying on the single current caller.
**Suggested fix**: Make `audit` required on `IBusinessRepository.updateProfile` and delete the un-audited branch, mirroring `completeOnboarding`.

### 🟡 Theme is re-applied after paint in the client effect, `frontend/src/components/theme/theme.tsx:58`

**Problem**: The pre-paint script now sets `data-theme` before first paint (fixed), but `ThemeBoundary` re-applies the attribute in `useEffect`, which runs after paint. Next.js's own guide for this exact pattern prescribes `useLayoutEffect` for restoring the attribute the inline script set, because React's dev Strict Mode remount resets `<html>`/`<head>`/`<body>` to JSX-managed attributes and clears the script-set value.
**Why it matters**: Development-only flash of the wrong theme; production is unaffected because the effect converges on the same value after hydration.
**Suggested fix**: Move the re-apply into `useLayoutEffect`.

### 🟡 Theme script tests miss the stored-light path and the `localStorage` failure fallback, `frontend/src/components/theme/theme-script.test.ts:18`

**Problem**: The new suite covers stored-dark, system-dark, and default-light. The stored-light branch and the script's try/catch fallback (unavailable storage) are not exercised.
**Why it matters**: New logic ships with partial coverage; the fallback is the resilience path.
**Suggested fix**: Add the two cases.

## Nits

- ⚪ `frontend/src/components/shell/shell.tsx:138`, `AppLogo` hides the inactive variant through both the React `hidden` prop and the `app-logo-*` CSS class; one mechanism is enough.
- ⚪ `backend/src/presentation/controllers/business.controller.ts:288`, the `/logo` catch maps every failure, including domain errors, to a `502 Cloudinary upload failed`, which can mask a not-found or audit error.

## Strengths

- The terminal onboarding fix is airtight: row lock, `ConflictError` inside the transaction, 409 `ONBOARDING_COMPLETE` mapping, repeat blocked without touching the first profile or adding a second audit row; integration tests cover completion, repeat, per-field diffs, and no-op saves.
- The theme fix is now complete end to end: compressed logos, dead assets deleted, pre-paint script, `data-theme` CSS, layout default, and the logo switch keyed to the same pre-paint source of truth as the palette.
- The audit design is easy to trust: entries computed from locked before/after rows, no-op saves write nothing, pure domain builders with unit coverage.

## Test coverage

The theme work is covered by the new `theme-script` suite and the extended shell logo suite (including the system-scheme listener). Backend coverage added for the audit actor (401 when absent/blank), the onboarding conflict (409), and the audit row builders plus integration cases. Contracts cover the shared email schema and audit constants.

I judged coverage normally and did not run the full suite; targeted files were read. The PostgreSQL integration suite was read, not run (no reachable database in this environment).

## Prior findings from 2026-11-24 (docs/reviews/2026-11-24-feat-follow-ups.md) — status against current tree

| Prior finding                                        | Status                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 🔴 Theme logos shipped as megabyte PNGs              | Fixed. Logos now 44 KB / 28 KB; old assets deleted; pre-paint script added.                  |
| 🟡 Dark logo on light background before hydration    | Fixed. Pre-paint script + `data-theme` CSS + layout default.                                 |
| 🟡 Legacy onboarding write paths bypass invariants   | Fixed. `onboardingComplete`/`onboardingDraft` and `clearDraft` removed from the write paths. |
| 🟡 Three dead logo assets remained                   | Fixed. Deleted.                                                                              |
| 🟡 Repeated onboarding writes another completion row | Fixed. Row lock + 409 + integration proof.                                                   |
| 🟡 Duplicate audit constants test                    | Fixed. Single copy remains.                                                                  |
| 🟡 Fixed wait / exact counters in shared Redis test  | Fixed. `expect.poll` used.                                                                   |

No prior finding regressed.

## Output

Findings written to `docs/reviews/2026-11-24-feat-follow-ups-b.md`.
