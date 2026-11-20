# Follow-ups

Loose ends in **shipped** work only. Planned features (payments, inventory, delivery, dashboard,
reports, notifications, search, invoices, OAuth, variant archiving, marketing, platform admin) are
deliberately excluded.

Tick an item when it is done. Add the date and a short note if the change is not obvious from the
diff.

Last reviewed: 2026-11-19.

## P0: before the next feature

- [ ] **Rate-limit team member mutations.** `PATCH /api/team/members/:id` and
      `DELETE /api/team/members/:id` have no limiter. Cancel-invite (`DELETE /api/team/invitations/:id`)
      has none either. Effort: S. Source: `docs/scope/scope.md:347`, `backend/src/presentation/controllers/team.controller.ts:229`.

- [x] **Clean the stale follow-up ledger.** Done 2026-11-19.
  - [x] Tick spec 0005 "Row 9: orders must reject archived customers"; closed by spec 0007 AC-13.
  - [x] Tick spec 0006 "Row 9: archived product/variant and snapshot"; closed by spec 0007 AC-13.
        Note that the per-variant stock check belongs to planned inventory, not this item.
  - [x] Tick spec 0009 "Add the installed skills to root `AGENTS.md`"; all six are present.
        The MCP item is reworded as user configuration, not repo work.
  - [x] Tick spec 0001 "Reconcile workspace commands and paths in `AGENTS.md`"; verified accurate.
  - [x] Rewrite `docs/specs/0005-customers/verify.md:65`; the Atlas/Mongo index note is historical.
  - [x] Rewrite `docs/specs/0004-business-profile-onboarding/verify.md:41`; the lint/typecheck
        `BLOCKED` note is stale.
  - [x] Update `docs/scope/scope.md:78`; startup validation exists, only CI path filters remain.
  - [x] Tick the two unchecked boxes in `docs/specs/0009-team-staff-invites/verify.md` (lines 7 and 35) and record the Windows SIGTERM caveat directly on the line.
  - [x] Remove the "Follow-ups moved from `nextTask.txt`" phrasing in `docs/scope/scope.md:348`;
        `nextTask.txt` no longer exists. Keep the disposable-email item itself.

- [x] **Fix the undefined ESLint rules in the frontend config.** Done 2026-11-20. Running
      `npx eslint frontend` from the repository root loaded the root `eslint.config.mjs` instead of
      `frontend/eslint.config.mjs`, so `react-hooks` rules were missing for `frontend/**`. Root
      `eslint.config.mjs` now delegates `frontend` via `basePath: 'frontend'` with `next.rootDir`
      set, and the redundant manual `eslint-plugin-react-hooks` require in
      `frontend/eslint.config.mjs` was removed (`eslint-config-next/core-web-vitals` already
      registers it). Locked with `frontend/eslint.config.test.ts`. Source:
      `docs/specs/0004-business-profile-onboarding/verify.md:41`.

- [x] **Repo hygiene.** Done 2026-11-21.
  - [x] Delete the tracked root scratch images `test-png.png`, `test-spoof.png`, and `test-valid.png`.
        Removed 2026-11-19.
  - [x] Remove the stale worktree for the already-merged `feat/next-security-upgrade` branch:
        `/home/devziaus/.local/share/opencode/worktree/f5e976/next-upgrade-security`. Removed 2026-11-19
        with `git worktree remove`; the branch itself is kept.
  - [x] Close the 2026-11-15 review nits (four separate items below). Done 2026-11-21. Source:
        `docs/reviews/2026-11-15-feat-team-staff-invites.md`, section "Nits".
  - [x] Hardcoded `'send-invitation'` job name in `backend/src/infrastructure/queue/invite-queue.ts:71`.
        Done 2026-11-21. Exported `INVITE_JOB_NAME = 'send-invitation'` alongside
        `INVITE_QUEUE_NAME`, used it in `active.add()`, and locked it in `invite-queue.test.ts`.
  - [x] Duplicate email schema. Done 2026-11-21. Extracted a shared `EmailSchema` in
        `packages/contracts/src/email.ts` (re-exported from `packages/contracts/src/index.ts`),
        reused it in `auth.ts`, aliased `TeamEmailSchema = EmailSchema` in `team.ts`, and locked
        the shared schema in `packages/contracts/src/email.test.ts`.
  - [x] `frontend/src/lib/auth-guard.ts:61-62` (the `auth-guard.ts` nit). Done 2026-11-21. Added a
        comment above `shouldRedirect` explaining the actual behavior: `redirectAuthenticated` is
        ignored when `requireAuth: true`, and setting both `requireAuth: false` and
        `redirectAuthenticated: false` intentionally collapses `shouldRedirect` to `false` while
        still waiting for client hydration.
  - [x] Redundant re-throw in `backend/src/application/services/invite-worker.ts`. Done 2026-11-21.
        Confirmed against `worker.ts` and BullMQ's `shouldRetryJob` (`attemptsMade + 1 < attempts`):
        the re-throw is reachable and required on earlier attempts to trigger retries, and on the
        final attempt BullMQ does not schedule an extra retry and instead fires `worker.on('failed')`
        so the crash is logged rather than swallowed. Kept the re-throw and documented why.

