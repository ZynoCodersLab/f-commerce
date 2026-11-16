# 0001. Adopt the project stack and architecture

**Date**: 2026-09-08
**Status**: Accepted

> **Revision (2026-10-18)**: The database choice changed from MongoDB + Mongoose to PostgreSQL 18 + Drizzle ORM after the first three features shipped, and the stack table and constraints below now record the new decision. In practice: `DATABASE_URL` replaces `MONGODB_URI`; Drizzle repositories replaced the Mongoose models and `backend/src/infrastructure/database/drizzle/schema.ts` is the source of truth for the data model; Docker Compose runs `postgres` and `redis` with no replica set; the JWT settings are `JWT_SECRET` and `JWT_REFRESH_SECRET` with token lifetimes fixed in code (15 minutes for access tokens, 7 days for refresh tokens); and backend tests run against a real PostgreSQL database that the test setup creates and migrates. Why: the catalog, orders, and customers are relational, and PostgreSQL enforces that shape with foreign keys, partial unique indexes, and transactions.

> **Revision (2026-10-19)**: Hosting is now provider agnostic. The original decision named Vercel for the frontend and Render for the backend; the project now treats the host as a deployment detail rather than an architectural choice, and both applications must run on any Node.js 24 platform without a code change. In practice: no host-specific APIs, config files, build hooks, or SDKs; every host value comes from a validated environment variable; the browser only ever calls the frontend origin, and the Next.js server proxies `/api/*` to `API_ORIGIN`. Why: the deployment target should not shape the code, so the same workspace can move between a managed platform, a container host, and a plain VM.
>
> **Revision (2026-10-19)**: The runtime moved from Node.js 22 LTS to Node.js 24 LTS, and npm from 10 to 11. The root `engines` field, the CI workflow, and each workspace's `@types/node` dependency now target Node.js 24. Why: the project should track the current LTS line, and Node.js 22 leaves active support during the MVP window.

## Summary

The project will use one repository with separate frontend and backend workspaces. The Next.js app and the Express API deploy as two independent services to any Node.js 24 host, so deployment boundaries stay clear while local development and shared TypeScript contracts stay simple. PostgreSQL 18 with Drizzle ORM, JWT authentication, BullMQ with Redis, and Cloudinary form the chosen service foundation.

## Context

A small F-commerce SaaS needs a clean separation between the seller-facing web app and the API that serves it. The product targets solo developers and small teams building for the Bangladesh market (BDT currency, Bengali language). Key forces: mobile-first responsiveness, multi-tenant data isolation, subscription billing in the future, and a 2-3 month MVP timeline with one developer. The current project is already one Git repository, so the repository shape must support two applications without adding unnecessary repository coordination.

## Options considered

### Option 1: Monorepo with two workspaces (chosen)

One repository contains a `frontend` workspace for Next.js and a `backend` workspace for Express. The workspaces share TypeScript contracts when useful, but each keeps its own dependencies, scripts, and deployment configuration. The two services deploy independently, and no hosting provider is fixed by the architecture.

**Pros**: One remote and one review history, simple local setup, shared contracts, and independent deployment targets.

**Cons**: Workspace scripts and dependency boundaries need discipline. A repository change can affect both deployment pipelines, and the two applications still require separate deployment configuration.

### Option 2: Separate frontend and backend repos

Two independent repositories are deployed separately, one for the frontend and one for the API.

**Pros**: Strong repository isolation, independent history, and independent tooling and access control.

**Cons**: Two remotes, two review histories, duplicated setup, and more coordination for one developer. Shared contracts become harder to change safely.

### Option 3: Full-stack Next.js (API routes)

Frontend and API in one Next.js app deployed as a single service.

**Pros**: Fastest to ship, no cross-origin issues, one deployment.

**Cons**: The user's product spec explicitly calls for a separate backend API. Mixing API routes with the frontend app makes it harder to scale the backend independently later. Not the right shape for a multi-tenant SaaS that may eventually split.

## Decision

**Chosen option**: Option 1: Monorepo with two workspaces.

