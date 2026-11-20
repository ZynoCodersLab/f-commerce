# Backend

## Overview

The backend is the Express API workspace. It currently exposes the health endpoint and will host the application, domain, infrastructure, and presentation layers as features are added.

## Key files

| File                                                     | Owns                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/server.ts`                                          | Express app setup, startup verification, graceful shutdown, `/health`, `/api/auth` |
| `src/server.test.ts`                                     | Health smoke test and startup failure checks                                       |
| `src/presentation/middlewares/rate-limit.middleware.ts`  | Rate limiters and the JSON 429 response                                            |
| `src/presentation/middlewares/redis-rate-limit-store.ts` | Shared Redis store, multiplexed client, and in process fallback                    |
| `src/infrastructure/database/drizzle/schema.ts`          | Single source of truth for every table, index, and constraint                      |
| `src/infrastructure/database/drizzle/client.ts`          | Pool, `getDb`, startup probe, test database override                               |
| `src/infrastructure/database/drizzle/context.ts`         | `AsyncLocalStorage` tenant context (`getTenantId`)                                 |
| `src/application/services/auth.service.ts`               | Core authentication and tenant logic (Clean Arch)                                  |
| `src/application/services/team.service.ts`               | Team list, invite lifecycle, accept, role change, and removal rules                |
| `src/domain/business-audit.ts`                           | Profile diff and onboarding audit entry builders                                   |
| `src/worker.ts`                                          | Invitation email worker process (BullMQ consumer, Resend delivery, shutdown)       |
| `src/domain/timezone.ts`                                 | Server day rule: `DEFAULT_TIME_ZONE`, `isValidTimeZone`, `todayInTimeZone`         |
| `package.json`                                           | Backend scripts and dependencies                                                   |

## Commands

Run from the repository root with npm workspaces:

```bash
npm run dev --workspace @f-commerce/backend
npm run dev:worker --workspace @f-commerce/backend
npm run start:worker --workspace @f-commerce/backend
npm run build --workspace @f-commerce/backend
npm run lint --workspace @f-commerce/backend
npm run typecheck --workspace @f-commerce/backend
npm run test --workspace @f-commerce/backend
npm run db:generate --workspace @f-commerce/backend
npm run db:migrate --workspace @f-commerce/backend
```

Migrations live in `backend/drizzle/migrations/`. `db:generate` derives them from `schema.ts`; never edit the SQL by hand.

## Conventions

- The workspace uses native ESM and strict TypeScript.
- Keep `/health` free of database and Redis calls; the smoke test starts the real server, so it needs the same reachable database as the rest of the suite.
- Keep backend dependencies behind the four Clean Architecture layers defined by the root context.
- Use named exports and avoid `any`.
- Take every host value (port, database URL, Redis URL, CORS origins, secrets) from validated environment variables. No host-specific API, SDK, or config file belongs in this workspace, and no host name is hardcoded.

## Gotchas

- The backend development server uses port 4000 by default.
- The server validates the required backend environment variables from docs/specs/0001-stack-and-architecture.md using Zod.
- `server.ts` verifies the database before it binds the port, so a bad `DATABASE_URL` exits 1 instead of serving. It trusts one proxy hop (`trust proxy = 1`) because TLS terminates at the host's proxy, and it drains in-flight requests and closes the pool on `SIGTERM` or `SIGINT`.
- Rate limiting lives in `src/presentation/middlewares/rate-limit.middleware.ts` and `src/presentation/middlewares/invite-rate-limit.middleware.ts`, both sharing `RedisRateLimitStore` and one multiplexed Redis client in `src/presentation/middlewares/redis-rate-limit-store.ts` over `REDIS_URL` with an in process fallback that fails open when Redis cannot answer. Per-IP keys depend on the host/Next proxy overwriting `X-Forwarded-For`; a client-supplied header can spoof the key, while login-by-account and upload-by-user keys are unaffected. `/health` is skipped before touching the store, and the remaining follow-up list is in `docs/specs/0001-stack-and-architecture.md`. CI and local E2E runs set `RATE_LIMIT_DISABLED=true`; production ignores that flag.
- Business profile writes record `audit_logs` rows in the same PostgreSQL transaction as the change: onboarding completion plus name, currency, address, timezone, and logo changes, diffed from the locked before and after rows so a save with no changes writes nothing. Every write needs an authenticated actor and the routes answer 401 before writing when none is available. Onboarding completion is terminal: a repeat returns 409 `ONBOARDING_COMPLETE` and cannot overwrite a profile saved later.
- Tenant isolation is enforced in two parts: `AsyncLocalStorage` carries the request's `businessId` (`context.ts`), and every Drizzle repository filters on `businessId` explicitly. There is no global query plugin, so a new repository method that forgets the filter leaks data across tenants. Background workers or admin scripts run outside a request must pass the tenant id themselves or use `runWithContext`.
- Integration tests run against a real PostgreSQL database, not an in-memory one, so `npm run test` needs a reachable server. `src/test-support/pg-test-database.ts` creates `<database>-test`, applies `backend/drizzle/migrations`, and truncates between tests. Test files must stay serial (`vitest.config.mts` sets `fileParallelism: false`) because they share that database.
- `npm run build` compiles with `tsconfig.build.json`, which keeps `**/*.test.ts` and `src/test-support/**` out of `dist/`. `npm run typecheck` still checks both, and application code must never import `src/test-support`.
- The backend imports runtime values (Zod schemas) from `@f-commerce/contracts`, which Node resolves to `packages/contracts/dist/`. `prebuild` and `pretest` build contracts first, so build and test through an npm script; a bare `tsc` or `node dist/server.js` on a checkout without `packages/contracts/dist` compiles fine and then crashes at startup. `npm run dev` is the exception: it runs `tsx watch --conditions=tsx-dev`, and the `tsx-dev` export condition resolves contracts from `src/index.ts`, so the dev server needs no contracts build.
- `vitest.config.mts` excludes `dist/`, so compiled output from an older build is never collected as tests.
- Foreign keys mean seeded rows need their parents first: insert a `businesses` row before customers, orders, or catalog rows.
- Timestamps use Drizzle's `Date` mode. Repositories set `updatedAt` by hand; the column default only covers inserts.
- Any server day boundary (reports, dashboards, daily filters) comes from `todayInTimeZone` in `src/domain/timezone.ts`. It builds `YYYY-MM-DD` from `formatToParts` with a fixed locale, never by slicing a localized string, and falls back to `Asia/Dhaka` for a bad zone. Do not use the server's own zone or `new Date().toISOString().slice(0, 10)`, which is UTC and disagrees with the business day near midnight.
- `src/worker.ts` runs as its own process, so a retry with a minutes long backoff survives an API deploy or restart. Root `npm run dev` starts the frontend, the API, and the worker together; `start:worker` runs the worker alone for hosts that need a separate service. The API and the worker both refuse to start in production without `RESEND_API_KEY` and `EMAIL_FROM` (and the API rejects a localhost `APP_ORIGIN`), and the worker drains its in flight job, closes Redis, and closes the database on `SIGTERM` or `SIGINT`.
- Every authenticated business request re-checks the membership row in the database. Only `ACTIVE` memberships pass, and access tokens plus the refresh rebuild include `ACTIVE` memberships only, so a removed or demoted member loses access on the next request.
- Email identity is case insensitive. Normalize through `normaliseEmail` in `src/domain/email.ts`; the database enforces `users_email_lower_unq` on `lower(email)`.
- Invitation tokens are 32 random bytes, stored only as a SHA 256 hash, single use, and valid for seven days. Never log a token. The create and resend responses are the only place a raw token appears, and the invite routes send `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex`.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite._
