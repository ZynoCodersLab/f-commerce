# 0009. Team and staff invites

**Date**: 2026-11-01
**Status**: In Progress

## Summary

Owners invite staff by email from a new team screen. Each invite is a row in a dedicated invitations table with a hashed single use token, delivered by a BullMQ worker through Resend. The invitee opens the link, signs in or sets a password, and becomes an active member of the business. Every business request checks the current membership in the database, so removal takes effect immediately, and the last owner cannot be removed or demoted.

## Requirements

**User stories**:

- As an owner, I want to invite a staff member by email so they can join my business without me sharing a password.
- As an owner, I want to see pending and active members and change or remove them so access stays current.
- As a staff member, I want to see who else is on the team so I know who to contact.
- As an invited person, I want to accept through a link and set my password so I can sign in.
- As an owner, I want removal to take effect immediately and the last owner protected so the business cannot be locked out.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: An owner can open the team screen, enter an email, and create an invitation. The API stores one live invitation for that business and email with role `STAFF`, a hashed single use token, and an expiry seven days after creation, and returns the raw invite link once with email status `QUEUED`.
- **AC-2**: Only an owner can create, resend, cancel, change a role, or remove a member. A staff member receives 403 on those calls and sees the team list without management actions. An unauthenticated caller receives 401.
- **AC-3**: The worker sends the invitation email through Resend with the business name, inviter name, role, accept link, and expiry. A successful send sets email status `SENT` and `sent_at`. A failed send is retried three times after the initial attempt, with delays of 1, 2, and 4 minutes, then sets `FAILED` with a sanitized error code.
- **AC-4**: If the queue is unavailable, the invitation is still created and the response still includes the copy link, with email status `FAILED` and `emailError` set to `QUEUE_UNAVAILABLE`. In development without `RESEND_API_KEY` the invitation is created with email status `SKIPPED`. Production startup fails in both the backend and the worker when `RESEND_API_KEY` or `EMAIL_FROM` is missing.
- **AC-5**: The team screen lists active members with name, email, role, and joined date, and lists pending and expired invitations with email, role, inviter, sent or queued date, expiry, and email status. The sent date is `sent_at` when the status is `SENT`, otherwise `last_sent_at` labeled Queued. Owners sort first, then members by name, and pending invitations newest first. Staff see the same lists read only.
- **AC-6**: A valid invite link opens a public preview with the business name, inviter name, role, invited email, expiry, `accountExists`, `hasPassword`, and `alreadyMember`. An invalid, expired, revoked, or already accepted token shows a clear state and no accept form. An accept for an email that is already an active member returns 409 `INVITE_ALREADY_MEMBER`.
- **AC-7**: A new account accepts with a name and password. The membership becomes `ACTIVE` with role `STAFF`, the response returns an access token and the invited business id, the refresh cookie is set, and the browser opens the dashboard with that business active.
- **AC-8**: An existing account with a password must sign in before accepting. The accept call requires a bearer token whose user id matches the invited email. A missing token returns 401 `SIGN_IN_REQUIRED` and a different signed in user returns 403 `EMAIL_MISMATCH`.
- **AC-9**: An existing account with no password may set one through the invite and then accept. The accept body may include an optional name; the existing `users.name` is used when omitted, then the email local part. The password is hashed with the same rules as registration and the account can sign in with it afterwards.
- **AC-10**: An invitation that is never accepted creates no business membership and grants no access. A legacy `INVITED` membership never authorizes a business request.
- **AC-11**: An invite to an email that is already an active member or already has a live pending invitation returns 409. An expired invitation is revoked before a new invitation is created, so only one live link exists.
- **AC-12**: Resend rotates the token, extends the expiry by seven days, resets the delivery state to `QUEUED`, returns a new copy link once, and makes the previous link invalid. It writes a `TEAM_INVITE_RESENT` audit row.
- **AC-13**: Cancel sets `revoked_at`, hides the invitation from the pending list, and makes the link invalid. It writes a `TEAM_INVITE_REVOKED` audit row.
- **AC-14**: An owner can promote an active staff member to `OWNER` and demote an owner to `STAFF`. The last active owner cannot be demoted, and nobody can demote themselves. The change applies on the next request and writes a `TEAM_ROLE_CHANGED` audit row.
- **AC-15**: An owner can remove a member. The membership becomes `REMOVED` with `removed_at` set, the member loses access on the next business request, and the frontend clears the active business on `BUSINESS_ACCESS_DENIED`. The last active owner and the signed in owner cannot be removed. The action writes a `TEAM_MEMBER_REMOVED` audit row.
- **AC-16**: A removed member can be invited again. Accepting the new invite reactivates the existing membership row to `ACTIVE` with role `STAFF` and clears `removed_at`, or creates a new `ACTIVE` row when none exists.
- **AC-17**: Every authenticated business request checks the current membership status and role in the database. Only `ACTIVE` memberships appear in access tokens, including when the refresh handler rebuilds them. Role changes and removal take effect on the next request without waiting for token expiry.
- **AC-18**: Email identity is case insensitive. Registration, login, invite, and accept trim and lowercase the email, a unique index enforces `lower(email)`, and an invite to `Jane@x.com` finds an existing `jane@x.com` account.
- **AC-19**: Invite create, resend, cancel, accept, role change, and removal write an `audit_logs` row in the same transaction as the change, with the actor, business, entity, and before and after values.
- **AC-20**: Invite tokens are 32 random bytes, stored only as a SHA 256 hash, single use, and valid for seven days. The raw token is never written to the database, never logged, and never returned by the team list. It appears only in the create and resend responses.
- **AC-21**: The team screen and the invite page meet WCAG AA, use the existing design system, show loading, empty, and error states, and stack as cards on small screens. Dialogs trap focus and every status uses text, not color alone.
- **AC-22**: The migration removes legacy `INVITED` memberships and placeholder users named `Pending Invite` that have no password, no OAuth identity, no remaining memberships, and no `audit_logs` reference. A placeholder user referenced by `audit_logs.user_id` is kept. The old `POST /api/auth/invite` route is removed.
- **AC-23**: The worker runs as a separate process. `npm run dev` starts the frontend, backend, and worker. The backend has `start:worker` for hosts that run it separately, the worker validates `RESEND_API_KEY` and `EMAIL_FROM` at startup in production, it shuts down gracefully on `SIGTERM` and `SIGINT`, and CI starts Redis and the worker for the end to end suite.
- **AC-24**: Invite create and resend are limited to 10 per hour per owner, accept attempts to 5 per 15 minutes per IP, and invite previews to 30 per minute per IP. A limited request returns 429 with error `RATE_LIMITED`. The limiter fails open when its store is unavailable, so a store outage does not block an invite create.

