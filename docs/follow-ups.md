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

- [ ] **Fix the undefined ESLint rules in the frontend config.** Found 2026-11-19 while re-verifying
      spec 0004: `npx eslint frontend` reports 3 errors, not 0. `react-hooks/set-state-in-effect`
      is undefined in `frontend/src/app/invite/[token]/page.tsx:133` and
      `frontend/src/app/settings/team/page.tsx:153`, and `react-hooks/exhaustive-deps` is undefined in
      `frontend/src/app/onboarding/page.tsx:248`. Nothing resolves those configured rules, so lint
      fails on a fresh checkout. Effort: S. Source:
      `docs/specs/0004-business-profile-onboarding/verify.md:41`.

- [ ] **Repo hygiene.**
  - [x] Delete the tracked root scratch images `test-png.png`, `test-spoof.png`, and `test-valid.png`.
        Removed 2026-11-19.
  - [x] Remove the stale worktree for the already-merged `feat/next-security-upgrade` branch:
        `/home/devziaus/.local/share/opencode/worktree/f5e976/next-upgrade-security`. Removed 2026-11-19
        with `git worktree remove`; the branch itself is kept.
  - [ ] Close the 2026-11-15 review nits (four separate items below). Source:
        `docs/reviews/2026-11-15-feat-team-staff-invites.md`, section "Nits".
  - [ ] Hardcoded `'send-invitation'` job name in `backend/src/infrastructure/queue/invite-queue.ts:71`.
        `active.add()` takes the literal while the queue name is already an exported constant. Add an
        `INVITE_JOB_NAME` constant and use it here. Cosmetic only: deduplication uses `jobId`
        (`invite-${invitationId}-${tokenHash}`).
  - [ ] Duplicate email schema. `auth.ts` defines its own `EmailSchema` with the same pipeline as
        `TeamEmailSchema` in `team.ts`. The review judged it harmless and out of scope for a fix, so
        decide: share one schema, or add a comment documenting the duplication. Don't leave it open.
  - [ ] `frontend/src/lib/auth-guard.ts:61-62` (the `auth-guard.ts` nit). Add a comment that
        `redirectAuthenticated` is intentionally ignored when `requireAuth: false`, so the formula
        does not read like unnoticed dead logic. The review cited `:58`; the formula is at `:61-62`.
  - [ ] Redundant re-throw in `backend/src/application/services/invite-worker.ts`. Confirm against
        the retry path, then drop it if it is unreachable.

- [ ] **Decide STAFF customer-notes visibility.** The spec default is yes but still asks for
      confirmation. Answer it and close the item. Source: `docs/specs/0005-customers/index.md:202`.

## P1: before the next feature if there is time

- [ ] **Add business profile audit rows.** Onboarding, profile updates, logo changes, and timezone
      changes currently write no audit entry. Effort: M. Source:
      `docs/specs/0004-business-profile-onboarding/index.md:191`,
      `docs/specs/0008-business-timezone/index.md:166`.

- [ ] **Use a shared Redis store for the general rate limiters.** The global, login, registration,
      refresh, and upload limiters still use `express-rate-limit`'s in-memory store. Only the invite
      limiters are Redis-backed. Required before running more than one API instance. Effort: S-M.
      Source: `docs/specs/0001-stack-and-architecture.md:143`.

- [ ] **Add CI path filters.** Every pull request currently runs the full backend, Redis, worker,
      Playwright, and build pipeline. Effort: S-M. Source:
      `docs/specs/0001-stack-and-architecture.md:183`.

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
