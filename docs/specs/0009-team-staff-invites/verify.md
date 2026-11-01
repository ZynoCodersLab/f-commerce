# Verify: Team and staff invites

Run these checks after the build. Each section names the acceptance criteria it proves.

## Setup

- [ ] `docker compose up -d postgres redis` starts both services.
- [ ] `npm ci` installs the workspace dependencies.
- [ ] `npm run build --workspace @f-commerce/contracts` succeeds.
- [ ] `npm run db:migrate --workspace @f-commerce/backend` applies the new migration to a clean database.
- [ ] `npm run dev` starts the frontend, the backend, and the worker.
- [ ] The backend logs that the database and the worker are ready, and the worker logs that it is listening.

## Quality gates

- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run format:check` passes.
- [ ] `npm run test` passes, including the new backend, frontend, and contract tests.
- [ ] `npm run build` passes with `API_ORIGIN` set.
- [ ] `cd frontend && npx playwright test` passes on desktop and mobile.

## Invite creation and delivery

- [ ] Sign in as an owner and open `/settings/team`. The Team link is in the secondary navigation and a card on `/settings` links to the page. Verifies **AC-5**, **AC-21**.
- [ ] Invite a new email. The dialog accepts the email, shows the fixed Staff role, and returns a success panel with a copy link and a queued status. Verifies **AC-1**.
- [ ] Copy the link and open it in a private window. The preview shows the business name, inviter, role, email, and expiry. Verifies **AC-6**.
- [ ] With `RESEND_API_KEY` and `EMAIL_FROM` set, the worker sends the email and the team row changes from Queued to Sent within 5 seconds without a manual refresh. The email contains the business name, inviter, role, accept link, expiry, and an ignore note. Verifies **AC-3**.
- [ ] Make the provider fail and confirm the worker retries on the initial attempt and three more times, at roughly 1, 2, and 4 minutes, then marks the row Failed. Verifies **AC-3**.
- [ ] Let an invite expire while its email is still queued. The worker marks the row Failed with `INVITE_EXPIRED`, and the team screen offers Resend. Verifies **AC-3**, **AC-4**.
- [ ] Stop Redis, create another invite, and confirm the invitation still exists with Email failed, `emailError: QUEUE_UNAVAILABLE` in the response, and a working copy link. Restart Redis and resend. Verifies **AC-4**, **AC-12**.
- [ ] Remove `RESEND_API_KEY` in development, create an invite, and confirm the row shows Not configured and the copy link works. Verifies **AC-4**.
- [ ] Start the backend in production mode without `RESEND_API_KEY` or `EMAIL_FROM` and confirm it exits with a clear configuration error. Start the worker in the same state and confirm it exits with the same clear error. Verifies **AC-4**, **AC-23**.
- [ ] Open the invite page in a business with a timezone other than yours and confirm the expiry date is shown in the business timezone. Verifies **AC-6**, **AC-21**.

## Accept flow

- [ ] Accept a new account with a name, password, and confirmation. The membership becomes Active, the dashboard opens with the invited business active, and the new account can sign out and sign back in. Verifies **AC-7**, **AC-17**.
- [ ] Confirm the password confirmation is checked in the browser only and is not sent in the accept request body. Verifies **AC-7**.
- [ ] Sign in as an existing account with the invited email, open the link, and accept. The accept call uses the bearer token and the membership becomes Active. Verifies **AC-8**.
- [ ] Sign in as a different account and open the link. The page shows the signed in email, offers sign out, and the accept call returns 403 `EMAIL_MISMATCH`. Verifies **AC-8**.
- [ ] Open the link signed out for an existing password account. The page asks the invitee to sign in first, and a direct accept without a bearer token returns 401 `SIGN_IN_REQUIRED`. Verifies **AC-8**.
- [ ] Invite an account that has no password, set a password through the link, accept, and sign in with the new password. Verifies **AC-9**.
- [ ] Accept an account with no password without sending a name. The existing `users.name` is kept; if it is empty, the email local part is used, and the team list never shows a null name. Verifies **AC-9**.
- [ ] Try to accept an expired, revoked, already accepted, and invalid token. Each shows a clear state and no accept form. Verifies **AC-6**, **AC-13**.
- [ ] Send two accept requests for the same token at the same time. One succeeds, the other gets 409, and only one membership exists. Verifies **AC-7**, **AC-10**.
- [ ] Accept an invite for an email that is already an active member. The API returns 409 `INVITE_ALREADY_MEMBER`. Verifies **AC-6**, **AC-10**.
- [ ] Invite an email, never accept it, and confirm the email cannot sign in and has no business access. Verifies **AC-10**.

## Team management

- [ ] The team list shows active members with name, email, role, and joined date, and pending or expired invites with email, role, inviter, sent date, expiry, and email status. Owners sort first, then members by name, and invites newest first. Verifies **AC-5**.
- [ ] A staff account can open `/settings/team`, sees the lists, and has no invite, resend, cancel, promote, demote, or remove actions. Direct calls to those routes return 403. Verifies **AC-2**, **AC-5**.
- [ ] Invite an email that is already an active member. The API returns 409 `INVITE_ALREADY_MEMBER`. Invite an email with a live pending invite. The API returns 409 `INVITE_ALREADY_PENDING`. Verifies **AC-11**.
- [ ] Let an invite expire, invite the same email again, and confirm the old row is revoked and only one live link exists. Verifies **AC-11**.
- [ ] Resend a pending invite. A new link is returned once, the old link stops working, the expiry is extended by seven days, and the row returns to Queued. Verifies **AC-12**.
- [ ] Resend a pending invite, then run the old worker job before the new one. The old job is skipped because the token hash no longer matches, and only the new link is delivered. Verifies **AC-12**, **AC-20**.
- [ ] Cancel a pending invite. The row disappears from the pending list and the link stops working. Verifies **AC-13**.
- [ ] Promote an active staff member to Owner. The role badge changes, the member can manage the team on the next request, and the audit row records the change. Verifies **AC-14**, **AC-19**.
- [ ] Demote an owner to Staff. The member loses owner actions on the next request. Try to demote the last active owner and confirm 409 `LAST_OWNER`. Try to demote yourself and confirm 409 `SELF_CHANGE_NOT_ALLOWED`. Verifies **AC-14**.
- [ ] Demote two owners at the same time when they are the last two. One succeeds, the other gets 409 `LAST_OWNER`, and one active owner remains. Verifies **AC-14**.
- [ ] Remove a member. The row becomes Removed, the member loses access on the next request, and the browser clears the active business on `BUSINESS_ACCESS_DENIED`. Try to remove the last owner and yourself and confirm both are blocked. Verifies **AC-15**, **AC-17**.
- [ ] Remove a member, then refresh their session. The refresh response does not include the removed membership, and a business request gets `BUSINESS_ACCESS_DENIED`. Verifies **AC-17**.
- [ ] Invite the removed email again, accept, and confirm the existing membership row becomes Active with role Staff and `removed_at` cleared. Verifies **AC-16**.
- [ ] Invite `Jane@x.com` when `jane@x.com` already exists. The existing account is found, and the invite preview asks that account to sign in. Verifies **AC-18**.

## Security and data

- [ ] The team list never returns a raw invite token, and the database stores only the SHA 256 hash. Verifies **AC-20**.
- [ ] The backend and worker logs contain no raw token and no full invite link. Verifies **AC-20**.
- [ ] The invite page sends `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex`. Verifies **AC-20**.
- [ ] The 11th invite or resend in an hour, the 6th accept in 15 minutes from one IP, and the 31st preview in a minute return 429 `RATE_LIMITED`. Verifies **AC-24**.
- [ ] Stop the rate limit store, then create an invite. The request still succeeds and the invite is created with the queue failure state if Redis is also down. Verifies **AC-4**, **AC-24**.
- [ ] Every invite create, resend, cancel, accept, role change, and removal has one `audit_logs` row with the actor, business, entity, and before and after values. Verifies **AC-19**.
- [ ] The migration removes legacy `INVITED` memberships and placeholder `Pending Invite` users with no password, no OAuth identity, and no remaining memberships. The `users_email_lower_unq` index exists. Verifies **AC-22**.
- [ ] A placeholder user referenced by `audit_logs.user_id` is kept by the migration, and the audit row still resolves. Verifies **AC-22**.
- [ ] `POST /api/auth/invite` returns 404 and no frontend code calls it. Verifies **AC-22**.

## Worker and deployment

- [ ] Stop the worker while Redis is running, create an invite, and confirm the row stays Queued. Start the worker and confirm it becomes Sent. Verifies **AC-23**.
- [ ] Send `SIGTERM` to the worker and confirm it finishes the active job and closes the Redis connection without an unhandled rejection. Verifies **AC-23**.
- [ ] Run `npm run start:worker --workspace @f-commerce/backend` after a build and confirm it starts with the production environment. Verifies **AC-23**.
- [ ] CI starts Redis, starts the worker, and runs the end to end invite flow. Verifies **AC-23**.

## Accessibility and responsive layout

- [ ] The team page and invite page work at 320 px, 768 px, and 1440 px. The team list becomes stacked cards on small screens. Verifies **AC-21**.
- [ ] Every dialog traps focus, closes on Escape, and returns focus to the trigger. Verifies **AC-21**.
- [ ] Every status badge has text, not color alone. Form errors are linked to their fields. The pages pass a WCAG AA contrast check. Verifies **AC-21**.
- [ ] A keyboard only user can invite, copy the link, resend, cancel, promote, demote, remove, and accept an invite. Verifies **AC-21**.