## Decision

**Chosen option**: A dedicated invitations table, a BullMQ email worker using Resend, and an immediate database check of membership on every business request.

Store invites in a dedicated table with hashed single use tokens, deliver them through a BullMQ worker using Resend, and authorize every business request against the current membership row.

**Implementation skills**: `resend` (`resend/resend-skills`, `.agents/skills/resend/`) · `email-best-practices` (`resend/email-best-practices`, `.agents/skills/email-best-practices/`) · `redis-connections` (`redis/agent-skills`, `.agents/skills/redis-connections/`) · `redis-observability` (`redis/agent-skills`, `.agents/skills/redis-observability/`) · `redis-core` (`redis/agent-skills`, `.agents/skills/redis-core/`) · `bullmq-specialist` (`sickn33/agentic-awesome-skills`, `.agents/skills/bullmq-specialist/`) · `web-design-guidelines` (`vercel-labs/agent-skills`, `.agents/skills/web-design-guidelines/`)

## Feature design

### Data model

**New table `invitations`**:

| Column                | Type        | Rules                                                                                           |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `id`                  | uuid        | primary key, default random                                                                     |
| `business_id`         | uuid        | not null, references `businesses.id` on delete cascade                                          |
| `email`               | text        | not null, trimmed and lowercased                                                                |
| `role`                | text        | not null, default `STAFF`                                                                       |
| `token_hash`          | text        | not null, unique, SHA 256 hex of 32 random bytes                                                |
| `invited_by_user_id`  | uuid        | not null, references `users.id`                                                                 |
| `accepted_by_user_id` | uuid        | nullable, references `users.id`                                                                 |
| `expires_at`          | timestamptz | not null, seven days after create or resend                                                     |
| `accepted_at`         | timestamptz | nullable                                                                                        |
| `revoked_at`          | timestamptz | nullable                                                                                        |
| `last_sent_at`        | timestamptz | not null, last time the invite was queued                                                       |
| `email_status`        | text        | not null, default `QUEUED`, values `QUEUED`, `SENT`, `FAILED`, `SKIPPED`                        |
| `email_attempts`      | integer     | not null, default 0                                                                             |
| `last_email_error`    | text        | nullable, a short sanitized code such as `PROVIDER_ERROR` or `QUEUE_UNAVAILABLE`, never a token |
| `sent_at`             | timestamptz | nullable, set when the provider accepts the message                                             |
| `created_at`          | timestamptz | not null                                                                                        |
| `updated_at`          | timestamptz | not null                                                                                        |

