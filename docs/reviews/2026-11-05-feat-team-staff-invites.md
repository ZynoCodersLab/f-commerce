# Review, feat/team-staff-invites, 2026-11-05

**Reviewed by**: GLM-5.3-Flash Free (fresh reviewer, fifth pass; four prior passes recorded in docs/reviews)
**Scope**: ~40 files inspected in depth of the 79-file branch diff plus 24 untracked files, branch vs main (merge base `350a5d7`)
**Verdict**: Changes requested

_Suites re-run in this session, independently: contracts **124 passed**; frontend **317 passed (30 files)**; backend **522 passed / 1 skipped (33 files)** — with one unexplained failure in the first backend run that could not be reproduced (*details under Test coverage*). `eslint` clean, `tsc --noEmit` clean. `prettier --check` fails on two files, one of them on this branch._

## Summary

The branch implements the whole spec-0009 invite loop and it is genuinely close: every finding from the four prior passes is verifiably closed in the current tree, including the three minors the fourth pass left open (the `config.test.ts` mirror now imports the real `envSchema`; the `countOwners` regression test now seeds a removed owner so it can actually fail; the team screen poll backs off to 30 s after a minute of 5 s polls). The codebase quality is high. What remains is one real production gate that the schema silently defeats — the "EMAIL_FROM required in production" startup check is dead code because the env schema substitutes a development default before the guard ever runs, and the passing unit test masks this by calling the function directly instead of through the schema. Fix that, run Prettier on the touched test, and the branch is merge-ready.

## Major

### 🟠 The "EMAIL_FROM is required in production" startup gate never fires, `backend/src/infrastructure/config.ts:36-38` and `:70-71`

**Problem**: The schema declares `EMAIL_FROM` as `z.preprocess(v => v === '' ? undefined : v, z.string()).default('F Commerce <onboarding@resend.dev>')`. Zod applies `.default()` when the value is absent **before** the guard sees it, so in a production environment with `EMAIL_FROM` unset, `config.EMAIL_FROM` is the non-empty development default and `productionEmailProblems` (`config.ts:70-71`) never produces a problem. Verified empirically: `safeParse(undefined)` yields `'F Commerce <onboarding@resend.dev>'`. The same default is applied even when `NODE_ENV=production`. As a second edge, an operator who explicitly sets `EMAIL_FROM=''"` crashes _every_ environment (dev included) with a confusing zod `invalid_type` on the email field rather than the intended "required in production" message.

**Why it matters**: The spec is explicit (AC-4, AC-23, configuration table, and `docs/specs/0009-team-staff-invites/verify.md:34`: "Start the API with `NODE_ENV=production` … no `EMAIL_FROM`. … confirm it exits with a clear message"), and `deployment.md:21` lists `EMAIL_FROM` as _required in production_. A production deployment that forgets the variable starts cleanly, then every invitation to a real teammate is rejected by Resend (the `onboarding@resend.dev` sandbox sender can only deliver to the account owner), each recorded as `FAILED / PROVIDER_REJECTED`. The guarantee the spec demanded — fail fast at startup, in both the API and the worker — is unreachable, while `RESEND_API_KEY` alone still enforces its half of the gate. The unit test hides the gap: `config.test.ts:189` calls `productionEmailProblems` directly with `EMAIL_FROM: ''` instead of exercising the schema-plus-guard path the process actually runs.

**Suggested fix**: Make the production requirement expressible at the schema level. Either drop the unconditional default and give the variable a real missing-in-production error inside `envSchema` (dev fills it from `.env.example`), or keep the default but have `productionEmailProblems` receive an "explicitly provided" flag (e.g. re-check `process.env.EMAIL_FROM !== undefined && trim() !== ''`) instead of the defaulted `config` value. Then add one test that parses the schema in a `NODE_ENV=production`-shaped environment without `EMAIL_FROM` and asserts the startup problem — the path `worker.ts:19` and `config.ts:76` really execute. Also decide what `EMAIL_FROM=''` should mean; today it is a crash with a zod internals message.

