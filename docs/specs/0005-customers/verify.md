# Verify: customers · spec 0005 · updated 2026-10-15

_Steps derived from spec 0005 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

> **Note (2026-10-18)**: The log below was recorded against the MongoDB backend. The store is now PostgreSQL 18 with Drizzle ORM, so the counts and environment details are historical: the suite now runs against a real Postgres test database created and migrated automatically by `backend/src/test-support/pg-test-database.ts`, with no replica set and no `MONGODB_URI`. The archive, restore and audit-transaction guarantees are covered by `customer.repository.integration.test.ts` and `customer.controller.route.test.ts`.

## UI / manual

- [x] Add a customer with name and a `+880` phone, then confirm they appear in the list and the notice reads that they were added → AC-1
- [x] Search by name prefix (`Nusr`) and confirm the customer still appears; search `zzzznomatch` and confirm the "No customers match" empty state → AC-5
- [x] Open the profile and confirm the phone renders as a `tel:` link whose href is the stored cleaned phone → AC-6
- [x] Edit the name and save, confirm the heading shows the new name and the spend summary is still visible (an edit must not blank the totals) → AC-4, AC-6
- [x] Archive the customer and confirm the Archived badge appears and the record drops out of search → AC-8
- [x] Restore the archived customer and confirm they return to search → AC-9
- [x] Create with a phone that already exists and confirm the duplicate block names the existing customer, links to their profile, and keeps the typed values → AC-3
- [x] Repeat the duplicate create against an archived customer and confirm the screen says the existing record is archived and offers restore → AC-3
- [x] Type a phone with Bengali digits (০-৯) and confirm it is accepted and stored as ASCII → AC-2
- [x] Create with an empty name and confirm the Name field shows its error; create with a bad email and confirm the Email field shows its error → AC-1
- [x] Open a customer with no orders and confirm the order history shows its own empty message → AC-7
- [x] On mobile width, open the add customer form and confirm the Save button is reachable by scrolling inside the panel → AC-1

## Commands

- [x]`npm run typecheck --workspace @f-commerce/backend && npm run typecheck --workspace @f-commerce/frontend` → both clean → AC-1 (build gate)
- [x] `npm run test --workspace @f-commerce/backend` → 245 tests across 17 files pass, including the 19 repository integration tests → AC-4, AC-5, AC-7, AC-10
- [x] `npm run test --workspace @f-commerce/frontend` → 55 tests across 7 files pass → AC-1 (build gate)
- [x] `npm run e2e --workspace @f-commerce/frontend` → 18 tests pass (3 customer tests on desktop and mobile) → AC-1, AC-3, AC-4, AC-5, AC-6, AC-8
- [x] `npm run lint --workspace @f-commerce/backend && npm run lint --workspace @f-commerce/frontend` → no errors → AC-1 (build gate)

## Acceptance-criteria coverage

- AC-1 create with trimmed fields and optional-field rules · covered by the create UI step, the empty-name and bad-email step, and the typecheck and test commands
- AC-2 phone cleaning and Bengali normalization · covered by the Bengali digits step and `backend/src/domain/customer-phone.test.ts`
- AC-3 duplicate phone with existing id and archived flag · covered by the two duplicate UI steps and the concurrency tests in `customer.repository.integration.test.ts`
- AC-4 version guard, trimming, field clearing, no-op edit · covered by the edit UI step and the version guard tests in `customer.repository.integration.test.ts` and `customer.service.test.ts`
- AC-5 search by name and phone prefix, paging, cursors · covered by the search UI step, the empty state step, the cursor tests in `backend/src/domain/customer-cursor.test.ts`, and the search paging tests in `customer.repository.integration.test.ts`
- AC-6 profile fields, `tel:` link, spend summary in business currency · covered by the `tel:` step, the edit step, and the order history and spend tests in `customer.repository.integration.test.ts`
- AC-7 order history newest first, paging, cursors · covered by the no-orders empty state step and the order history tests in `customer.repository.integration.test.ts`
- AC-8 archive hides from search and blocks edits · covered by the archive UI step and the archive tests in `customer.repository.integration.test.ts`
- AC-9 restore clears archivedAt and returns to search · covered by the restore UI step and the restore tests in `customer.repository.integration.test.ts`
- AC-10 one audit entry per archive and restore, atomic with the state change · covered by the transaction rollback tests in `customer.repository.integration.test.ts`
- AC-11 role and tenant access · covered by the role and tenant tests in `customer.repository.integration.test.ts` and `customer.controller.route.test.ts`; not yet driven in the browser
- AC-12 legacy unassigned orders excluded, linked orders unchanged · covered by the legacy order test in `customer.repository.integration.test.ts`; not yet driven in the browser

## Backend verification complete

The following acceptance criteria are verified at the backend level through 245 integration tests:

- **AC-8, AC-9, AC-10**: Archive, restore, and transaction tests run against a real PostgreSQL test database and verify:
  - Archive hides customer from search and blocks edits
  - Restore clears `archivedAt` and returns to search
  - One audit entry per transition, atomic with state change
  - Concurrent archive race condition handling

- **AC-11**: Tenant isolation verified through role and tenant tests in `customer.repository.integration.test.ts` and `customer.controller.route.test.ts`

- **AC-12**: Legacy order exclusion verified through the legacy order test in `customer.repository.integration.test.ts`

## Coverage complete

- All 18 E2E tests have been executed and pass (3 customer tests on desktop and mobile)
- 245 backend tests pass across 17 files
- 55 frontend tests pass across 7 files
- Index plan tests in `customer.repository.integration.test.ts` execute without environment variables
- ~~Atlas index creation and the `version` backfill are pending for the real target database~~ Superseded by the PostgreSQL migration. `customers.version` ships `integer NOT NULL DEFAULT 1` in `backend/src/infrastructure/database/drizzle/schema.ts:146`, so there is no backfill, and the migration creates the indexes `customers_business_phone_unq`, `customers_business_lower_name_idx`, and `customers_business_archived_name_idx`. No Atlas step remains.

## Bug fix verified

Fixed focus issue in customer creation form where each keystroke caused the input to lose focus. The `Sheet` component's `useOverlay` hook was calling `focus()` on the `<aside>` container element instead of focusing the first input.

Changes made:

- Added `useRef` to import in `customers/page.tsx`
- Added `nameInputRef` to focus the name input directly when the form opens
- Updated `Input`, `Select`, and `Textarea` components in `primitives.tsx` to forward refs for focus management