The repository will contain `frontend` and `backend` workspaces. The Next.js app and the Express API deploy independently to any Node.js 24 host. npm workspaces provide the initial workspace tooling because they are built into npm, require no additional task runner, and are sufficient for two applications.

**Implementation skills**: `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.agents/skills/vercel-react-best-practices/`)

## Rationale

The product needs a separate frontend and backend, but separate deployment does not require separate repositories. A monorepo fits the existing Git remote and keeps shared TypeScript contracts close to both applications. npm workspaces avoid adding Turborepo or Nx before the project has enough packages to justify another task runner. Each workspace owns its scripts and start command, so any host can build and deploy the two services independently and the deployment boundary chosen for the product is preserved.

## Proposed stack

| Layer                       | Choice                                                           | Reason                                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                    | TypeScript                                                       | The user's spec requires TypeScript strict mode. Shared types between frontend and backend reduce bugs.                                                                                                                                         |
| Runtime and package manager | Node.js 24 LTS, npm 11                                           | Pinning the runtime family and package manager keeps local, CI, and production dependency resolution consistent on every host.                                                                                                                  |
| Frontend framework          | Next.js (app router)                                             | The user chose this over React + Vite. App router gives built-in routing, server components, and SEO readiness if marketing pages are added later.                                                                                              |
| Backend framework           | Node.js + Express                                                | Matches the user's spec. Minimal and proven. The controller → service → repository pattern fits naturally.                                                                                                                                      |
| Primary DB                  | PostgreSQL 18 + Drizzle ORM                                      | The catalog, orders, and customers are relational, so the database itself enforces foreign keys, partial unique indexes, and transactions. Drizzle keeps one typed schema file as the source of truth and stays behind the repository boundary. |
| Auth                        | JWT with custom endpoints and rotated refresh cookies            | Short lived access tokens plus rotated secure refresh cookies keep long lived credentials out of browser storage.                                                                                                                               |
| Background jobs             | BullMQ + Redis                                                   | Async email sending and order processing. Adds Redis dependency but is the robust choice for a SaaS that will send notifications.                                                                                                               |
| File storage                | Cloudinary                                                       | The user's spec lists Cloudinary first. Generous free tier, simple API, and easy to swap behind a service abstraction later.                                                                                                                    |
| Hosting                     | Any Node.js 24 platform                                          | Host neutral by choice. Each service builds from the repository root and starts with its workspace `start` script, so a managed platform, a container host, and a plain VM are interchangeable.                                                 |
| Frontend to API routing     | Same origin: the Next.js server proxies `/api/*` to `API_ORIGIN` | One browser origin means no CORS, no cross-site cookies, and no public API URL to configure. Any host that runs the workspace `start` script supports it.                                                                                       |
| Repository shape            | Monorepo with `frontend` and `backend` npm workspaces            | Keeps one repository and shared contracts while preserving independent deployment targets.                                                                                                                                                      |
| Shared contracts            | `packages/contracts`, types and Zod schemas only                 | Both applications can share runtime checked request and response contracts without importing domain or infrastructure code.                                                                                                                     |
| API shape                   | Versioned REST JSON at `/api/v1`                                 | Keeps the API explicit and evolvable. Responses use `{success, data, message}` and Zod validates runtime input and output boundaries.                                                                                                           |
| Observability               | Winston with structured logging                                  | Matches the data model spec and provides JSON logs with a clear path to request IDs and secret redaction.                                                                                                                                       |
| Rate limiting               | Layered `express-rate-limit` middleware                          | A global per-IP backstop plus narrower login, registration, refresh, and authenticated upload buckets. In-memory today; a shared store is a follow-up for multi-instance deployments.                                                           |

## Scaffold constraints

**Workspace layout**:

```text
frontend/                 Next.js application
backend/                  Express application
packages/contracts/       TypeScript DTOs, Zod schemas, enums, and API error types only
```

The contracts workspace must not import domain, application, infrastructure, or presentation code. The frontend must not import backend internals. Shared tooling dependencies belong at the repository root. Application dependencies belong to their own workspace.