Indexes:

- Unique `invitations_token_hash_unq` on `token_hash`.
- `invitations_business_email_idx` on `(business_id, email)`.
- Partial unique `invitations_business_email_live_unq` on `(business_id, lower(email))` where `accepted_at` is null and `revoked_at` is null, so only one live invite exists per email.
- `invitations_business_expires_idx` on `(business_id, expires_at)` for the team list.

Invite state is derived from timestamps. Pending means `accepted_at` and `revoked_at` are null and `expires_at` is in the future. Expired means `expires_at` has passed. Accepted and revoked each have their timestamp. Rows are never deleted, so audit stays readable.

**Changed table `business_members`**:

- `status` allows `ACTIVE`, `INVITED` (legacy only), and `REMOVED`.
- New `removed_at` timestamptz nullable.
- New index `business_members_business_status_idx` on `(business_id, status)` for the team list.
- New index `business_members_user_status_idx` on `(user_id, status)` for token building.
- The unique index on `(business_id, user_id)` stays.
- On acceptance, an existing `REMOVED` row for that business and user becomes `ACTIVE` with role `STAFF` and `removed_at` cleared. Otherwise a new `ACTIVE` row is inserted.
- On removal, the row becomes `REMOVED` and `removed_at` is set. The user account stays.

**Changed table `users`**:

- Email identity becomes case insensitive. Registration, login, invite, and accept trim and lowercase the email.
- Add a unique index `users_email_lower_unq` on `lower(email)`.
- Invitations look up accounts with `lower(email)`. Without this, an invite to `Jane@x.com` could miss an existing `jane@x.com` account.

**Existing table `audit_logs`**:

Actions: `TEAM_INVITE_CREATED`, `TEAM_INVITE_RESENT`, `TEAM_INVITE_REVOKED`, `TEAM_INVITE_ACCEPTED`, `TEAM_ROLE_CHANGED`, `TEAM_MEMBER_REMOVED`. Entity type `Invitation` or `BusinessMember`, actor as `user_id`. Rows are written in the same transaction as the change.

**Relationships**:

- `invitations.business_id` many to one `businesses.id`.
- `invitations.invited_by_user_id` many to one `users.id`.
- `invitations.accepted_by_user_id` zero or one to many `users.id`.
- `business_members.business_id` many to one `businesses.id`.
- `business_members.user_id` many to one `users.id`.

### State transitions

**Invitation**:

| From               | Event                                                    | To                                                      |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------- |
| none               | owner creates                                            | pending, email `QUEUED`                                 |
| pending            | worker succeeds                                          | pending, email `SENT`                                   |
| pending            | worker exhausts retries                                  | pending, email `FAILED`                                 |
| pending            | worker finds expiry passed                               | pending, email `FAILED` with `INVITE_EXPIRED`           |
| pending            | worker finds accepted, revoked, or a token hash mismatch | no change, job skipped                                  |
| pending            | no provider in development                               | pending, email `SKIPPED`                                |
| pending            | expiry passes                                            | expired                                                 |
| pending or expired | owner resends                                            | pending, token rotated, expiry extended, email `QUEUED` |
| pending or expired | owner cancels                                            | revoked                                                 |
| pending            | invitee accepts                                          | accepted                                                |

Accepted and revoked invites are terminal and hidden from the team list. Expired invites stay visible with a Resend action.

**Membership**:

| From             | Event                 | To                                               |
| ---------------- | --------------------- | ------------------------------------------------ |
| none             | invite accepted       | `ACTIVE` with role `STAFF`                       |
| `ACTIVE` `STAFF` | owner promotes        | `ACTIVE` `OWNER`                                 |
| `ACTIVE` `OWNER` | owner demotes         | `ACTIVE` `STAFF`                                 |
| `ACTIVE`         | owner removes         | `REMOVED` with `removed_at`                      |
| `REMOVED`        | invite accepted again | `ACTIVE` with role `STAFF`, `removed_at` cleared |
| `INVITED` legacy | migration             | deleted                                          |

### API surface

All team routes require a bearer token and `x-business-id`.

