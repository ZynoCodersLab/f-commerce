# Scope: F-Commerce Order Manager

A mobile-first SaaS for small businesses selling products through Facebook, WhatsApp, Instagram and similar channels. Sellers create, confirm, ship and track orders while managing inventory, customers and profit.

**Build approach:** Tracer Bullet (vertical slices every feature built end to end through DB, API and UI).

**Workflow:** GA (verify, test, model review, document after develop).

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`._

## At a glance

| #   | Feature                           | Phase      | Status      |
| --- | --------------------------------- | ---------- | ----------- |
| 1   | Stack & architecture              | Foundation | done        |
| 2   | Data model                        | Foundation | done        |
| 3   | Coding standards & tooling        | Foundation | done        |
| 4   | Design system & UI foundation     | Foundation | done        |
| 5   | Authentication & tenant isolation | Slice 1    | done        |
| 6   | Business profile & onboarding     | Slice 1    | done        |
| 7   | Customers                         | Slice 1    | done        |
| 8   | Products & categories             | Slice 2    | done        |
| 9   | Orders (CRUD + status workflow)   | Slice 2    | done        |
| 10  | Payments                          | Slice 2    | planned     |
| 11  | Inventory management              | Slice 4    | planned     |
| 12  | Delivery & shipping               | Slice 4    | planned     |
| 13  | Expenses & profit calculation     | Slice 4    | planned     |
| 14  | Dashboard                         | Slice 4    | planned     |
| 15  | Reports                           | Slice 5    | planned     |
| 16  | Search & filters                  | Slice 5    | planned     |
| 17  | Notifications                     | Slice 5    | planned     |
| 18  | Invoice generation                | Slice 5    | planned     |
| 19  | OAuth provider login              | Slice 3    | planned     |
| 20  | Marketing site                    | Launch     | planned     |
| 21  | Product variant archiving         | Slice 2    | planned     |
| 22  | Business timezone                 | Slice 1    | done        |
| 23  | Team & staff invites              | Slice 1    | in-progress |

## Foundations

### 1. Stack & architecture · done

Decide the full stack (frontend, backend, database) and scaffold a runnable project.
**Done when:** the chosen stack is captured in the spec, the repo boots locally, and the workspace smoke tests pass.

- [x] Design it (spec): `/architect stack & architecture`
      Spec [0001](../specs/0001-stack-and-architecture.md)
- [x] Build it: `/develop scaffold`
  - [x] Workspace monorepo and shared contracts scaffolded (AC scaffold acceptance)
  - [x] Frontend and backend runnable with health smoke test (AC frontend and backend startup)
  - [x] Local services, environment examples, lint, tests, builds, and CI added (AC local services and tooling)
- [x] Verify it: `/check verify scaffold`
- [x] Test it: `/test scaffold`
- [x] Review it (fresh model): `/check review scaffold`
- [x] Document it: `/document scaffold`
      Spec 0001 · code in `frontend/`, `backend/`, and `packages/contracts/`

### 2. Data model · done

Core entities: users, businesses, customers, products, categories, orders, order items, payments, expenses, inventory transactions.
**Done when:** schema supports full order lifecycle with tenant isolation and historical snapshots.

- [x] Design it (spec): `/architect data model`
- [x] Build it: `/develop data model`
      Spec 0002 · code in `backend/src/domain/entities` and `backend/src/infrastructure/database/drizzle/schema.ts`
- [x] Verify it: `/check verify data model`
- [x] Test it: `/test data model`
- [x] Review it (fresh model): `/check review data model`
- [x] Document it: `/document data model`

### 3. Coding standards & tooling · done

Lint, format, type checking, and project guardrails from the real scaffolded monorepo.
**Done when:** workspace conventions and automation reflect the project accurately, and the enforcement checks run clean on the main branch.

- [x] Setup tooling: `/develop tooling`
- [x] Finish workspace checks and review follow-ups: `/check verify tooling`
      Root `AGENTS.md`, workspace scripts, and repo-level tooling are in place; startup validation and CI follow-up still need final pass.

### 4. Design system & UI foundation · done

Typography, colors, spacing, and base components for mobile-first SaaS UI.
**Done when:** `design.md` defines the language; base components are accessible and keyboard friendly.

- [x] Design it (spec): `/architect design system & UI foundation`
      Spec [0001](../specs/frontend/0001-design-system-ui-foundation.md)
- [x] Build it: `/develop design system & UI foundation` - [x] Tailwind tokens, fonts, themes, and `design.md` (AC-1) - [x] Responsive seller shell and theme boundary (AC-2) - [x] Accessible primitives and shared async states (AC-3, AC-4) - [x] Replace scaffold page and add primitive tests (AC-5)
      Code in `frontend/`
- [x] Verify it: `/check verify design system & UI foundation`
- [x] Test it: `/test design system & UI foundation`
- [x] Review it (fresh model): `/check review design system & UI foundation`
- [x] Document it: `/document design system & UI foundation`

## Slice 1: Core Order Management

### 5. Authentication & tenant isolation · done

User auth, JWT tokens, role management (owner/staff), strict multi-tenant data rules.
**Done when:** users can register/login; each query enforces businessId isolation; unauthorized access is impossible.

- [x] Design it (spec): `/architect authentication & tenant isolation`
      Spec [0003](../specs/0003-authentication-tenant-isolation/index.md)
- [x] Build it: `/develop authentication & tenant isolation`
      Code in `backend/src/`
  - [x] Auth & Tenant Infrastructure (AC-4)
  - [x] Core Authentication Flow & Data Models (AC-1, AC-2, AC-3)
  - [x] OAuth & Role-based Access (AC-1, AC-5, AC-6)
- [x] Verify it: `/check verify authentication & tenant isolation`
- [x] Test it: `/test authentication & tenant isolation`
- [x] Review it (fresh model): `/check review authentication & tenant isolation`
      Review [2026-09-20-feat-auth-tenant-isolation](../reviews/2026-09-20-feat-auth-tenant-isolation.md)
- [x] Document it: `/document authentication & tenant isolation`

### 6. Business profile & onboarding · done

Registration flow creates business account, collects business info (name, logo, currency, address).
**Done when:** new user can complete onboarding and see their business data isolated from others.

- [x] Design it (spec): `/architect business onboarding`
      Spec [0004](../specs/0004-business-profile-onboarding.md) - [x] Data model migration (Business entity fields + Mongoose schema) - [x] BusinessService and repository - [x] Business controller (GET/PUT /api/business/me, POST /api/business/logo, PUT /api/business/onboarding, draft endpoints) - [x] Onboarding gate middleware - [x] Frontend onboarding wizard (/onboarding route, 4-step flow) - [x] Settings business profile section (/settings route)
- [x] Verify it — runtime verified: backend + frontend dev servers started; all API endpoints exercised via curl and through frontend proxy (:3000); full e2e flow (register → 403 gate → draft save → complete onboarding → 200 access); draft cleared from DB after completion; STAFF single-membership permissions verified (OWNER write 200, STAFF write 403, STAFF read 200); magic-byte validation confirmed (spoofed .png text file rejected with 400); DraftSaveSchema field whitelist verified (isAdmin/$where rejected); Zod validation confirmed (400 on invalid currency/missing address); tenant isolation gate confirmed (403 for incomplete, 200 for complete); auth middleware 403 responses include `message` field (review's Major fixed). ⚠️ STAFF multi-membership gate bug confirmed at runtime: STAFF user with incomplete business at memberships[0] gets 403 "Onboarding required" when accessing a completed business via x-business-id — AC-5 PARTIAL.
- [x] Test it: `/test business onboarding` — 88 backend tests (10 files) + 46 frontend unit tests (7 files) passing; auth controller integration tests time out due to pre-existing MongoDB connectivity issue (not related to feature changes) — traced to spec 0004 AC-1/3/4/5
- [x] Review it (fresh model): `/check review business onboarding`
      Findings [2026-09-24-feat-business-backend](https://github.com/review) — 3 blockers, 3 major, 6 minor, 6 nits. Verified by claude-sonnet-4-6. All 3 blockers addressed in commit 9196280: (1) onboarding gate now runs inside `runWithContext` with proper error handling, (2) `DraftSaveSchema` Zod validation added for field whitelist, (3) `onboarding.middleware.ts` deleted.

### 7. Customers · done

Customer CRUD, search/filter, order history and spending view, clickable phone on mobile.
**Done when:** user can create/edit/search customers and see customer profile with order history.

- [x] Design it (spec): `/architect customers`
      Spec [0005](../specs/0005-customers/index.md)
- [x] Build it: `/develop customers`
  - [x] Data and transaction foundation, indexes, backfill, and legacy order handling (AC-4, AC-5, AC-7, AC-8, AC-10, AC-12)
  - [x] Customer domain and API for create, edit, archive, restore, validation, and concurrency (AC-1, AC-2, AC-3, AC-4, AC-8, AC-9, AC-10)
  - [x] Search, profile totals, order history, cursors, and tenant access (AC-5, AC-6, AC-7, AC-11, AC-12)
  - [x] Customer screens for search, create, edit, profile, archive, restore, and timeout recovery (AC-1, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-12)
        Code in `backend/src/application/services/customer.service.ts`, `backend/src/presentation/controllers/customer.controller.ts`, `frontend/src/app/customers/`
- [x] Verify it: `/check verify customers` — all acceptance criteria verified at runtime: backend + frontend dev servers started; all API endpoints tested; typecheck clean; 245 backend tests pass; 55 frontend tests pass; 18 e2e tests pass; profile, search, duplicate block, archive, restore, and timeout recovery driven in the browser. Atlas index creation and the `version` backfill still owe a real target database.
- [x] Test it: `/test customers`
- [x] Review it (fresh model): `/check review customers` — See [2026-10-16-feat-customers.md](../reviews/2026-10-16-feat-customers.md)
- [x] Document it: `/document customers` — See [2026-10-16-feat-customers.md](../PRs/2026-10-16-feat-customers.md)

### 22. Business timezone · done

Every business stores one IANA timezone and the console uses it for delivery deadline checks, timestamps, and future server day boundaries. Onboarding asks for the zone, settings can change it with a confirmation, and existing businesses start on `Asia/Dhaka`.

**Done when:** every console date and the Overdue badge follow the stored business timezone, two viewers in different browser zones see the same result for the same deadline, onboarding sets the zone, and settings can change it with a clear warning.

- [x] Design it (spec): `/architect business timezone`
      Spec [0008](../specs/0008-business-timezone/index.md)
- [x] Build it: `/develop business timezone`
  - [x] Data, contracts, and profile API: the column, entity, draft type, schema, migration, repository, and read and write endpoints (AC-1, AC-2, AC-3, AC-4)
  - [x] Shared provider, cache, auth change signal, shell badge, header date, and currency call replacement (AC-7, AC-11)
  - [x] Onboarding and settings fields, grouped select, prefill, draft, confirmation dialog, and provider update (AC-5, AC-6, AC-12)
  - [x] Timestamp formatters, deadline warning, Overdue badge, backend day helper, and tests (AC-8, AC-9, AC-10)
  - [x] Harden and verify: two zone, daylight saving, invalid, cache, accessibility, and regression cases (AC-1 to AC-12)
- [x] Verify it: `/check verify business timezone` — all 12 acceptance criteria met; API, onboarding, settings, two zone, midnight, corrupt data, cache, and backend down checks pass; tests, lint, typecheck, format, and build clean. See [verify.md](../specs/0008-business-timezone/verify.md). Re-verified 2026-10-31 after the logo fix: the live column, a wizard completed without a logo, every business read path answering `null`, and the full browser suite pass.
- [x] Test it: `/test business timezone` — 387 backend (1 skipped), 277 frontend and 112 contract tests pass; added shell day and mobile menu, customer detail timestamps, auth subscription, business day warning, draft race guard, validated settings write, dialog focus trap, token refetch, storage failure, daylight saving, next render after midnight, in flight business switch, the AC-5 and AC-6 field, baseline, corrupt value, and unchanged save coverage, a draft save that answers 409 once onboarding is complete, the post sign in destination that sends a finished owner to the dashboard, a corrupt response schema that still reads, the onboarding read that returns the stored and draft zone, browser prefill and draft resume, a corrupt stored zone falling back to Asia/Dhaka, and two browser zones agreeing on one business timestamp and badge; lint, typecheck and format clean. E2E specs pass on desktop and mobile: 42 passed, including a business on `Pacific/Kiritimati` proving the badge and timestamps use the business zone, and a sign in that never shows the wizard to a completed owner.
- [x] Review it (fresh model): `/check review business timezone` — See [2026-10-29-feat-business-timezone.md](../reviews/2026-10-29-feat-business-timezone.md), approve with nits on GLM-5.3-Flash, all suites rerun; every open finding from the four earlier passes is fixed and pinned by a named test. Earlier passes: [2026-10-26](../reviews/2026-10-26-feat-business-timezone.md), [2026-10-27](../reviews/2026-10-27-feat-business-timezone.md), [2026-10-28](../reviews/2026-10-28-feat-business-timezone.md), [2026-10-28 2](../reviews/2026-10-28-feat-business-timezone-2.md), [2026-10-28 3](../reviews/2026-10-28-feat-business-timezone-3.md); the stale draft guard and the validated settings write all hold. Whole branch pass: [2026-10-31](../reviews/2026-10-31-feat-business-timezone-review.md), approve with nits on GLM-5.3-Flash, 1 minor and 8 nits, no blockers; the three minors from [2026-10-30](../reviews/2026-10-30-feat-business-timezone-whole-branch.md) are fixed and pinned by tests. The one 2026-10-31 minor is fixed too: a logo cleared at onboarding reads as `null` from the repository up, pinned by integration and contract tests. Second pass the same day: [2026-10-31 review 2](../reviews/2026-10-31-feat-business-timezone-review-2.md), approve with nits on GLM-5.3-Flash, 1 minor and 8 nits, no blockers; the logo fix holds on every read path, and the one minor is stale test fixtures that still use the empty string. That minor is fixed too: the onboarding and route test fixtures now use the shapes the API and entity produce. Third pass the same day, after `/check verify` and a full suite run: [2026-10-31 review 3](../reviews/2026-10-31-feat-business-timezone-review-3.md), approve with nits on GLM-5.3-Flash, 0 minors and 9 nits, no blockers; all four earlier findings are re-verified as holding and the open items are cleanup (dead statements, one duplicated pattern, one comment naming an error code that does not exist). All nine nits from that third pass are now cleared: dead statements and the duplicate export removed, the fallback operator aligned, the comment quoting the real error payload, the draft typed from the contracts, the suppression explained, the backend zone check reusing the contracts helper, the zone to country map pinned by a test, and the customer profile using the shared money format with its browser test updated. Fourth pass the same day, after the nit sweep: [2026-10-31 review 4](../reviews/2026-10-31-feat-business-timezone-review-4.md), approve on GLM-5.3-Flash with 1 nit, no blockers, majors or minors; all nine nits verified genuinely closed in code and tests, every earlier fix re-verified as holding, and the one suspected regression (the backend zone check now accepting padded zone strings) refuted because the previous local copy also trimmed. The one nit, a stale frontend test count in the spec verify notes, is fixed.
- [x] Document it: `/document business timezone` — See [2026-10-29-feat-business-timezone.md](../PRs/2026-10-29-feat-business-timezone.md). Merged in [PR #22](https://github.com/ZynoCodex/f-commerce/pull/22), whose body is the current description of the shipped change.

### 23. Team & staff invites · in-progress

Finish the staff invite that spec 0003 AC-5 requires. `POST /api/auth/invite` already creates an `INVITED` business member, but nothing delivers the invite, nothing accepts it, `INVITED` never becomes `ACTIVE`, and there is no team screen. Owners manage staff from settings: invite by email, see pending and active members, and change or remove a member's role. Staff keep the permissions the other slices already grant them.

**Done when:** an owner invites a staff member by email, the invitee accepts through a link and sets a password, the membership becomes `ACTIVE`, the invited person can sign in with the permissions of their role, and the owner can view, change, and remove members from a team screen. An invited membership that is never accepted grants no access.

- [x] Design it (spec): `/architect team & staff invites`
      Spec [0009](../specs/0009-team-staff-invites/index.md)
- [x] Build it: `/develop team & staff invites` (branch `feat/team-staff-invites`, [spec](../specs/0009-team-staff-invites/index.md), [verify](../specs/0009-team-staff-invites/verify.md))
  - [x] Data, contracts, and migration: invitations, membership status, case insensitive email, and legacy cleanup (AC-1, AC-5 to AC-8, AC-10, AC-14, AC-16, AC-18, AC-22)
  - [x] Thin invite path: team repository and service, active membership check, queue, worker, Resend, and public accept API (AC-1 to AC-4, AC-6 to AC-11, AC-14, AC-15, AC-17, AC-19, AC-20, AC-23, AC-24)
  - [x] Team and invite screens: member list, pending invites, invite dialog, copy link, poll, and accept states (AC-1, AC-5 to AC-9, AC-21)
  - [x] Manage and harden: resend, cancel, role change, removal, token protections, audit, and access denial handling (AC-2, AC-4, AC-12 to AC-16, AC-18 to AC-20, AC-22, AC-24)
  - [x] Deploy and test: root dev, worker start, CI with Redis and worker, deployment notes, and the full test matrix (AC-1 to AC-24)
- [ ] Verify it: `/check verify team & staff invites`
- [x] Test it: `/test team & staff invites` — backend 506 passed, 1 skipped; frontend 315 passed; contracts 119 passed. Added the write and preview rate limit cases (AC-24), the full owner only route matrix and self removal (AC-2, AC-15), the last owner demotion and removal race (AC-14, AC-15), and AC traceability headers on the team test files.
- [x] Review it (fresh model): `/check review team & staff invites` — See [2026-11-03-feat-team-staff-invites.md](../reviews/2026-11-03-feat-team-staff-invites.md), changes requested on GLM-5.3-Flash-Free; no blockers, 1 major (the accept transaction ignores the locked invitation state), 7 minors, 8 nits. Fresh pass after all findings were fixed: [2026-11-04-feat-team-staff-invites.md](../reviews/2026-11-04-feat-team-staff-invites.md), approve on grok-4.7, no blockers, majors, minors, or verified nits. Follow-up passes on GLM-5.3-Flash-Free: [b](../reviews/2026-11-04-feat-team-staff-invites-b.md) blocked on the invite Referrer-Policy and a signed in password reset hole; [c](../reviews/2026-11-04-feat-team-staff-invites-c.md) changes requested on an AC-9 passwordless regression introduced by the reset fix; [d](../reviews/2026-11-04-feat-team-staff-invites-d.md) approve with nits, no blockers or majors, 3 minors and 5 nits, every earlier finding verified fixed and pinned by a test. Latest whole branch pass on Crouton Alpha: [2026-11-08 c](../reviews/2026-11-08-feat-team-staff-invites-c.md), approve with nits, no blockers or majors, 5 minors and 4 nits. New whole branch pass on Crouton Alpha at [2026-11-08 d](../reviews/2026-11-08-feat-team-staff-invites-d.md), approve with nits, no blockers or majors, 5 minors and 4 nits. Latest pass: [2026-11-10 b](../reviews/2026-11-10-feat-team-staff-invites-b.md), approve with nits on GLM 5.3 Flash Free, no blockers or majors, 1 minor and 5 nits; the three minors from the earlier 2026-11-10 pass are fixed at HEAD. Latest pass: [2026-11-11](../reviews/2026-11-11-feat-team-staff-invites.md), approve with nits on MiniMax-M2.7, no blockers or majors, 2 minors and 3 nits. Whole branch pass including uncommitted work: [2026-11-11 b](../reviews/2026-11-11-feat-team-staff-invites-b.md), approve with nits on GLM-5.3-Flash-Free, no blockers or majors, 4 minors and 4 nits.
- [ ] Document it: `/document team & staff invites`

## Slice 2: Product & Order Workflow

### 8. Products & categories · done

Product CRUD with images, SKU, stock tracking, categories, low-stock thresholds, archive.
**Done when:** user can add products with variants, see stock status (in stock/low/out), and archive them.

- [x] Design it (spec): `/architect products`
      Spec [0006](../specs/0006-products-categories-variants/index.md)
- [x] Build it: `/develop products`
  - [x] Data, contracts and category foundation with indexes and backfill (AC-1, AC-3, AC-4, AC-8, AC-12, AC-14)
  - [x] Product create, list and search with derived stock, filters and cursor paging (AC-1, AC-2, AC-3, AC-4, AC-6, AC-7, AC-8, AC-13)
  - [x] Images, edits, archive, restore and hard delete with version and audit transactions (AC-5, AC-9, AC-10, AC-11, AC-14)
  - [x] Tenant guards, timeout handling and catalog screens for list, detail and variants (AC-6, AC-9, AC-10, AC-11, AC-12, AC-13, AC-15, AC-16)
- [x] Verify it: `/check verify products` — See [verify.md](../specs/0006-products-categories-variants/verify.md).
- [x] Test it: `/test products` — 290 backend, 87 frontend and 32 contract tests pass; typecheck, lint and format checks clean.
- [x] Review it (fresh model): `/check review products` — See [2026-10-21-feat-products.md](../reviews/2026-10-21-feat-products.md), approve with nits.
- [x] Document it: `/document products` — See [2026-10-21-feat-products.md](../PRs/2026-10-21-feat-products.md).

### 9. Orders (CRUD + status workflow) · done

Order creation from customer/product selection, status states, order history, source tracking, formula calculations.
**Done when:** user can create order in ~60 seconds, see status timeline, and order persists correctly.

- [x] Design it (spec): `/architect orders`
      Spec [0007](../specs/0007-orders/index.md)
- [x] Build it: `/develop orders`
  - [x] Data, contracts and migration: snapshots, version, line identity, history, counters, indexes and backfills (AC-2, AC-3, AC-11, AC-17)
  - [x] Create path and first screens: transactional create with counter, merging, totals and audit, plus `/orders`, `/orders/new` and a minimal detail page (AC-1, AC-2, AC-4, AC-11, AC-17)
  - [x] Detail, timeline, search and paging: stored snapshots, history, status filters, digit phone search, cursor binding and Load more (AC-7, AC-8, AC-14, AC-16, AC-18)
  - [x] Edits, concurrency and workflow: `lineId` replacement, version guards, transition table, history rows and in place edit (AC-3, AC-9, AC-10, AC-13, AC-16, AC-18)
  - [x] Duplicate guard and hardening: idempotency replay, 24 hour warning, tenant and archived cases, rollback, accessibility and empty states (AC-5, AC-6, AC-12, AC-13, AC-14, AC-15, AC-16, AC-17)
  - [x] Promised delivery date: nullable `delivery_deadline` date column in string mode, `deliveryDeadline` on the create, update, list, and detail contracts, the form field with a clear control, the date only formatter and `localToday()` helper, the derived `Overdue` badge, and the edit lock and audit (AC-1, AC-7, AC-8, AC-9, AC-11, AC-14, AC-15, AC-16, AC-17, AC-19)
        Code in `packages/contracts/src/order.ts`, `backend/src/application/services/order.service.ts`, `backend/src/presentation/controllers/order.controller.ts`, `frontend/src/app/orders/`, `frontend/src/components/orders/order-deadline.tsx`
- [x] Verify it: `/check verify orders` — all 19 acceptance criteria verified at runtime; backend, frontend and contract suites pass; lint, typecheck, format and build clean. See [verify.md](../specs/0007-orders/verify.md).
- [x] Test it: `/test orders` — 362 backend, 166 frontend and 93 contract tests pass; 6 orders E2E runs pass on desktop and mobile; typecheck, lint and format checks clean.
- [x] Review it (fresh model): `/check review orders` — See [2026-10-24-feat-orders.md](../reviews/2026-10-24-feat-orders.md)
- [x] Document it: `/document orders` — See [2026-10-25-feat-orders.md](../PRs/2026-10-25-feat-orders.md)

### 10. Payments · needs a decision

Payment methods (cash, cash on delivery, bKash, Nagad, bank transfer, debit or credit card, PayPal, and other; bKash and Nagad are Bangladesh only), partial and full payments, due tracking, payment records. Order creation also captures the first payment and its method, so the money taken at the sale is recorded against the order it pays for.
**Done when:** user can capture a first payment and its method while creating an order, add later payments against the same order, and see the correct paid and due amounts.

- [ ] Design it (spec): `/architect payments`

### 21. Product variant archiving · needs a decision

Let a seller retire a variant without deleting it, so past order lines keep a live reference and a later restock or restore can find it again.
**Done when:** an archived variant leaves the new order and product pickers, stays readable on old orders through its stored label, and can be restored with its identity and SKU intact.

- [ ] Design it (spec): `/architect product variant archiving`

## Slice 3: OAuth login

### 19. OAuth provider login · needs a decision

Real Google and Facebook sign in end to end: the backend verifies the provider token and links the identity to an existing account by email, and the sign in screen offers both provider buttons. This replaces the development mock route, which returns 501 in production.
**Done when:** a seller signs in with Google or Facebook through the browser, an existing email account links rather than fails (spec 0003 AC-6), a bad or expired provider token is rejected, and the mock route is gone.

- [ ] Design it (spec): `/architect oauth provider login`

## Slice 4: Inventory & Financials

### 11. Inventory management · needs a decision

Stock reservation on create, deduction on confirm, restoration on cancel/return, transaction history.
**Done when:** inventory transactions are auditable and negative stock is prevented.

- [ ] Design it (spec): `/architect inventory`

### 12. Delivery & shipping · needs a decision

Courier selection, tracking number, shipping address, delivery status history (manual tracking for MVP).
**Done when:** user can assign courier, track delivery progress, and see status changes.

- [ ] Design it (spec): `/architect delivery`

### 13. Expenses & profit calculation · needs a decision

Expense categories, expense CRUD, profit formula (revenue - cost - delivery - expenses).
**Done when:** user can record expenses and see accurate profit on dashboard.

- [ ] Design it (spec): `/architect expenses & profit`

### 14. Dashboard · needs a decision

Mobile-first dashboard with sales summary, order summary, financial summary, inventory status, recent orders.
**Done when:** user sees aggregated metrics on both mobile and desktop.

- [ ] Design it (spec): `/architect dashboard`

## Slice 5: Reporting & Polish

### 15. Reports · needs a decision

Sales, orders, products, customer, source reports with date filters.
**Done when:** user can generate each report type with appropriate metrics.

- [ ] Design it (spec): `/architect reports`

### 16. Search & filters · needs a decision

Global search (order number, customer, product, tracking); order/product/customer filters.
**Done when:** user finds records quickly with debounced search and persistent filter state.

- [ ] Design it (spec): `/architect search & filters`

### 17. Notifications · needs a decision

Email/SMS notifications for order updates, payment reminders, low stock alerts.
**Done when:** user receives configured notifications through their email/SMS.

- [ ] Design it (spec): `/architect notifications`

### 18. Invoice generation · needs a decision

Printable invoice with business info, customer info, items, totals, payment method.
**Done when:** user can print invoice or save as PDF via browser print.

- [ ] Design it (spec): `/architect invoices`

## Launch

### 20. Marketing site · needs a decision

A public multipage site that explains the product, builds trust, and sends visitors into sign up. The first version covers Home, Features, Pricing, About, Contact, FAQ, Customer Stories, Privacy, and Terms. The pricing page presents the plans and a sign up path while subscription billing stays deferred.

**Done when:** Home is the public root route and every listed page is reachable from shared public navigation, works on mobile and desktop, has a clear call to action, and routes interested visitors to register or sign in while signed in sellers can reach the dashboard.

- [ ] Design it (spec): `/architect marketing site`

## /scope replan · F-Commerce Order Manager

**3 foundation features are in the current pass (1 done, 2 in progress, 0 deferred), build approach Tracer Bullet, workflow GA.**
Next: `/develop data model`, then `/check verify tooling`, then `/architect design system & UI foundation`
Heads up: the backend scaffold smoke test currently times out while waiting for the startup message. Frontend and contracts tests pass. The remaining product work includes the UI system, auth, onboarding, and the data model build path. Scope written to `docs/scope/scope.md`.

## Legend

**The decision box.** Every feature carries exactly one, the sub-task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally, `Decide the stack (spec)` on Stack & architecture), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle:** the scope updates as a feature moves; each row is what it shows and who sets it:

| State                    | Set by                           | The feature shows                                                            |
| ------------------------ | -------------------------------- | ---------------------------------------------------------------------------- |
| `planned`                | `/scope`                         | one box: `Design it (spec): /architect <feature>`                            |
| `in-progress` (designed) | **`/architect` at spec capture** | `Design it` ticked; spec linked; `Build it: /develop <feature>` + milestones |
| `in-progress` (building) | `/develop`                       | milestone sub-boxes tick one by one                                          |
| `in-progress` (verified) | `/check verify`                  | `Build it` + milestones ticked; `Verify it` ticked                           |
| `done`                   | **you, when you decide it is**   | boxes you ran ticked; tier's last stage completed                            |

- **Approach tag** beside heading overrides project default for that feature.
- **Workflow tier tag** sets one feature's rigor (GA = verify, test, review, document).
- **Pointer line** (`spec <n> · code in <path>`) appears only after those exist.

## Deferred

Out of scope for the current build pass, kept so the plan stays honest.

- **Subscription billing**: integrate Stripe/checkout once MVP proves fit
- **Courier API integrations**: live tracking once core workflow is stable
- **Social channel APIs**: Facebook/WhatsApp order import via future integrations
- **Advanced analytics**: AI insights after basic reporting works
- **Platform admin console**: a console for the people who run F-Commerce itself, deferred until the MVP proves fit. It is the first feature that may read across tenants, so it needs its own admin role, its own audit trail naming the admin, the target, and what changed, and a deliberate route around the tenant isolation that every seller-facing query enforces. The first version covers finding and opening any business or user, resetting a locked-out account, and the support actions existing slices already assume someone can do by hand, such as cleaning up orphaned Cloudinary assets. Seller-facing isolation must stay unchanged, and a business OWNER or STAFF gets 403 on every admin route
- **Team follow-ups from spec 0009**: Resend bounce and complaint webhooks, an invitation retention job, email delivery metrics and alerts, team seat limits when plans and billing exist, an owner leave business flow, OAuth only acceptance when real OAuth ships, a team history view for accepted, revoked, and removed members, and dropping the redundant case sensitive `users.email` unique constraint once a migration can be scheduled (identity is already enforced by `users_email_lower_unq`), and a periodic sweep of expired buckets in the in process rate limit fallback so memory does not wait for a thousand keys. None blocks the invite slice.
- **Follow-ups moved from `nextTask.txt`**: update the product count after an order confirmed or returned; block disposable or temporary mail addresses at registration in production; use the logo already placed at `frontend/public/images/Logo.png`; replace the silent skeleton loading state at `frontend/src/app/products/page.tsx:662` and `frontend/src/app/customers/page.tsx:301`; and type `createdAt` and `updatedAt` in `packages/contracts/src/customer.ts`, `order.ts`, and `product.ts` instead of plain strings.