**Scaffold acceptance**:

- The root workspace installs successfully with `npm ci`.
- The frontend starts on port 3000 and serves a working Next.js app.
- The backend starts on port 4000 and serves `/health`.
- The contracts workspace can be imported by both applications without importing backend internals.
- The root `dev`, `build`, `lint`, `typecheck`, `test`, and `format` scripts are present and document any command that is intentionally a no op before feature code exists.
- Docker Compose starts local PostgreSQL and Redis with credentials and ports documented in the environment examples.
- Each workspace has a minimal smoke test and an environment example file.

**Workspace contract**:

- The root package uses npm workspaces for `frontend`, `backend`, and `packages/contracts`.
- Workspace package names are `@f-commerce/frontend`, `@f-commerce/backend`, and `@f-commerce/contracts`.
- Node.js 24 and npm 11 are declared in the root `engines` field and documented in the contributor setup.
- TypeScript uses strict mode. Backend code targets Node.js 24 with native ESM. Frontend code follows the Next.js compiler defaults. Contracts compile to declarations and JavaScript that both applications can import.
- The initial scaffold pins compatible current major versions for Next.js, Express, Drizzle ORM, the `pg` driver, Zod, TypeScript, and Vitest in `package-lock.json`. Patch upgrades do not change this decision.
- The root scripts run `dev`, `build`, `lint`, `typecheck`, `test`, and `format` for all relevant workspaces. The root `dev` script uses one process for each application and does not start contracts as a server.
- Each application exposes explicit `dev`, `build`, `start`, `lint`, `typecheck`, and `test` scripts. The backend health smoke test starts the real server and asserts the health response, so like the other backend tests it needs a reachable PostgreSQL server, and the test setup creates and migrates a separate test database.
- The backend ships Drizzle SQL migrations under `backend/drizzle/migrations`, generated with `npm run db:generate` and applied with `npm run db:migrate`. Both scripts are configured by `backend/drizzle.config.ts`, which points drizzle-kit at the schema and the migrations folder.

**Boundary enforcement**:

The repository uses `frontend`, `backend`, and `packages/contracts` as the initial package boundaries. Backend folders follow `presentation`, `application`, `domain`, and `infrastructure`. TypeScript project references and ESLint import boundary rules reject frontend imports from backend internals, contracts imports from application or infrastructure code, and domain imports from framework or I/O packages.

**Runtime and commands**:

The repository uses npm workspaces with one root `package-lock.json`, a Node.js 24 LTS version policy, and npm 11. The root package must expose `dev`, `build`, `lint`, `typecheck`, `test`, and `format` commands. The root `dev` command runs the two workspace development servers together, using ports 3000 for the frontend and 4000 for the backend. The root build, lint, typecheck, and test commands must run the affected workspace commands consistently in local development and CI. Dependency installation uses `npm ci`.

**Local services**:

PostgreSQL and Redis run through a repository Docker Compose file for repeatable local development. Compose uses pinned PostgreSQL 18 and Redis 7.4 images, services named `postgres` and `redis`, persistent named volumes, local ports 5432 and 6379, authenticated local credentials, and health checks. The backend exposes `/health`, which returns HTTP 200 and a stable JSON success response without requiring either dependency.