| Endpoint                           | Method | Key inputs                                                                                                                                   | Key outputs                                                                                                  | Auth                                                  | Key errors                        |
| ---------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------- |
| `/api/team`                        | GET    | none                                                                                                                                         | `{ data: { members, invitations } }`                                                                         | owner and staff                                       | 401, 403                          |
| `/api/team/invitations`            | POST   | `{ email }`                                                                                                                                  | 201 `{ data: { invitation, inviteUrl, emailStatus, emailError? } }`                                          | owner                                                 | 400, 409, 429                     |
| `/api/team/invitations/:id/resend` | POST   | none                                                                                                                                         | 200 `{ data: { invitation, inviteUrl, emailStatus, emailError? } }`                                          | owner                                                 | 404, 409, 429                     |
| `/api/team/invitations/:id`        | DELETE | none                                                                                                                                         | 200 `{ success: true }`                                                                                      | owner                                                 | 404, 409                          |
| `/api/team/members/:id`            | PATCH  | `{ role: 'OWNER' or 'STAFF' }`                                                                                                               | 200 `{ data: member }`                                                                                       | owner                                                 | 400, 403, 404, 409                |
| `/api/team/members/:id`            | DELETE | none                                                                                                                                         | 200 `{ success: true }`                                                                                      | owner                                                 | 403, 404, 409                     |
| `/api/invitations/:token`          | GET    | token                                                                                                                                        | `{ data: { businessName, inviterName, email, role, expiresAt, accountExists, hasPassword, alreadyMember } }` | public, rate limited                                  | 404, 410, 429                     |
| `/api/invitations/:token/accept`   | POST   | new account `{ name, password }`; existing account with a password `{}` plus bearer; existing account with no password `{ password, name? }` | `{ accessToken, businessId }` and refresh cookie                                                             | public token, bearer for an existing password account | 400, 401, 403, 404, 409, 410, 429 |

The accept response uses the same shape as login: `{ accessToken, businessId }`, with the refresh token in a host only `httpOnly` cookie. The invited business id overrides any other active business.

`emailError` is present only when `emailStatus` is `FAILED`, and it reads `invitations.last_email_error`.

Accept runs in a transaction, selects the invitation row with `SELECT ... FOR UPDATE`, and updates only when `accepted_at` is null. A unique violation on the membership insert maps to 409 `INVITE_ALREADY_MEMBER`.

Error codes:

- `INVITE_ALREADY_MEMBER`: 409, the email is already an active member.
- `INVITE_ALREADY_PENDING`: 409, a live invite already exists, use Resend.
- `INVITE_NOT_FOUND`: 404, the token or invitation does not exist.
- `INVITE_EXPIRED`: 410, the invite has expired.
- `INVITE_REVOKED`: 410, the invite was cancelled.
- `INVITE_ALREADY_ACCEPTED`: 409, the invite was already used.
- `SIGN_IN_REQUIRED`: 401, an existing password account must sign in first.
- `EMAIL_MISMATCH`: 403, the signed in user is not the invited person.
- `LAST_OWNER`: 409, the last active owner cannot be demoted or removed.
- `SELF_CHANGE_NOT_ALLOWED`: 409, nobody can demote or remove themselves.
- `BUSINESS_ACCESS_DENIED`: 403, the membership is missing, removed, or not active.
- `RATE_LIMITED`: 429, too many requests.

### Value sourcing

