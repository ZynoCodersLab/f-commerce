# Review, feat/team-staff-invites, 2026-11-10 (pass B)

**Reviewed by**: opencode/glm-5.3-flash-free (author on deepseek-v4.1-flash)
**Scope**: 127 files, branch vs main (merge base 350a5d7)
**Verdict**: Approve with nits

## Summary

Spec 0009 is delivered end to end: an `invitations` table with hashed single-use tokens, owner-only team management with transactional last-owner guards, public preview/accept routes with sign-in-required semantics, a BullMQ/Resend worker in its own process with stale-job and idempotency checks, both screens, and CI with Redis plus the worker. The branch is genuinely careful where it matters: every team mutation writes its audit row inside the change transaction, the token survives only in the one-time response and the active Redis job, every business request re-checks membership in the database, and the rate limiter fails open without ever storing a raw key. All three Minors from the 2026-11-10 pass are fixed at HEAD (the migration reorder is committed with an explanatory header, the deployment doc's FK sentence now matches the cascading schema, and the `BUSINESS_ACCESS_DENIED` session clear is centralized in `apiFetch` so it covers every screen). What remains is below merge stakes.

## Minor

### 🟡 Redis 7.0+ is required by the limiter but documented nowhere, `backend/src/presentation/middlewares/invite-rate-limit.middleware.ts:66`

**Problem**: The shared counter's `PEXPIRE <key> <ms> NX` flag only exists since Redis 7.0, and `PTTL` negative return handling aside, nothing in the repo states that version floor (CI pins `redis:7.4`, but a self-hosted deploy can run 6.x from the Dockerfile-less "any Node 24 platform" story). `backend/.env.example`, `docs/specs/0009-team-staff-invites/deployment.md`, and spec 0009's config section all stay silent on it.

**Why it matters**: Spec 0009 promotes Redis from optional to a runtime dependency for invite email and rate limiting. On an older server, every `increment` throws, the store falls back to per-process counting each request (fail open), and the shared 10/hour and 5/15-minute protections silently degrade to nothing across instances — with only a generic "Redis rate limit connection error" log line to hint at why.

**Suggested fix**: One sentence in `docs/specs/0009-team-staff-invites/deployment.md` (and optionally `backend/.env.example` near `REDIS_URL`): the invitation feature needs Redis ≥ 7.0 for `PEXPIRE ... NX`, and workers/limiters fail open on older servers. If silent degradation is acceptable, say so; otherwise add a startup `INFO server_version` probe similar to the existing production email gate.

## Nits

- ⚪ `frontend/public/images/Logo.png`, a new 1.5 MB binary ships in `public/` but nothing in `frontend/src` or the e2e suite references it — it exists for a documented follow-up ("use the logo already placed at `frontend/public/images/Logo.png`"). It will be served to any client who guesses the path and bloats the deployment for zero current use. Compress it before it is wired in, or keep it out of this feature's diff.
- ⚪ `frontend/src/app/settings/team/page.tsx:322`, a `FAILED` invitation's date is still labelled "Queued" beside the neighbouring "Email failed" badge. This matches AC-5's literal wording, but "(queued)" or "Not sent" would read better; carried over from the 2026-11-09 and 2026-11-10 passes.
- ⚪ `frontend/src/app/invite/[token]/page.tsx:70`, `formMode` checks `alreadyMember` before `wrong-account`, so a signed-in visitor opening someone else's link is told they are "already a member" of that invited address. Secure (the accept would 403/409), just a misleading message; carried over.
- ⚪ `frontend/src/app/settings/team/page.tsx:689`, the disabled "Remove" button explains itself only via `title`, which keyboard and screen-reader users never reach (disabled elements are unfocusable). Move the reason into an `aria-label` on a wrapping span or render the message inline for self-rows.
- ⚪ `backend/src/application/services/invite-worker.ts:23` and `backend/src/infrastructure/services/resend-email.service.ts:68` duplicate the `EMAIL_NOT_CONFIGURED` string; one shared constant (domain or the email service) would keep the worker's permanent-error set and the producer's code from drifting.

## Strengths

- **Concurrency is earned at the database layer and each race has a named test.** Accept locks the invitation `FOR UPDATE` and re-verifies hash, revocation, acceptance, expiry, and an `ACTIVE`-membership rewrite inside the lock; role change and removal serialize on a business row lock and re-count owners under it; the resend rotate is hash-guarded so a lost race answers `INVITE_RESEND_CONFLICT` instead of dead link; the create path revokes an expired live invite and undoes itself when an accept beats it to the index.
- **Token and email hygiene match the security model exactly.** The raw token exists only in the create/resend response, the link, and the active Redis job (settled jobs deleted); storage keeps only SHA-256; the team DTO omits it; the rate-limit store hashes every key before it reaches Redis or process memory; the invite route, 429 responses, and the Next.js `/invite/:path*` header rule all carry no-referrer/no-store/noindex; and provider errors are reduced to sanitized codes before they are stored or shown.
- **The three findings from the previous pass are verifiably fixed at HEAD**: the reordered 0007 statements are committed with a "Keep this order" comment, the deployment doc now says the `refresh_tokens` FK cascades, and `clearSessionOnBusinessAccessDenied` in `auth-client.ts` makes AC-15's session clear work on every screen through the shared `apiFetch` path.

## Test coverage

Strong for `TESTS = configured`: the service suite pins every invite/resend/cancel/preview/accept branch including the accepted-while-creating and account-won-the-race retries; the worker suite covers stale hash, accepted, revoked, expired-while-queued, permanent vs transient failures, and last-attempt cleanup; the Drizzle integration suite runs the last-owner and dual-accept races against real Postgres; the Redis limiter suite exercises the shared counter across two server instances, the decrement/NX edge cases, per-token capping against rotating IPs, and the fail-open fallback; route tests pin the 401/403 matrix and the cookie; and both pages plus the Playwright invite-to-dashboard flow cover the UI. The one Minor above falls outside that net — no test asserts a Redis version floor, because none of the suites run one. Everything else is adequately pinned.