## Minor

### 🟡 A failed cancel/remove confirmation closes the dialog and shows no error, `frontend/src/app/settings/team/page.tsx:288-297`

**Problem**: `runConfirm`'s catch sets `setConfirmError('That did not work. Try again.')` and then immediately `setConfirm(null)`. The dialog (`open={confirm !== null}`, line 613) closes at that instant, and `FormMessage` at line 628 only renders inside the dialog — so `confirmError` is set but never visible anywhere. There is no `setNotice` fallback.

**Why it matters**: A `429 RATE_LIMITED`, a lost `LAST_OWNER` race, or a dropped network makes the destructive action silently do nothing. The user sees the dialog vanish as if it succeeded and the invitation row is still there. Compare: every other failure path on this screen surfaces something (`emailError`, `notice`).

**Suggested fix**: Do not clear `confirm` on failure — keep the dialog open, show `confirmError` in it, and let the user retry or dismiss (the primary buttons already treat `confirmBusy` correctly). Move the `setConfirm(null)` from the catch into the success branch.

### 🟡 The invite page has no password confirmation, though the spec claims one, `frontend/src/app/invite/[token]/page.tsx:312-330`

**Problem**: The spec's value-sourcing table (spec-0009 `index.md`, "Invite page | password confirmation | client only, not stored or sent") includes a client-side confirm-password field for the accept form. The page renders a single password input; there is no confirmation. No AC lists it, so this is a spec-document/surface mismatch rather than a broken AC.

**Why it matters**: A typo in the one password that creates the account locks the new member out of signing in (they get `Invalid credentials`) and forces the owner into cancel-and-reinvite. The only protection left is the browser's `new-password` manager hint, which not every client honours.

**Suggested fix**: Either add the second field with a match check in the `set-password` mode, or amend the spec's value-sourcing row to say confirmation was dropped — the current state is a silent contradiction.

### 🟡 `format:check` fails on a file changed by this branch, `backend/src/presentation/middlewares/auth.middleware.test.ts` (formatting only)

**Problem**: Root `prettier --check` reports code-style issues in this test file (and in the old review doc `docs/reviews/2026-11-04-feat-team-staff-invites.md`). Project rules require format before every commit; the gate is currently red.

**Why it matters**: Every future change to the file re-touches formatting, and CI or a local gate will keep tripping on a file that predates this review.

**Suggested fix**: `npx prettier --write backend/src/presentation/middlewares/auth.middleware.test.ts docs/reviews/2026-11-04-feat-team-staff-invites.md` (the second is a docs-only stray from a prior review pass, same fix cost).

### 🟡 One backend test failed once and could not be identified or reproduced, backend suite (run 1 of 3)

**Problem**: The first backend run this session ended `1 failed | 521 passed | 1 skipped`, but the failing test scrolled past the captured tail and two subsequent full runs (including the exact same entry point, against the same real Postgres and Redis) passed completely — 522/522 with one skip each. No run-to-run clue survives in the tree, and the second and third runs were captured end to end with no failure.

**Why it matters**: Two clean reproductions after one failure is the same shape as the flake class the prior pass hunted down (the 20k-row EXPLAIN test fixed by `testTimeout: 15000` in `backend/vitest.config.mts`). If another timing-sensitive test exists, it will surface in CI at the worst moment.

**Suggested fix**: Not merge-blocking on the current evidence (2 clean full reruns). Worth noting in the verify step: run the backend suite a few times in a row on a loaded machine, capture full output (`vitest run > log`), and pin the flaky assertion if it shows.

## Nits