| Action                 | Value produced or displayed                 | Source                                                                               |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Create invite          | business id                                 | `x-business-id` header, checked against the current membership                       |
| Create invite          | inviter                                     | `req.user.userId` from the access token                                              |
| Create invite          | email                                       | request body, trimmed and lowercased                                                 |
| Create invite          | role                                        | fixed `STAFF`                                                                        |
| Create invite          | token                                       | 32 random bytes from `randomBytes`                                                   |
| Create invite          | token hash                                  | SHA 256 hex of the token                                                             |
| Create invite          | expiry                                      | current time plus seven days                                                         |
| Create invite          | invite link                                 | `APP_ORIGIN` plus `/invite/<token>`                                                  |
| Create invite          | email status                                | `invitations.email_status`                                                           |
| Create invite          | delivery error                              | `invitations.last_email_error` returned as `emailError`                              |
| Send email             | recipient                                   | `invitations.email`                                                                  |
| Send email             | business name                               | `businesses.name`                                                                    |
| Send email             | inviter name                                | `users.name` of `invitations.invited_by_user_id`                                     |
| Send email             | role                                        | `invitations.role`                                                                   |
| Send email             | accept link                                 | `APP_ORIGIN` plus `/invite/<raw token from the job>`                                 |
| Send email             | expiry                                      | `invitations.expires_at`                                                             |
| Send email             | sender                                      | `EMAIL_FROM`                                                                         |
| Send email             | reply to                                    | `EMAIL_REPLY_TO`, or the inviter email when unset                                    |
| Team list              | active members                              | `business_members` joined to `users` where status is `ACTIVE`                        |
| Team list              | joined date                                 | `business_members.created_at`                                                        |
| Team list              | pending and expired invitations             | `invitations` where `accepted_at` and `revoked_at` are null                          |
| Team list              | inviter name                                | `users.name` of `invitations.invited_by_user_id`                                     |
| Team list              | email status                                | `invitations.email_status`                                                           |
| Team list              | expiry                                      | `invitations.expires_at`                                                             |
| Team list              | sent date                                   | `sent_at` when the status is `SENT`, otherwise `last_sent_at` labeled Queued         |
| Team list              | dates on screen                             | business timezone from `businesses.timezone`                                         |
| Team screen            | poll interval                               | 5 seconds while any invitation is `QUEUED`                                           |
| Preview                | business name, inviter, email, role, expiry | invitation joined to `businesses` and `users`                                        |
| Preview                | account exists, has password                | `users` looked up by `lower(email)`                                                  |
| Preview                | already a member                            | active `business_members` row for the business and user                              |
| Preview                | dates on screen                             | business timezone from `businesses.timezone`                                         |
| Invite page            | password confirmation                       | client only, not stored or sent                                                      |
| Accept                 | invited email                               | `invitations.email`                                                                  |
| Accept                 | name and password                           | request body for a new account                                                       |
| Accept                 | name for an account with no password        | optional request body, then existing `users.name`, then email local part             |
| Accept                 | password hash                               | bcrypt, same rules as registration                                                   |
| Accept                 | user id                                     | existing user by `lower(email)`, or a new user                                       |
| Accept                 | business id                                 | `invitations.business_id`                                                            |
| Accept                 | membership status and role                  | `ACTIVE` and `STAFF`                                                                 |
| Accept                 | invitation lock                             | invitation row selected `FOR UPDATE`                                                 |
| Accept                 | accepted at, accepted by                    | current time and the accepting user id                                               |
| Accept                 | tokens                                      | the existing auth service                                                            |
| Role change            | membership id, business id, role            | path, header, body                                                                   |
| Role change            | actor                                       | `req.user.userId`                                                                    |
| Role change            | last owner count                            | active `business_members` with role `OWNER`                                          |
| Role change and remove | owner count and update                      | one transaction with row locks                                                       |
| Remove                 | membership id, business id                  | path and header                                                                      |
| Remove                 | removed at                                  | current time                                                                         |
| Resend                 | new token, hash, expiry, queued time        | new random token, SHA 256, current time plus seven days, current time                |
| Worker                 | retry policy                                | initial attempt plus three retries, delays of 1, 2, and 4 minutes                    |
| Worker                 | stale job check                             | token hash, email status, accepted state, revoked state, and expiry on every attempt |
| Cancel                 | revoked at                                  | current time                                                                         |
| Audit                  | actor, business, entity, before and after   | current user, header, changed row                                                    |
| Migration              | placeholder deletion                        | skip users referenced by `audit_logs.user_id`                                        |
| Rate limit             | store outage                                | fail open                                                                            |

### Key invariants

- One live invite per business and lowercased email.
- Invite tokens are single use, hashed at rest, and valid for seven days.
- Invites always start as `STAFF`. Only an owner can later promote an active staff member to `OWNER`.
- Only `ACTIVE` memberships appear in access tokens and pass the business role check. The refresh handler rebuilds claims through the same `ACTIVE` filter.
- The last active owner cannot be demoted or removed, and nobody can demote or remove themselves. The owner count and the change run in one transaction with row locks.
- An invitation that is never accepted creates no membership and grants no access.
- Removal keeps the membership row with status `REMOVED` and a `removed_at` timestamp.
- Email status moves only from `QUEUED` to `SENT`, `FAILED`, or `SKIPPED`. Resend resets it to `QUEUED`.
- The initial send plus three retries use delays of 1, 2, and 4 minutes. A queued invite whose expiry passes before a send becomes `FAILED` with `INVITE_EXPIRED`.
- The worker verifies the token hash, email status, accepted state, revoked state, and expiry on every attempt before sending.
- A stale job after a resend is skipped because the token hash no longer matches.
- The accept transaction locks the invitation row and updates only when `accepted_at` is null.
- The Resend idempotency key is `invite:<invitationId>:<tokenHash>`, so a crash after send cannot send twice.
- Audit rows are written in the same transaction as the change.
- Rate limiting fails open when its store is unavailable.
- Email comparison is case insensitive everywhere.
- A placeholder user referenced by `audit_logs.user_id` is not deleted by the migration.

