# Team and staff invites: deployment notes

The team feature from spec 0009 adds a third process, an email provider, and a Redis queue. Deploy both services the same way you already do, then add the worker.

## What runs where

- **Frontend** (`frontend`): unchanged. It serves `/settings/team` and `/invite/<token>` and proxies `/api/*` to `API_ORIGIN`.
- **Backend** (`backend`, `npm start`): creates, resends, cancels, lists, and accepts invitations. It only queues an email, so it stays up when Redis or the email provider is down.
- **Worker** (`backend`, `npm run start:worker`): a separate process that takes jobs from Redis and sends the invitation email through Resend. Run it as its own service, or as a second process on the same host.

## Environment

Set these on the backend, and on the worker too:

| Variable         | Backend                | Worker                 | Notes                                                            |
| ---------------- | ---------------------- | ---------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`   | required               | required               | The worker reads each invitation before sending.                 |
| `REDIS_URL`      | required               | required               | The queue. Use a managed Redis with persistence.                 |
| `APP_ORIGIN`     | required               | required               | Invite links are built from it. Must be the address people open. |
| `RESEND_API_KEY` | required in production | required in production | The server refuses to start in production without it.            |
| `EMAIL_FROM`     | required in production | required in production | A verified sender on your Resend domain.                         |
| `EMAIL_REPLY_TO` | optional               | optional               | Falls back to the inviter's address.                             |

In development, leaving `RESEND_API_KEY` blank keeps everything working: invitations are created with email status `SKIPPED` and the team screen shows the link to copy.

## Order of a deploy

1. Take a database backup. The migration deletes legacy `INVITED` rows and abandoned placeholder accounts.
2. Run the backend migration (`npm run db:migrate --workspace @f-commerce/backend`).
3. Deploy the backend, then the worker, then the frontend.
4. Invite yourself from the team screen and check that the email arrives. Watch the worker log for failed or stalled jobs.

## Operating it

- The worker logs a line for every failed and stalled job. A stalled job means the worker died with a job in flight; BullMQ hands it to another worker.
- Email status is visible on the team screen: sending, sent, failed, or not emailed, with a plain language reason when it failed.
- Invite links hold a secret in the path. They expire after 7 days and work once. Never paste one into a ticket or a log.
- Stopping the worker with `SIGTERM` lets it finish the jobs it is working on before it exits.

## Rolling back

Revert the three deployments, stop the worker, then drop the `invitations` table, its indexes, all indexes the migration added, and the `business_members.removed_at` column, and restore the back end that still has the old invite route. Invitations created after the deploy are lost.
