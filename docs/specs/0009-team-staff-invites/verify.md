# Verify: Team and staff invites

Run these checks after the build. Each section names the acceptance criteria it proves. Everything below was derived from the acceptance criteria in [index.md](./index.md) and checked line by line against the code as built.

## Setup

- [ ] `docker compose up -d postgres redis` starts both services. Verifies **AC-23**.
- [ ] `npm ci` installs the workspace dependencies.
- [ ] `npm run build --workspace @f-commerce/contracts` succeeds.
- [ ] `npm run db:migrate --workspace @f-commerce/backend` applies migrations `0007` and `0008` to a clean database. Verifies **AC-22**.
- [ ] `npm run dev` starts the frontend, the API, and the worker together (`-n frontend,backend,worker`). Verifies **AC-23**.
- [ ] The worker logs `Invitation worker is ready for jobs` and the API logs `Backend listening on port`. Verifies **AC-23**.

## Quality gates

- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run format:check` passes.
- [ ] `npm run test` passes (backend 34 files, 493 tests, 1 skipped; frontend 312 tests; contracts 119 tests).
- [ ] `npm run build` passes with `API_ORIGIN` set.
- [ ] `cd frontend && npx playwright test` passes with the API and the worker running, including `e2e/team-invites.spec.ts`.

## Invite creation and delivery

- [ ] Sign in as an owner and open `/settings/team` from the Team link in the secondary navigation. The page lists active members and pending invitations. Verifies **AC-5**, **AC-21**.
- [ ] Invite a new email. The response is 201 with `invitation`, `inviteUrl`, and `emailStatus: "QUEUED"`, the expiry is seven days out, and the role is `STAFF`. Verifies **AC-1**.
- [ ] The returned link is `<APP_ORIGIN>/invite/<43 url safe characters>`, it is shown once on the screen, and the raw token never appears in the team list response or in the audit rows. Verifies **AC-1**, **AC-20**.
- [ ] The response to the create and resend calls carries `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex`. The `/invite/[token]` page sends `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow`. Verifies **AC-20**.
- [ ] With `RESEND_API_KEY` and `EMAIL_FROM` set, the worker sends the email and the row moves from Sending to Email sent within five seconds without a refresh (the page polls every five seconds while any invite is queued). The email carries the business name, the inviter, the role, the accept link, the expiry, and a line saying the invite can be ignored. Verifies **AC-3**.
- [ ] Make the provider fail. The worker retries three times at about 1, 2, and 4 minutes, then marks the row Failed with a sanitized code (`PROVIDER_UNAUTHORIZED`, `PROVIDER_REJECTED`, `PROVIDER_RATE_LIMITED`, or `EMAIL_SEND_FAILED`) and never echoes the raw provider message. Verifies **AC-3**.
- [ ] Let an invite expire while its email is still queued. The worker marks it Failed with `INVITE_EXPIRED`, does not send, and the team screen offers Resend. Verifies **AC-3**, **AC-12**.
- [ ] Stop Redis, create an invite, and confirm it is still created with `emailStatus: "FAILED"` and `emailError: "QUEUE_UNAVAILABLE"`, with the copy link working. Start Redis and resend. Verifies **AC-4**, **AC-12**.
- [ ] With no `RESEND_API_KEY` in development, create an invite and confirm `emailStatus: "SKIPPED"`, no `emailError`, and a working copy link. Verifies **AC-4**.
- [ ] Start the API with `NODE_ENV=production` and no `RESEND_API_KEY` and confirm it exits with a clear message; repeat with no `EMAIL_FROM`. Start the worker the same way and confirm it exits with the same messages. Verifies **AC-4**, **AC-23**.
- [ ] Send `SIGTERM` to the worker while a job runs: it drains the active job, closes Redis and the database, and exits 0 (SIGINT behaves the same). Verifies **AC-23**.

## Team list

- [ ] The list shows active members with name, email, role, and joined date, owners first and then by name, and pending or expired invitations with email, role, inviter, sent or queued date, expiry, and email status, newest first. Accepted and revoked invitations are hidden. Verifies **AC-5**.
- [ ] A staff account opens `/settings/team` and sees the same lists with no invite, resend, cancel, promote, demote, or remove controls, marked View only. Verifies **AC-2**, **AC-5**.
- [ ] Calling every write route as staff returns 403, and calling any team route with no token returns 401. Verifies **AC-2**.
- [ ] Dates on the screen are rendered in the business timezone after mount (change the business timezone and reload to confirm). Verifies **AC-21**.
- [ ] The page shows a loading skeleton, an empty state with no members or invitations, and an error state with Try again. Verifies **AC-21**.

## Invite page

- [ ] Open the link in a private window. The preview shows the business name, inviter, role, email, and expiry, and no raw token appears in the page text beyond the address bar. Verifies **AC-6**, **AC-20**.
- [ ] An invalid token returns 404 `INVITE_NOT_FOUND`, an expired one 410 `INVITE_EXPIRED`, a revoked one 410 `INVITE_REVOKED`, and an accepted one 409 `INVITE_ALREADY_ACCEPTED`; each shows a clear state and no accept form. Verifies **AC-6**, **AC-13**.
- [ ] A preview for an email that is already an active member reports `alreadyMember: true` and the page says so. Verifies **AC-6**, **AC-10**.

## Accept flow

- [ ] Open a fresh link signed out. The page asks for a name and a password, the password confirmation stays in the browser and is not posted, and accepting lands on `/dashboard` with the invited business active. The refresh cookie is `HttpOnly` and `SameSite=Strict`. Verifies **AC-7**.
- [ ] Confirm the access token and the refresh token now carry the invited business and its `STAFF` role, and the membership row is `ACTIVE` with no `removed_at`. Verifies **AC-7**, **AC-17**.
- [ ] Sign in as an existing account with the invited email, open the link, and accept: the request carries the bearer token and the membership becomes `ACTIVE`. Verifies **AC-8**.
- [ ] Accept without a bearer token for an account that has a password: the API answers 401 `SIGN_IN_REQUIRED` and the page asks the visitor to sign in first. Verifies **AC-8**.
- [ ] Accept for that account while signed in as a different address: 403 `EMAIL_MISMATCH`. Verifies **AC-8**.
- [ ] Invite an account with no password, set one through the link, accept, then sign in with it. Verifies **AC-9**.
- [ ] Accept for an account with no password without sending a name: `users.name` is kept, or the email local part is used when it is empty, and the team list never shows an empty name. Verifies **AC-9**.
- [ ] Send two accept requests for the same token at once: one succeeds, the other gets 409, and only one membership exists. Verifies **AC-7**, **AC-10**.
- [ ] Accept an invite whose email is already an active member: 409 `INVITE_ALREADY_MEMBER`. Verifies **AC-10**.
- [ ] Invite an email and never accept it: the address cannot sign in and gets no business data. A legacy `INVITED` membership never authorizes a request. Verifies **AC-10**.

## Manage invitations

- [ ] Inviting an active member returns 409 `INVITE_ALREADY_MEMBER`, and inviting an address with a live invite returns 409 `INVITE_ALREADY_PENDING` with the existing `invitationId`. The screen explains both. Verifies **AC-11**.
- [ ] Let an invite expire, invite the same email again: the old row is revoked and exactly one live invite exists (the partial unique index holds). Verifies **AC-11**, **AC-18**.
- [ ] Resend a pending invite: a new link appears once, the old link stops working, the expiry moves seven days out, the row returns to Queued, and `TEAM_INVITE_RESENT` is auditioned with no raw token. Verifies **AC-12**, **AC-19**, **AC-20**.
- [ ] Resend, then let the old job run before the new one: the old job is skipped because its token hash no longer matches, and only the new link is delivered. Verifies **AC-12**.
- [ ] Cancel a pending invite: the link answers 410, the row leaves the list, and `TEAM_INVITE_REVOKED` is auditioned. Verifies **AC-13**, **AC-19**.
- [ ] Type an invitation email in mixed case and confirm it is stored lowercase and matches the live invite lookup. Register an account with the same address in different case and confirm the unique lower email index refuses a duplicate. Verifies **AC-18**.

## Manage members

- [ ] Promote an active staff member to Owner: the badge changes, the member can manage the team on their next request, and `TEAM_ROLE_CHANGED` records the previous and new role. Verifies **AC-14**, **AC-19**.
- [ ] Demote an owner to Staff: owner actions stop on the next request. Demoting the last active owner returns 409 `LAST_OWNER`, and demoting yourself returns 409 `SELF_CHANGE_NOT_ALLOWED`. The role select is disabled for your own row. Verifies **AC-14**.
- [ ] Demote two owners at the same time when they are the last two: one succeeds, the other gets 409 `LAST_OWNER`, and one active owner remains. Verifies **AC-14**.
- [ ] Remove a member: the row shows Removed, the next business request gets 403 `BUSINESS_ACCESS_DENIED`, the browser clears the session and returns to `/login`, and `TEAM_MEMBER_REMOVED` is auditioned. Verifies **AC-15**, **AC-17**, **AC-19**.
- [ ] Removing the last owner or yourself is blocked. Verifies **AC-15**.
- [ ] Remove a member, then refresh their session: the new access token omits the removed membership and a business request fails with `BUSINESS_ACCESS_DENIED`. Verifies **AC-17**.
- [ ] Call any business route after a removal, with the old token still in memory: the database check alone must refuse it (the token was valid, the membership is gone). Verifies **AC-17**.
- [ ] Invite the removed email again and accept: the existing membership row becomes `ACTIVE`, role `STAFF`, `removed_at` cleared, with no second row. Verifies **AC-16**.

## Audit and migration

- [ ] After one invite, resend, cancel, accept, role change, and removal, `audit_logs` holds `TEAM_INVITE_CREATED`, `TEAM_INVITE_RESENT`, `TEAM_INVITE_REVOKED`, `TEAM_INVITE_ACCEPTED`, `TEAM_ROLE_CHANGED`, and `TEAM_MEMBER_REMOVED` with the actor, the business, the entity, and the before and after values. Verifies **AC-19**.
- [ ] Every team write writes its audit row in the same transaction: force the audit insert to fail (drop the actor row) and confirm the change rolls back and the response is 500. Verifies **AC-19**.
- [ ] On a database seeded with legacy `INVITED` memberships and `Pending Invite` placeholder users, the migration removes them, keeps a placeholder that owns records or is referenced by `audit_logs.user_id`, and leaves every remaining account able to sign in. Verifies **AC-22**.
- [ ] `POST /api/auth/invite` no longer exists (404), and no code imports it. Verifies **AC-22**.

## Limits and hardening

- [ ] Create or resend more than ten invitations in an hour as one owner: the eleventh answers 429 `RATE_LIMITED`, and a second owner is unaffected. Verifies **AC-24**.
- [ ] Accept more than five times in fifteen minutes from one address: 429 `RATE_LIMITED`, and another address still passes. Verifies **AC-24**.
- [ ] Open the preview more than thirty times in a minute from one address: 429 `RATE_LIMITED`. Verifies **AC-24**.
- [ ] Stop Redis and repeat all three: requests are still allowed because the limit fails open to the in process counter, which still caps the flood. Verifies **AC-24**.
- [ ] Tab through the team screen and the invite page: focus order is logical, dialogs trap focus and close on Escape, statuses are stated as words and not by colour alone, targets are at least 44 by 44 pixels, and nothing relies on a raw colour. Verifies **AC-21**.
- [ ] Open both pages at a narrow width: members and invitations show as cards, the dialogs fit, and the layout stays usable. Verifies **AC-21**.