- [x] **Decide STAFF customer-notes visibility.** Done 2026-11-21. Confirmed: `STAFF` can see and edit
      customer notes, matching the shipped API and UI behavior. Source:
      `docs/specs/0005-customers/index.md:202`.

## P1: before the next feature if there is time

- [x] **Add business profile audit rows.** Done 2026-11-20. Onboarding completion, profile updates,
      logo changes, and timezone changes now write `audit_logs` rows atomically in the same
      PostgreSQL transaction (`BUSINESS_ONBOARDING_COMPLETED`, `BUSINESS_PROFILE_UPDATED`,
      `BUSINESS_LOGO_UPDATED`, `BUSINESS_TIMEZONE_CHANGED`) with before and after JSON snapshots.
      Source: `docs/specs/0004-business-profile-onboarding/index.md:191`,
      `docs/specs/0008-business-timezone/index.md:166`.

- [x] **Use a shared Redis store for the general rate limiters.** Done 2026-11-21. Extracted the
      shared `RedisRateLimitStore` and single multiplexed Redis client into
      `backend/src/presentation/middlewares/redis-rate-limit-store.ts` and wired all six general
      limiters (`global`, `login-ip`, `login-account`, `register`, `refresh`, `upload`) to it with
      in process fail open fallback and `/health` skipping before touching Redis. Source:
      `docs/specs/0001-stack-and-architecture.md:143`.

## P2: production readiness, not feature blockers

- [ ] Configure the host proxy to overwrite `X-Forwarded-For` before per-IP limits are treated as a
      security boundary.
- [ ] Verify the Resend sending domain and set `EMAIL_REPLY_TO` in production.
- [ ] Choose the managed PostgreSQL provider and confirm its TLS mode in `DATABASE_URL`.
- [ ] Apply migrations during production deploys and document the general rollback path.
- [ ] Confirm provider pricing and limits before the first production deploy.
- [ ] Add provider-neutral container definitions only if the chosen host needs them.
- [ ] Block disposable or temporary email domains at registration in production.
- [ ] Add Resend bounce and complaint webhooks so failed deliveries are not left as sent.
- [ ] Add email delivery metrics and alerts for queued, failed, and retried invites.
- [ ] Add a retention or cleanup job for accepted, revoked, and expired invitations.
- [ ] Add a worker health probe if the chosen host requires one.
- [ ] Drop the redundant case-sensitive `users.email` unique constraint; identity is already
      enforced by `users_email_lower_unq`. Bundle it with the next migration.
- [ ] Add a periodic sweep to the in-process rate-limit fallback so expired buckets are reclaimed
      before the map reaches 1,000 keys.

## P3: only when evidence or policy requires it

- [ ] Add a trigram or prefix index if customer or order search measurably slows.
- [ ] Release archived phone numbers or product SKUs only if product policy changes.
- [ ] Serialize order creates per customer if duplicate warnings prove noisy or a parallel race
      shows up in practice.
- [ ] Add a delivery-deadline filter, sort, or reminders only if sellers ask for them.
- [ ] Add a per-order timezone snapshot or a server-side overdue flag only if another client needs
      a historical day boundary.
- [ ] Collapse the duplicate business profile fetch when the business switcher lands.
- [ ] Consider Cloudinary unsigned upload presets if backend upload load matters.
- [ ] Remove the legacy `Unknown customer` rows once the old test data is disposable.
- [ ] Add CI path filters if full-pipeline PR runs become slow or costly (deferred from P1 on
      2026-11-21). Every pull request currently runs the full backend, Redis, worker, Playwright,
      and build pipeline. Effort: S-M. Source: `docs/specs/0001-stack-and-architecture.md:183`.

## Source documents

- `docs/scope/scope.md`
- `docs/specs/0001-stack-and-architecture.md`
- `docs/specs/0004-business-profile-onboarding/index.md`
- `docs/specs/0005-customers/index.md`
- `docs/specs/0006-products-categories-variants/index.md`
- `docs/specs/0007-orders/index.md`
- `docs/specs/0008-business-timezone/index.md`
- `docs/specs/0009-team-staff-invites/index.md`
- `docs/specs/0009-team-staff-invites/deployment.md`
- `docs/reviews/2026-11-15-feat-team-staff-invites.md`
