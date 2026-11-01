# Rationale: Team and staff invites

## Context

The product already has users, businesses, memberships, refresh tokens, and audit logs. Spec 0003 requires an owner to invite staff, and the current `POST /api/auth/invite` route creates an `INVITED` business member. That stub has no email delivery, no accept flow, and no team screen. `INVITED` never becomes `ACTIVE`, and the access token builder includes every membership, including `INVITED`. An invited account could therefore pass a business role check without ever accepting.

The scope requires a complete loop: an owner invites a staff member by email, the invitee accepts through a link and sets a password, the membership becomes `ACTIVE`, the invited person signs in with the permissions of their role, and the owner can view, change, and remove members from a team screen. An invite that is never accepted must grant no access.

The stack is a Next.js app, an Express API, PostgreSQL with Drizzle ORM, JWT access and refresh tokens, and Redis in `docker-compose.yml`. Redis is configured but unused. There is no email provider and no background worker. The deployment must stay host agnostic: the browser calls the frontend origin only, the Next.js server proxies `/api/*` to `API_ORIGIN`, and the refresh cookie is host only and `SameSite=Strict`.

The team is small and the product is pre-launch. Boring, operable choices matter more than scale. The feature needs durable invite state, a safe way to deliver a link, immediate revocation, and a small amount of UI. It does not need a separate service, a workflow engine, or a design system rewrite.

## Options considered

### Invite storage

**Option 1: A dedicated `invitations` table.**

Each invite is its own row with a hashed token, expiry, delivery state, and acceptance timestamps. No user account and no membership exist until acceptance.

**Pros**:

- No placeholder accounts and no registration conflict.
- One live invite per business and email is enforced by a partial unique index.
- Expired, revoked, and accepted states are explicit timestamps.
- The team list reads one table and the audit trail stays readable.

**Cons**:

- A new table and more joins.
- The migration must clean up the old `INVITED` rows.

**Option 2: Keep `INVITED` memberships and add token columns to `business_members`.**

The membership row carries the token hash, expiry, and delivery state until acceptance.

**Pros**:

- Fewer tables and a smaller migration.
- The existing membership row is the single source of truth.

**Cons**:

- It still needs a placeholder user or a nullable user id.
- A user can have only one membership per business, so the row mixes membership and invite state.
- Expired, revoked, and accepted invites are hard to represent without status drift.
- The partial unique rule on live invites is awkward.

**Option 3: Store invites in Redis only.**

The token is a Redis key with a time to live.

**Pros**:

- Very little database work.
- Expiry is automatic.

**Cons**:

- A Redis flush or restart loses every pending invite.
- No team list, no audit, and no durable delivery state.
- The database is the right place for a business record.

### Removal semantics

**Option 1: Keep the membership row with status `REMOVED`.**

Removal sets `removed_at` and leaves the row in place.

**Pros**:

- The audit trail keeps a real row to point at.
- A later invite can reactivate the same row.
- No data is lost.

**Cons**:

- Every membership query must filter status.
- The table grows with former members.

**Option 2: Hard delete the membership row.**

Removal deletes the row.

**Pros**:

- Simpler queries and less data.
- No status filter to forget.

**Cons**:

- Audit rows point at a missing entity.
- A re-invite creates a new row with no history.
- Accidental deletion is harder to recover.

The engineer chose Option 1.

### Email delivery

**Option 1: A BullMQ worker using the existing Redis.**

The API writes the invite and enqueues a job. A separate worker sends the email, retries, and writes the delivery state.

**Pros**:

- The API request stays fast and does not depend on the provider.
- Retries and backoff are built in.
- Delivery state is durable in Postgres.
- The project gets its first background worker for future jobs.

**Cons**:

- A new process to deploy, monitor, and restart.
- Redis becomes a runtime dependency for invite email.
- More moving parts than a direct send.

**Option 2: Send synchronously in the API request.**

The invite route calls Resend before responding.

**Pros**:

- No worker and no queue.
- The response can report the provider result immediately.

**Cons**:

- A slow or failing provider blocks the request.
- No retries.
- A provider outage turns into a failed invite even though the invite row is valid.
- It establishes the wrong pattern for later background work.

**Option 3: Fire and forget from the API.**

The route starts the send and does not wait.

**Pros**:

- The request is fast.
- Less infrastructure than a worker.

**Cons**:

- A crash loses the send.
- No retry and no reliable delivery state.
- Hard to observe.

The engineer chose Option 1.

### Email provider and template

**Provider: Resend.**

Resend has a small official Node SDK, a simple HTTP API, good transactional deliverability, a usable free tier, and an installed skill. Postmark and SES are credible alternatives, but SES needs more setup and Postmark adds another account. SMTP is host dependent and SendGrid has no installed skill. The environment variables keep the host swappable.

**Template: a typed HTML function plus plain text.**

One accessible email does not justify a React Email render pipeline or a hosted template editor. The template lives in the repo, is easy to review, and includes the business name, inviter, role, accept link, expiry, and an ignore note.

**Development: skip sending and show the copy link.**

Without `RESEND_API_KEY`, the invite is still created and the worker marks it `SKIPPED`. Mailpit would add another local service. Failing would block local work. Production requires the key and the sender at startup, so the bypass never reaches production.