The backend environment contract includes `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGINS`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`, plus an optional `TEST_DATABASE_URL` for the test suite and an optional test-only `RATE_LIMIT_DISABLED` switch that the rate limiter ignores when `NODE_ENV=production`. The frontend environment contract includes `API_ORIGIN`, the backend origin the Next.js server proxies `/api/*` to, and the frontend `.env.example` documents it. No `NEXT_PUBLIC_` variable is required, and no host name is hardcoded in either application. Required values are validated at startup. The `PORT` variable defaults to 4000 for local development and is supplied by the host in production. Development values are documented in the `.env.example` files; production values are supplied by whichever host runs each service.

A managed PostgreSQL service is the database target for the MVP, with the provider chosen before the first production deploy. Redis for BullMQ comes from a managed Redis service or from the host. Cloudinary remains the file storage provider. The scaffold defines their connection and credential variables but does not require production credentials to run local smoke tests.

**Deployment contract**:

Each application deploys on its own to any Node.js 24 host that can run the workspace scripts. A deployment installs from the repository root with `npm ci`, builds the application workspace, which builds `packages/contracts` first through its `prebuild` script, and starts it with that workspace's `start` script: `next start` for the frontend, `node dist/server.js` for the backend. The backend validates its environment and verifies the database connection before it binds the port, so a bad `DATABASE_URL` fails the deploy instead of serving errors. `/health` queries neither PostgreSQL nor Redis, so a platform probe only checks that the process is up. The frontend exposes no dedicated health endpoint; a platform probe requests `/`. The backend trusts one proxy hop (`trust proxy` = 1), because TLS terminates at the host's proxy, and it drains in-flight requests and closes the pool on `SIGTERM`. The frontend reads `API_ORIGIN` and proxies `/api/*` to it. Because the refresh cookie is host only and `SameSite=Strict`, the browser must keep calling only the frontend origin; a topology where the browser calls the API on a different domain would need `SameSite=None`, a secure cookie, and an explicit CSRF defense. Neither deployment runs the other application. No provider-specific config file, build hook, or SDK belongs in the repository; provider settings live in the host's own configuration. Production deployment is not required for scaffold acceptance.

**Architecture mapping**:

In the backend, Express routes and controllers are the presentation layer, use cases are the application layer, entities and value objects are the domain layer, and Drizzle repositories and migration files, Redis workers, Cloudinary adapters, and Winston setup are the infrastructure layer. The domain layer has no framework or I/O imports. The frontend is a presentation client that depends on contracts and API responses, never on backend domain or infrastructure modules.

**Security and configuration defaults**:

The backend derives tenant context from verified authentication data and applies it to every business query. Each repository filters by `businessId` explicitly, and repository tests cover tenant isolation. Access JWTs are short lived. Refresh tokens are rotated and kept in a secure HTTP only cookie. The cookie is host only with `SameSite=Strict`, which is the CSRF defense for the cookie based endpoints while the browser stays on the frontend origin. CORS reads an allowlist from validated environment variables and includes local and approved preview origins only. Server secrets stay in the backend environment. The frontend exposes no backend secret and needs no `NEXT_PUBLIC_` variable, because the browser only calls the frontend origin.

**Rate limiting and security headers**:

The backend applies `helmet()` globally, so every response carries the standard security headers. `express-rate-limit` adds a 100 requests/min per-IP backstop to the API, skipping `/health` so platform probes are never throttled. Extra buckets protect login by IP (10 failed attempts per 15 minutes) and by normalized email (20 failed attempts per 15 minutes), registration (5 per hour per IP), refresh (60 per minute per IP), and authenticated image uploads (10 per minute per user, before multer buffers the file). Successful logins do not consume the login allowance, and rejected requests return the API's JSON error shape.

Two follow-ups are required before the backend runs as more than one instance or relies on per-IP limits for security:

- **Shared limiter store**: the limiters use `express-rate-limit`'s in-memory store. Counters are per process, reset on restart, and are not shared across instances, so every instance enforces its own quota. When the backend scales beyond one process, or when BullMQ and Redis land, replace the store with a Redis-backed store using the existing `REDIS_URL` contract so the limits are global.
- **Trustworthy client IP**: per-IP keys come from `req.ip` with one trusted proxy hop (`trust proxy = 1`). The host/Next proxy must overwrite `X-Forwarded-For`; a custom client can otherwise supply the header and spoof the key. The per-account login limit and per-user upload limit key on verified data and are not affected. Configure the edge proxy to overwrite the header, or terminate at a trusted proxy that does, before treating per-IP limits as a security boundary. Add another proxy hop only when a CDN or load balancer actually fronts the host, and raise `trust proxy` at the same time.

**CI boundaries**:

GitHub Actions runs on pull requests and the default branch. Frontend changes run frontend lint, typecheck, test, and build checks. Backend changes run backend lint, typecheck, test, and build checks. Changes to `packages/contracts`, root configuration, lockfiles, or shared tooling run checks for both workspaces. The workflow rejects a change when any check fails; path filters that skip unaffected checks are a follow up, and until they land every change runs the full check set. Vitest is the unit and integration test runner, each workspace includes one smoke test, and Playwright runs the end to end tests. CI starts a PostgreSQL service, applies Drizzle migrations, and runs the Playwright suite against the running applications. The backend health smoke test starts the application against the test database and asserts the health response.

## Consequences

**Positive**:

- One repository keeps the frontend, backend, and shared contracts in sync.
- Clean application boundaries let each workspace evolve independently.
- TypeScript shared types make the API contract explicit and catch bugs at compile time.
- PostgreSQL enforces the relational data model with foreign keys, partial unique indexes, and transactions, and Drizzle migrations keep every environment aligned.
- Cloudinary's free tier handles product images without storage infrastructure.
- Because the host is swappable, hosting cost and free-tier limits are a deployment-time choice instead of a constraint baked into the code.

**Negative / tradeoffs**:

- One repository can trigger work across both deployment pipelines, so CI must identify affected workspaces.
- Host neutrality rules out platform-only helpers, such as edge middleware, managed queues, or platform environment injection, unless a portable fallback exists.
- Workspace boundaries need clear scripts and dependency ownership.
- Cross-origin setup (CORS) adds a small configuration burden and a potential security misconfig point.
- Local development still needs two `npm run dev` processes.
- Redis adds one more infrastructure dependency for background jobs.
- Schema changes ship as Drizzle migrations, and backend tests need a reachable PostgreSQL server, so local test runs require the database to be running.

**Neutral**:

- Next.js app router uses server components by default; the frontend team must decide which components are server vs client.
- The hosting provider is chosen at deploy time, and the two services may run on the same host or on different hosts.
- BullMQ requires a Redis instance; the host must provide Redis or the worker must connect to a managed Redis service.

## Follow-up

- [ ] Reconcile workspace commands and paths in `AGENTS.md` after the scaffold is up.
- [ ] Set up CORS config early (the first cross-origin request will fail without it).
- [ ] Add workspace aware CI path filters so unaffected checks are skipped.
- [x] Read the API origin from `API_ORIGIN` in `frontend/next.config.ts` instead of the hardcoded `http://localhost:4000`. The config defaults to `http://localhost:4000` for local development, trims trailing slashes, and fails a production build when the value is missing or is not an absolute `http` or `https` URL.
- [x] Build the `packages/contracts` workspace before either application build in every path, so a fresh install can start the API. The root `workspaces` array lists `packages/contracts` first. Each application also declares `prebuild`, and the backend `predev` and `pretest`, so a single-workspace build or dev start cannot miss the contracts build.
- [ ] Confirm current provider pricing and limits before production deployment.
- [ ] Choose the managed PostgreSQL provider before the first production deploy. Confirm its TLS requirements and carry the mode in `DATABASE_URL` (for example `?sslmode=require`); the pool passes the URL through unchanged, so a wrong mode fails at startup.
- [ ] Apply Drizzle migrations during production deploys and document the rollback path before the first production deploy.
- [ ] Add provider neutral container definitions only when a target host needs them.
- [ ] Stop the product route test depending on superuser rights. `rolls back the state change when the audit write fails` deletes a `users` row inside `SET session_replication_role = replica` to manufacture a failed audit insert. That setting is rejected for a least-privilege role, so the test would fail the day CI or the test database stops connecting as `postgres`. The durable fix simulates the failure without violating a foreign key: stub the audit repository, or the transaction's audit write, to throw for that actor, and keep auth satisfied by the membership row alone. The workflow has no other `DISABLE TRIGGER` usage; the former `ALTER TABLE ... DISABLE TRIGGER ALL` bypass was confined to this one test and is gone.