### Security model

- Team read: owners and staff.
- Team writes: owners only. Staff receive 403 and the screen hides management actions.
- Public preview: anyone holding the token, rate limited. It reveals whether an account exists because the token was emailed to that address.
- Accept: anyone holding the token for a new account or an account with no password. An existing account with a password must sign in, and the bearer user id must match the invited email.
- Invite token in the URL: set `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex`. Never log the token.
- Refresh cookie: host only, `httpOnly`, `secure` in production, `SameSite=Strict`.
- Every business request checks the current membership row. A removed or inactive membership returns 403 `BUSINESS_ACCESS_DENIED`. The frontend clears the active business on that code.
- The refresh handler rebuilds claims through the same `ACTIVE` filter, so a removed member cannot mint a token with the old membership.
- Rate limits: invite create and resend 10 per hour per owner, accept 5 per 15 minutes per IP, preview 30 per minute per IP. The limiter fails open when its store is unavailable.
- Audit rows cover invite create, resend, cancel, accept, role change, and removal.
- Worker payload carries the raw token in Redis only while the job is active. It is removed on success and on final failure, and the token is never logged. The worker validates `RESEND_API_KEY` and `EMAIL_FROM` at startup in production.
- Passwords use the existing minimum of 8 characters and bcrypt hashing.
- No seat cap in this slice.

### Configuration required

- `APP_ORIGIN`: public frontend origin, used to build invite links. Required in production, defaults to `http://localhost:3000` in development.
- `RESEND_API_KEY`: Resend API key. Required in production in both the backend and the worker, optional in development and test.
- `EMAIL_FROM`: sender address. Required in production in both processes, defaults to `F Commerce <onboarding@resend.dev>` in development.
- `EMAIL_REPLY_TO`: optional reply to address. Defaults to the inviter email.
- `REDIS_URL`: existing variable, now used by the queue producer and the worker.
- `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGINS`: existing variables, unchanged.

### Critical test scenarios

- Happy path: an owner invites a new email, the row is created, the copy link opens the invite page, the worker marks the email `SENT`, the invitee sets a name and password, the membership becomes `ACTIVE`, and the dashboard opens with the invited business. Verifies **AC-1**, **AC-3**, **AC-7**, **AC-17**.
- Queue failure: Redis is stopped, the invite is still created with `FAILED` and `QUEUE_UNAVAILABLE`, and the copy link works. Verifies **AC-4**.
- Provider failure: a transient provider error fails on the initial attempt and all three retries, at roughly 1, 2, and 4 minutes, the row becomes `FAILED`, and Resend recovers it. A permanent error such as `PROVIDER_UNAUTHORIZED` ends the job on the first attempt by design. Verifies **AC-3**, **AC-12**.
- Expired while queued: an invite expires while its email is still queued. The worker marks the row `FAILED` with `INVITE_EXPIRED`, and the team screen offers Resend. Verifies **AC-3**, **AC-4**.
- Permission: a staff member can read the team list but gets 403 on every write, and an unauthenticated caller gets 401. Verifies **AC-2**, **AC-5**.
- Existing account: sign in as the invited email, accept, and land on the dashboard. A wrong signed in user gets 403, and an account with no password can set one. Verifies **AC-8**, **AC-9**.
- No password name fallback: an existing account with no password accepts without a name. The existing `users.name` is kept; if it is empty, the email local part is used. Verifies **AC-9**.
- Token states: invalid, expired, revoked, and already accepted links show clear states and cannot accept. Verifies **AC-6**, **AC-13**.
- Concurrency: two accept requests race, one succeeds, the other gets 409, and only one membership is created. Verifies **AC-7**, **AC-10**.
- Duplicate and resend: a second invite returns 409, resend returns a new link, and the old link stops working. Verifies **AC-11**, **AC-12**.
- Stale job: resend rotates the token, then the old job runs. It is skipped because the token hash no longer matches, and only the new link is delivered. Verifies **AC-12**, **AC-20**.
- Role change: promote, demote, last owner, and self change. Verifies **AC-14**.
- Last owner race: two concurrent demotions of the last two owners. One succeeds, the other gets 409 `LAST_OWNER`, and one active owner remains. Verifies **AC-14**.
- Removal: the removed member loses access on the next request, the frontend clears the active business, and a new invite reactivates the row. Verifies **AC-15**, **AC-16**, **AC-17**.
- Refresh after removal: a removed member refreshes. The response does not include the removed membership, and a business request gets `BUSINESS_ACCESS_DENIED`. Verifies **AC-17**.
- Email case: invite `Jane@x.com` when `jane@x.com` exists, and the existing account is found. Verifies **AC-18**.
- Audit: every team action writes one audit row with the actor and the before and after values. Verifies **AC-19**.
- Token security: the team list never returns the raw token, the database stores only the hash, and logs contain no token. Verifies **AC-20**.
- Accessibility: keyboard navigation, dialog focus trap, screen reader labels, contrast, and the mobile card layout. Verifies **AC-21**.
- Migration: legacy `INVITED` rows and placeholder users are gone, the `lower(email)` index exists, and the old route returns 404. Verifies **AC-22**.
- Migration audit reference: a placeholder user referenced by `audit_logs.user_id` is not deleted by the migration. Verifies **AC-22**.
- Worker process: `npm run dev` starts all three processes, `start:worker` runs the worker alone, and `SIGTERM` shuts it down cleanly. Verifies **AC-23**.
- Rate limits: the 11th invite in an hour, the 6th accept in 15 minutes, and the 31st preview in a minute return 429. Verifies **AC-24**.
- Rate limiter store down: the rate limit store is unavailable. Invite create still succeeds and the invite is created with the queue failure state if Redis is also down. Verifies **AC-4**, **AC-24**.