### Access control

**Option 1: Check the membership row on every business request.**

`requireBusinessRole` reads the current membership from the database, not just the token.

**Pros**:

- Removal and role changes take effect on the next request.
- A stale token cannot keep access.
- The database is the source of truth.

**Cons**:

- One indexed query per authenticated business request.
- A database failure now blocks business requests.

**Option 2: Trust the JWT claims until the access token expires.**

The token carries the membership and role for 15 minutes.

**Pros**:

- No extra query.
- The token is self contained.

**Cons**:

- Removal can take up to 15 minutes.
- A role change can be stale.
- Revocation requires a token blacklist or a short expiry.

The engineer chose Option 1.

**Team screen access: staff read only, owners manage.**

Staff seeing the team helps collaboration. All writes stay with owners. The alternative, hiding the team from staff, adds no safety and makes the page feel secretive.

**Self change and last owner protection.**

Nobody can demote or remove themselves, and the last active owner cannot be demoted or removed. This prevents the most common lockout mistake. The cost is that an owner who wants to leave must ask another owner to remove them after a handover.

### Team screen and design

**Location: `/settings/team`.**

A separate page keeps the settings page manageable and places team management where the rest of the business settings live. A section inside `/settings` would crowd an already long page. A top level `/team` would sit outside the settings area.

**Design source: the existing `frontend/design.md` and the current settings page.**

Reusing the primitives, tokens, spacing, and patterns avoids visual drift and keeps the WCAG AA baseline. A new design would add review work without improving the invite flow.

**Mobile: stacked cards.**

Members and invites become cards with the same actions. A scrollable table is hard to use on a phone. A compact menu hides actions behind extra taps.

### Identity

**Case insensitive email with a unique `lower(email)` index.**

Email is the invite identity. Exact case matching can miss an existing `jane@x.com` account when the owner types `Jane@x.com`, and it can create two accounts that look the same. Normalizing at the auth boundary and enforcing a unique index is the durable fix. The migration must check for duplicates first.

## Rationale

The dedicated invitations table is the only option that keeps the invite, the user account, and the membership separate until acceptance. It removes the placeholder user problem, makes the live invite rule a database constraint, and gives the team list a clean source. Keeping `INVITED` memberships would preserve the current security gap and force the invite state into a row that already means something else.

The BullMQ worker is justified because the engineer chose background delivery and because the project already has Redis in its local stack. The worker isolates provider latency and failures from the API, gives retries and backoff, and leaves a durable delivery state in Postgres. The cost is real: a third process, a Redis runtime dependency, and more operational surface. The copy link and the `FAILED` state keep the owner working when the worker or the provider is down.

The immediate database check is the only way to meet the removal requirement without a token blacklist. One indexed query per business request is a fair price for access that stops on the next call. Filtering tokens to `ACTIVE` memberships removes the current `INVITED` escalation path and keeps the token small. The frontend clears the active business on `BUSINESS_ACCESS_DENIED`, so a removed member is not left in a broken screen.

The team screen at `/settings/team` with the existing design system keeps the feature inside the product the team already knows. Staff read only gives the team visibility without giving away control. The last owner and self change guards are deliberately strict. They are cheaper than recovering a locked out business.

The accepted tradeoffs are:

- The worker job carries a raw token in Redis while the job is active. The job is removed on success and on final failure, the token is never logged, and the database stores only the hash. A stale job after a resend is skipped because the hash no longer matches.
- There is no bounce or complaint webhook in this slice. A delivered invite that bounces is not marked failed. This is a follow-up.
- The team screen polls while an invite is queued. The poll stops when every row is terminal and clears on unmount.
- The invitations table is retained for audit, so it grows over time. A retention job is a follow-up.
- The `lower(email)` unique index can fail on existing duplicates. The migration checks first and the rollback keeps a backup.

The feature deliberately does not add seat limits, a plan model, a team history view, or a leave business flow. Those belong to later slices and would broaden the decision beyond the scope.

## Evidence

The existing system was read before this decision. The relevant files are:

- `backend/src/application/services/auth.service.ts`: `inviteStaff` creates a placeholder user and an `INVITED` membership. `createTokensForUser` includes every membership.
- `backend/src/presentation/controllers/auth.controller.ts`: `POST /api/auth/invite` is owner only and returns a success message with no link.
- `backend/src/presentation/middlewares/auth.middleware.ts`: `requireBusinessRole` checks the JWT claims only.
- `backend/src/infrastructure/database/drizzle/schema.ts`: `business_members` has role and status but no `removed_at`; `users.email` has no case insensitive unique index.
- `backend/src/infrastructure/database/drizzle/repositories/auth.repository.ts`: `findUserBusinesses` returns every status.
- `docker-compose.yml`: Postgres and Redis are already defined.
- `.github/workflows/ci.yml`: starts Postgres only and does not start a worker.
- `frontend/src/app/settings/page.tsx`: the settings page already uses the shared primitives.
- `frontend/src/components/shell/shell.tsx`: the secondary navigation currently holds only Settings.
- `packages/contracts/src/auth.ts`: `InviteStaffSchema` currently accepts a role, which the new flow fixes to `STAFF`.