- ⚪ `backend/src/infrastructure/database/drizzle/repositories/team.repository.ts:442-448`, `setEmailAttempts` filters only on `invitation.id` while its siblings (`settleEmail`) also pin the `tokenHash` and the live-state predicates. It is worker-only and `id` is the primary key, so nothing leaks today, but a one-line `eq(invitations.tokenHash, …)` would make it impossible to widen a rotated invitation's attempt count.
- ⚪ `backend/src/presentation/controllers/team.controller.ts:144`, `MEMBER_NOT_FOUND` is a bare string while every sibling code goes through `TeamErrorCode.*` (the constant exists, `packages/contracts/src/team.ts:48`).
- ⚪ `frontend/src/app/invite/[token]/page.tsx:227-244`, a signed-in user with a _different_ account sees the `set-password` form for a passwordless invitee; submitting correctly fails with `EMAIL_MISMATCH` and a clear message, but the page could render the `sign-in` neutral state instead of a form it will refuse.
- ⚪ `frontend/src/app/settings/team/page.tsx:755-766`, `readUserId` hand-decodes the JWT payload; unpadded base64 works in `atob` today, but parsing via a tiny helper shared with `auth-client` would keep one decoder in the codebase.
- ⚪ `backend/src/infrastructure/config.ts:36-38`, second edge of the Major: `EMAIL_FROM=''` currently dies as zod `invalid_type` before any human-readable rule runs — fold the empty-string handling into whatever the fix chooses.

## Strengths

- The prior-pass debt is really paid, verified line by line this time: the signed-in-password invariant is coherent in `team.service.ts:372-398` and pinned by tests at both branches; the poll loosened with a comment explaining why (`page.tsx:43-47`); the `config.test` mirror now imports the exported `envSchema`; the `countOwners` test seeds a removed owner in the same business so the assertion can actually fail.
- Race safety remains the standout: `ACCEPT` runs under a `SELECT … FOR UPDATE` on the invitation inside the transaction (`team.repository.ts:631-652`), role changes and removals serialize through a business-row lock with the owner count re-read under the same lock (`:462`, `:561`), the partial unique index is the last word on one live invite, and the integration suite runs the races for real.
- The token story is tight end to end: 32 random bytes hashed with SHA-256 (`invitation-token.ts`), the raw token appears only in the create/resend responses and in the Redis job payload, the audit rows hold no token (asserted by `rotateInvitation` integration test), the email HTML escapes every interpolated string, and the `Referrer-Policy` / `X-Robots-Tag` headers exist in both the API responses and the Next config for `/invite/*`.
- The enqueue path handles its own failure modes thoughtfully — the 2 s timeout keeps the `added` promise observed, removes the late job instead of sending an email already marked `QUEUE_UNAVAILABLE`, and the producer connection is capped so a dead Redis falls through to the fail-open in-process limiter rather than hanging a request.
- CI now starts Redis and the worker and waits for the worker's ready log before the e2e suite (`.github/workflows/ci.yml:32-95`), matching AC-23, and the migration's placeholder-user deletion keeps every user referenced by `audit_logs.user_id` (`drizzle/migrations/0007_tough_dark_phoenix.sql:33-38`).

## Test coverage

Run in this pass: contracts 124 passed; frontend 317 passed (30 files); backend 522 passed / 1 skipped (33 files, real PostgreSQL and Redis), plus one unexplained single failure in backend run 1 (see Minor). Lint and typecheck are clean; `format:check` is red (Minor).

Coverage is multi-level and asserts behaviour, not mocks: the route matrix (`team.controller.route.test.ts`, 581 lines) covers owner-only 403s, malformed `x-business-id` 400s without touching the DB, and the stored-hash-survives-an-attacker-password case; `team.service.test.ts` pins both password branches; `invite-worker.test.ts` covers every defensive skip plus the last-attempt failure recording; `invite-queue.test.ts` drives the enqueue-timeout race; integration tests exercise the unique-index and audit behaviour against Postgres; contracts cover the trimmed/lowercased invite email and accept shapes.

Remaining gaps worth closing alongside the Major: (1) no test runs `productionEmailProblems` through `envSchema` the way `config.ts:76` / `worker.ts:19` do — that is exactly the hole the Major lives in; (2) no frontend test observes the poll's back-off lifecycle (the -d pass already noted this; it stayed a gap); (3) the failed-confirmation UX change from the first Minor will need its own assertion so the dialog-open-on-failure behaviour does not regress.