## Build plan

The project uses Tracer Bullet. The first slice stands up one thin invite path through the database, API, worker, email, and UI. Later tasks thicken it with role changes, removal, resend, cancel, audit, and hardening.

1. [x] Add the migration for `invitations`, the `business_members` status and `removed_at` changes, the `users` `lower(email)` unique index, and the legacy `INVITED` cleanup. Satisfies **AC-1**, **AC-10**, **AC-16**, **AC-18**, **AC-22**.
2. [x] Add contracts for the team list, invite create, invite preview, accept, role update, and the shared error codes. Satisfies **AC-1**, **AC-5**, **AC-6**, **AC-7**, **AC-8**, **AC-14**.
3. [x] Add the team repository and service: create an invite with a token hash, list members and invitations, preview an invite, accept for a new account, activate the membership, lock the invitation row during accept, count and change owners in one transaction, and write the audit row. Satisfies **AC-1**, **AC-5**, **AC-6**, **AC-7**, **AC-10**, **AC-14**, **AC-15**, **AC-17**, **AC-19**, **AC-20**.
4. [x] Add the database membership check to `requireBusinessRole`, filter token claims to `ACTIVE` memberships, and rebuild refresh tokens through the same filter. Satisfies **AC-2**, **AC-10**, **AC-17**.
5. [x] Add the queue producer, worker entry point, Resend adapter, typed HTML and plain text email template, and the new environment variables. Use four total attempts with delays of 1, 2, and 4 minutes, validate the worker environment at startup, and make the rate limiter fail open. Satisfies **AC-3**, **AC-4**, **AC-23**, **AC-24**.
6. [x] Add the team routes and the public preview and accept routes, including error mapping and rate limits. Satisfies **AC-1**, **AC-2**, **AC-6**, **AC-7**, **AC-8**, **AC-9**, **AC-11**, **AC-24**.
7. [x] Build the team page with the member list, pending invites, invite dialog, copy link panel, poll, and empty states. Satisfies **AC-1**, **AC-5**, **AC-21**.
8. [x] Build the invite page with the preview, new account, existing account, no password, wrong user, and success states. Satisfies **AC-6**, **AC-7**, **AC-8**, **AC-9**, **AC-21**.
9. [x] Add resend, cancel, role change, and removal endpoints and dialogs. Satisfies **AC-12**, **AC-13**, **AC-14**, **AC-15**, **AC-16**, **AC-19**.
10. [x] Harden the flow: token protections, case normalization, audit coverage, removal of the old invite route, fail open rate limits, the migration audit reference guard, and the frontend `BUSINESS_ACCESS_DENIED` handling. Satisfies **AC-2**, **AC-4**, **AC-18**, **AC-19**, **AC-20**, **AC-22**, **AC-24**.
11. [x] Wire the worker into root `npm run dev`, add `start:worker`, update CI with Redis and the worker, and add the deployment notes. Satisfies **AC-23**.
12. [x] Add unit, integration, and browser tests, including the expired while queued, last owner race, refresh after removal, limiter outage, name fallback, migration audit reference, and stale job scenarios, then run lint, typecheck, format, build, and the full suite. Satisfies **AC-1** to **AC-24**.

## Consequences

**Positive**:

