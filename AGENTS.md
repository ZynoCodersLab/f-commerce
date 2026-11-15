# F Commerce Order Manager

## Stack

- **Language and runtime**: TypeScript, Node.js 24 LTS
- **Framework**: Next.js app router, Express
- **Key dependencies**: PostgreSQL with Drizzle ORM, JWT authentication, BullMQ with Redis, Cloudinary
- **Package manager**: npm 11 with npm workspaces

## Build approach

Tracer Bullet, build each feature as a thin complete path through the database, API, and UI.

## Commands

```bash
# Install
npm ci

# Dev servers
npm run dev

# Build
npm run build

# Test
npm run test

# Quality checks
npm run lint
npm run typecheck
npm run format:check
```

## Specs

Stored in `docs/specs/`. Newer specs use a folder per feature: `docs/specs/NNNN-title/index.md`, with `rationale.md` and `verify.md` beside it. Earlier specs use a single `docs/specs/NNNN-title.md`.

## Deployment

Host agnostic. The frontend and the API deploy as two independent services to any Node.js 24 platform: a managed PaaS, a container host, or a plain VM, with no code change between them.

- Use no host-specific APIs, config files, build hooks, or SDKs.
- Read every host value (port, public origin, database URL, secrets, service URLs) from a validated environment variable. Never hardcode a host name.
- The browser calls the frontend origin only. The Next.js server proxies `/api/*` to `API_ORIGIN`, so no CORS and no `NEXT_PUBLIC_` variable is needed in production. The refresh cookie is host only and `SameSite=Strict` on that origin, so browser code must never call the API host directly; that path would need `SameSite=None`, a secure cookie, and CSRF protection.
- A host builds only the application workspace, then runs that workspace's `start` script. Each application's `prebuild` builds `packages/contracts` first, so no host runs a separate contracts build step.
- Keep `/health` unauthenticated and free of external dependencies so any platform can probe it.
- Keep background work in its own process entry point so it can run as a separate service on hosts that require it.

## Rules

- Keep the four Clean Architecture layers separate: `domain`, `application`, `infrastructure`, and `presentation`.
- Keep domain logic independent from frameworks, databases, HTTP clients, and other I/O.
- Make outer layers depend on inner layers, never the reverse.
- Keep use cases as thin orchestrators and enforce business invariants in entities.
- Use DTOs or plain objects across layer boundaries. Do not expose domain entities to presentation code.
- Use strict TypeScript. Avoid `any` and require exhaustive types.
- Organize application code by layer, with clear and consistent naming.
- Document public APIs and use one consistent error handling pattern.
- Validate environment variables at startup and use named exports only.
- Keep the UI accessible to the WCAG AA baseline.
- Use conventional commit messages.

## Tooling

- Use the standard ESLint and Prettier setup for Next.js and Express.
- Run lint, format, and typecheck before each commit.
- Use unit and integration tests.
- When a test mocks a class the code constructs with `new`, the mock implementation must be a regular function, not an arrow; Vitest constructs mock implementations.
- Run basic continuous integration checks on push for lint, typecheck, and tests.

## Git

- integration: on
- branch prefix: `feat/`
- commit: per milestone

## Agent skills

- [lucide-icons](.agents/skills/lucide-icons/): `aksuharun/skills`, Lucide icons across frontend frameworks.
- [vercel-composition-patterns](.agents/skills/vercel-composition-patterns/): `vercel-labs/agent-skills`, React composition patterns.
- [deploy-to-vercel](.agents/skills/deploy-to-vercel/): `vercel-labs/agent-skills`, deployment workflows when Vercel happens to be the chosen host.
- [vercel-react-best-practices](.agents/skills/vercel-react-best-practices/): `vercel-labs/agent-skills`, React and Next.js practices.
- [vercel-react-native-skills](.agents/skills/vercel-react-native-skills/): `vercel-labs/agent-skills`, React Native practices if mobile code is added.
- [vercel-react-view-transitions](.agents/skills/vercel-react-view-transitions/): `vercel-labs/agent-skills`, view transition patterns.
- [vercel-cli-with-tokens](.agents/skills/vercel-cli-with-tokens/): `vercel-labs/agent-skills`, CLI workflows when Vercel happens to be the chosen host.
- [vercel-optimize](.agents/skills/vercel-optimize/): `vercel-labs/agent-skills`, web performance optimization.
- [web-design-guidelines](.agents/skills/web-design-guidelines/): `vercel-labs/agent-skills`, web design and accessibility guidance.
- [writing-guidelines](.agents/skills/writing-guidelines/): `vercel-labs/agent-skills`, clear writing guidance.
- [bullmq-specialist](.agents/skills/bullmq-specialist/): `sickn33/agentic-awesome-skills`, BullMQ queues, retries, and workers.
- [redis-core](.agents/skills/redis-core/): `redis/agent-skills`, Redis data structures and key naming.
- [redis-connections](.agents/skills/redis-connections/): `redis/agent-skills`, Redis client pooling, pipelining, and timeouts.
- [redis-observability](.agents/skills/redis-observability/): `redis/agent-skills`, Redis metrics, slow commands, and incident triage.
- [resend](.agents/skills/resend/): `resend/resend-skills`, the Resend email API, inbound webhooks, and templates.
- [email-best-practices](.agents/skills/email-best-practices/): `resend/email-best-practices`, deliverability, auth records, and compliance.

MCP servers: `@modelcontextprotocol/server-postgres` (recommended), `@modelcontextprotocol/server-git` (recommended). Host-specific MCP servers, such as `https://mcp.vercel.com`, are optional and only useful when that host is the chosen target.

## Context files

<!-- Nested AGENTS.md files are listed here as they are created -->

- [backend/AGENTS.md](backend/AGENTS.md) (Express API workspace conventions and commands)
- [frontend/AGENTS.md](frontend/AGENTS.md) (Next.js generated guidance)
- [packages/contracts/AGENTS.md](packages/contracts/AGENTS.md) (shared DTO and schema boundary)

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