- The invite loop is complete: invite, deliver, preview, accept, sign in, and manage.
- No placeholder user accounts and no membership until acceptance.
- Removal and role changes take effect on the next request.
- The copy link keeps the owner working when email fails or the queue is down.
- Every team change is auditable.
- Email identity is consistent regardless of case.
- The worker gives retries and idempotency without slowing the API request.

**Negative / tradeoffs**:

- A new worker process must be deployed, monitored, and restarted.
- Redis becomes a runtime dependency for invite email.
- Production needs a Resend account and a verified sending domain.
- One extra indexed database query runs on every authenticated business request.
- The team screen polls while an invite is queued.
- The invitations table grows and is retained for audit.
- The `lower(email)` unique index can fail if duplicate accounts already exist.
- The worker job carries a raw token in Redis while it is active.
- Bounce and complaint webhooks are not handled in this slice.
- There is no seat cap or plan enforcement.
- Permanent provider errors (a missing sender or an unauthorized key) end the job on the first attempt instead of the full retry schedule, because waiting cannot fix a misconfiguration. The row still becomes `FAILED` with a sanitized code.
- Accept commits the membership before it issues session tokens. A crash in that gap leaves the invitation consumed and the invitee signs in with the password they just set; a blind retry answers 409 `INVITE_ALREADY_ACCEPTED`.

**Neutral**:

- New environment variables: `APP_ORIGIN`, `RESEND_API_KEY`, `EMAIL_FROM`, and optional `EMAIL_REPLY_TO`.
- New frontend routes: `/settings/team` and `/invite/[token]`.
- New contracts and a new worker entry point.
- CI gains Redis and the worker.
- The old `POST /api/auth/invite` route is removed.
- The migration deletes legacy `INVITED` rows and placeholder users.
- A create that loses the race to an accept leaves a `TEAM_INVITE_CREATED` and `TEAM_INVITE_REVOKED` audit pair for an invitation that is never shown. The pair records what happened.

## Migration plan

**Strategy**: big bang, in one deployment. The old invite route has no frontend caller and the feature is not live, so there is no traffic to strangle.

**Phases**:

1. Check for duplicate accounts by `lower(email)` and resolve them before the migration. Check for placeholder users that own data, have remaining memberships, or are referenced by `audit_logs.user_id`.
2. Run the migration: create `invitations`, add `removed_at` and the new indexes, add the `users_email_lower_unq` index, and delete legacy `INVITED` memberships and placeholder users with no password, no OAuth identity, no remaining memberships, and no audit reference.
3. Deploy the backend with the new routes, remove the old invite route, deploy the worker, then deploy the frontend.
4. Verify the invite flow end to end, then watch the worker logs and the invitation email status.

**Rollback**: revert the deployment, drop the `invitations` table, drop the new indexes and `removed_at`, and restore the old route. Invitations created after the deploy are lost. Deleted legacy rows cannot be restored, so take a backup before the migration.

**Risks**:

- Duplicate emails block the unique index.
- Deleting a placeholder user that owns data would lose that data.
- Deleting a placeholder user referenced by `audit_logs.user_id` would lose the actor link.
- A missing worker leaves invites `QUEUED`.
- An unverified Resend domain causes delivery failures.
- Redis being unavailable causes `QUEUE_UNAVAILABLE`.
- Removing the old route before the frontend is ready breaks any unknown caller.

## Follow-up

- [ ] Add the installed `resend`, `email-best-practices`, `redis-connections`, `redis-observability`, `redis-core`, and `bullmq-specialist` skills to the root `AGENTS.md` `## Agent skills` section.
- [ ] Connect the selected MCP servers in your OpenCode MCP configuration: Resend MCP (`npx -y resend-mcp` with `RESEND_API_KEY`), Redis MCP (`uvx --from redis-mcp-server@latest redis-mcp-server --url $REDIS_URL`), and Playwright MCP (`npx @playwright/mcp@latest`). Connecting is a user config step, not a code change.
- [ ] Consider Resend bounce and complaint webhooks so a delivered invite that bounces is marked failed.
- [ ] Consider a retention or cleanup job for accepted, revoked, and expired invitations.
- [ ] Consider a worker health probe for hosts that require one.
- [ ] Consider email delivery metrics and alerts for queued, failed, and retried invites.
- [ ] Consider team seat limits when plans and billing exist.
- [ ] Consider a leave business flow for owners.
- [ ] Consider OAuth only acceptance when real OAuth ships.
- [ ] Consider a team history view for accepted, revoked, and removed members.
- [ ] Verify the sending domain and set `EMAIL_REPLY_TO` in production.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).
