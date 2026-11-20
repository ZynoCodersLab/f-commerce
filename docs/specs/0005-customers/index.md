# 0005. Customer records with search, order history, and archive

**Date**: 2026-10-14
**Status**: Accepted

> **Note (2026-10-18)**: Archive and restore still commit the state change and exactly one audit entry together, now as a PostgreSQL transaction through Drizzle. Local development and CI no longer need a MongoDB replica set: `docker-compose.yml` runs PostgreSQL 18 and `.github/workflows/ci.yml` starts a `postgres:18` container and applies `backend/drizzle/migrations` before the backend starts. Route and repository tests run against a real PostgreSQL database (`src/test-support/pg-test-database.ts`).

## Summary

Each buyer gets one customer record in the business, found by name or phone, and their profile shows their orders and total spend. Phone numbers must include the country code and can belong to only one customer in the business. Customers are archived instead of deleted, so their orders stay linked and they can come back later, and every archive and restore is written to an audit log.

## Requirements

**User stories**:

- As an owner or staff member, I want to add a buyer with a name and phone so that I can record who I sell to.
- As an owner or staff member, I want to edit a buyer's details so that they stay correct.
- As an owner or staff member, I want to search buyers by name or phone so that I find them quickly.
- As an owner or staff member, I want to open a buyer's profile with a tappable phone number, their orders, and their spend so that I can call them and see their history.
- As an owner or staff member, I want to archive a buyer I no longer serve and restore them later so that my lists stay clean without losing their orders.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: An owner or staff member can create a customer with name (1 to 120 characters after trimming) and phone required, and email (valid email format per Zod `z.string().email()`, which follows the HTML5 email grammar), address (up to 500 characters), and notes (up to 500 characters) optional. Text fields are trimmed. Omitted, `null`, and blank optional fields are stored as absent; an empty or invalid required field, or an invalid nonblank optional field, returns 400 with `VALIDATION_ERROR` and `"fields"` naming the invalid fields. The response is 201 with the saved customer at version 1.
- **AC-2**: A phone must start with a plus sign followed by 8 to 15 digits. Spaces, dashes, and parentheses are removed before the check, and Bengali digits (০-৯) are normalized to ASCII digits. The stored value is the cleaned form. Any other phone returns 400 with `VALIDATION_ERROR` and `"fields": ["phone"]`, and nothing is saved.
- **AC-3**: Creating a customer whose cleaned phone already exists in the business returns 409 `DUPLICATE_PHONE`. The response body is `{ "error": "DUPLICATE_PHONE", "message": "...", "existingCustomerId": "<id>", "archived": <boolean> }`. This response is the same whether the duplicate is found by the initial lookup or by the unique index after a concurrent create. Nothing is saved. The form keeps the values the seller typed and links to the existing customer's profile. If the existing customer is archived, the screen says so and offers restore after loading the archived profile and its current version.
- **AC-4**: An edit saves only when the `version` sent matches the stored version. Omitted fields are unchanged. Text fields are trimmed before any comparison or write. `null` or blank email, address, or notes clears that optional field. Name and phone cannot be cleared, and their create validation rules also apply on edit. Email and length validation match AC-1. Editing an archived customer returns 409 `CUSTOMER_ARCHIVED` before the version check (see AC-8). A duplicate phone, including one detected by the unique index after a concurrent edit, returns 409 `DUPLICATE_PHONE` with the existing customer's id and archived state. A matching version with an actual change (after trimming) saves and raises `version` by exactly 1. A matching version whose trimmed values match the stored values is a no-op and returns the current customer without writing or incrementing the version. A stale version returns 409 `CUSTOMER_CHANGED` and changes nothing.
- **AC-5**: Search returns customers in the business that are not archived and whose name starts with the trimmed search text (ignoring case) or whose phone starts with the search text. Name matching uses the original trimmed text; the phone-prefix branch separately removes spaces, dashes, and parentheses and normalizes Bengali digits to ASCII, without requiring a complete phone number. The phone-prefix branch applies only when its cleaned query contains at least one digit and otherwise consists of an optional leading plus sign and digits. Missing or whitespace-only `q` returns all non-archived customers. A nonblank query that cannot form a phone prefix still searches by its trimmed name text. Results are sorted by name ascending, then by `_id` ascending, and paged at 20 by default with a maximum of 50. The opaque base64url cursor contains the last `name` and `_id`, the trimmed query, and the effective page size. A cursor is malformed if it is not valid base64url, does not decode to valid JSON, or is missing any of the required encoded fields (`name`, `_id`, trimmed query, effective page size); a malformed cursor or one used with a different query or effective page size returns 400 `VALIDATION_ERROR` with `"fields": ["cursor"]`. An empty result shows its own message.
- **AC-6**: The profile shows name, phone as a tappable `tel:` link, email, address, notes, and a spend summary (order count, total spent, total due) in the business currency. The summary counts only orders whose `status` is not `CANCELLED` or `RETURNED` (the `OrderStatus` values from `backend/src/domain/entities/order.entity.ts`; see spec 0009 for the full status list). A customer id that does not exist in the business returns 404.
- **AC-7**: The order history lists the customer's orders newest first, showing order number, date, status, total (`total` field), and due amount (`dueAmount` field). It is paged at 20 by default with a maximum of 50. Results are sorted by `createdAt` descending, then by `_id` descending. The opaque base64url cursor contains the last `createdAt` and `_id`, plus the effective page size. A cursor is malformed if it is not valid base64url, does not decode to valid JSON, or is missing any of the required encoded fields (`createdAt`, `_id`, effective page size); a malformed cursor or one used with a different effective page size returns 400 `VALIDATION_ERROR` with `"fields": ["cursor"]`. A customer id that does not exist in the business returns 404.
- **AC-8**: Archiving sets `archivedAt` and hides the customer from search. Their orders and profile stay reachable. An archived customer cannot be edited and returns 409 `CUSTOMER_ARCHIVED`. Archiving an already-archived customer (with a matching version) also returns 409 `CUSTOMER_ARCHIVED` and writes nothing.
- **AC-9**: Restoring clears `archivedAt` and returns the customer to search. If the customer is not archived, restore returns 409 `CUSTOMER_NOT_ARCHIVED` with the response body `{ "error": "CUSTOMER_NOT_ARCHIVED", "message": "..." }` and changes nothing. If another live customer in the business holds the same phone, restore returns 409 `PHONE_IN_USE` with the response body `{ "error": "PHONE_IN_USE", "message": "...", "liveCustomerId": "<id>" }` and changes nothing.
- **AC-10**: Each archive and each restore commits exactly one audit entry with the acting user, the action, the customer id, the business id, and the time, atomically with the customer state change. If either write fails, the request returns 500 and neither change is committed.
- **AC-11**: Owners and staff can use every customer function. People outside the business get 403, and a customer id from another business returns 404, the same as an unknown id.
- **AC-12**: Orders already linked to a customer remain linked without migration. Any legacy order with no `customerId` remains unassigned and is excluded from customer profiles, spend totals, and order history; no customer is inferred. New orders continue to require a customer.

<!-- Every task in ## Build plan references the AC(s) it satisfies, and every scenario in
     Critical test scenarios maps to an AC. No AC without a build task; no build task without an AC. -->

## Decision

**Chosen option**: Option 2: Archive with an archivedAt date

Customers are archived by setting an `archivedAt` date. Archiving hides them from search, keeps their orders, and restore reverses it.

The options weighed and the reasoning behind this choice are in [rationale.md](./rationale.md).

## Feature design

**Data model sketch**:

- `Customer` (collection `customers`, extends `TenantEntity`)
  - `businessId`: required, taken from request context
  - `name`: required, 1 to 120 characters after trimming
  - `phone`: required, cleaned form of `+` followed by 8 to 15 digits, unique per business (archived records included)
  - `email`: optional, valid email format
  - `address`: optional, up to 500 characters
  - `notes`: optional, up to 500 characters
  - `archivedAt`: optional date, empty when active
  - `version`: required integer, starts at 1
  - `createdAt`, `updatedAt`: from `BaseEntity`
  - Indexes: unique `{ businessId: 1, phone: 1 }` (existing); `{ businessId: 1, name: 1 }` with collation `{ locale: 'en', strength: 2 }` (new)
- `Order` (existing, `customerId` required): new index `{ businessId: 1, customerId: 1, createdAt: -1 }` for order history. It serves the customer lookup and the newest first sort in one index.
- `AuditLog` (existing collection `auditlogs`): extend the existing model with `businessId`, `userId` (existing field, not `actorUserId`), `action` (`CUSTOMER_ARCHIVED` or `CUSTOMER_RESTORED`), `entityType` (`CUSTOMER`), `entityId`, `createdAt`. Scoped to the business and write once: the application never updates or deletes entries. Add the index `{ businessId: 1, entityType: 1, entityId: 1, createdAt: -1 }` to the existing indexes. The existing TTL index retains entries for 365 days; customer archive and restore entries follow this retention policy.

**State transitions**:

- Active to Archived: archive request with the current version. Sets `archivedAt`, raises `version`, writes an audit entry.
- Archived to Active: restore request with the current version. Clears `archivedAt`, raises `version`, writes an audit entry.
- Edits are allowed only while Active. Neither transition changes orders.

**API surface**:

Successful bodies use the endpoint-specific payloads. Errors use `{ "error": "<CODE>", "message": "<plain message>" }`; validation errors (400) also include a `fields` array naming the invalid fields. This is a new convention: existing controllers use human sentences in `error`, not uppercase codes. The customer feature introduces codes like `VALIDATION_ERROR`, `DUPLICATE_PHONE`, and `CUSTOMER_CHANGED`. Existing controllers may be migrated to this shape in a follow-up, but both shapes coexist until then. Every route requires a bearer token, the `x-business-id` header, and the `OWNER` or `STAFF` role.

| Endpoint                   | Method | Key inputs                                     | Key outputs                                          | Auth         | Key errors                                                                            |
| -------------------------- | ------ | ---------------------------------------------- | ---------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| /api/customers             | POST   | name (req), phone (req), email, address, notes | customer at version 1                                | bearer, role | 400, 403, 409 DUPLICATE_PHONE                                                         |
| /api/customers             | GET    | q, limit (default 20, max 50), cursor          | items, nextCursor (null when no next page)           | bearer, role | 400, 403                                                                              |
| /api/customers/:id         | GET    | id                                             | customer, orderCount, totalSpent, totalDue, currency | bearer, role | 400, 403, 404                                                                         |
| /api/customers/:id         | PATCH  | version (req), any editable field              | customer at new version                              | bearer, role | 400, 403, 404, 409 CUSTOMER_CHANGED, 409 CUSTOMER_ARCHIVED, 409 DUPLICATE_PHONE       |
| /api/customers/:id/orders  | GET    | limit (default 20, max 50), cursor             | items, nextCursor (null when no next page)           | bearer, role | 400, 403, 404                                                                         |
| /api/customers/:id/archive | POST   | version (req)                                  | customer with archivedAt set                         | bearer, role | 400, 403, 404, 409 CUSTOMER_CHANGED, 409 CUSTOMER_ARCHIVED, 500                       |
| /api/customers/:id/restore | POST   | version (req)                                  | customer with archivedAt cleared                     | bearer, role | 400, 403, 404, 409 CUSTOMER_CHANGED, 409 CUSTOMER_NOT_ARCHIVED, 409 PHONE_IN_USE, 500 |

**Value sourcing** (every value each action produces, computes, or displays names where it comes from):

| Action                | Value produced / displayed                       | Source                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create, all           | businessId                                       | request context set by `requireBusinessRole`                                                                                                                                                 |
| Create, all           | name, phone, email, address, notes               | request body; phone cleaned by the `Customer` entity                                                                                                                                         |
| Create, all           | id, version, archivedAt, createdAt               | server: generated id, 1, empty, current time                                                                                                                                                 |
| Create, duplicate     | existingCustomerId, archived                     | lookup by businessId and cleaned phone, including a lookup after a duplicate-key race                                                                                                        |
| Edit                  | version to compare                               | request body `version` against the stored `version`                                                                                                                                          |
| Edit                  | new version                                      | stored version plus 1, written in the same conditional update; no-op edits keep the stored version                                                                                           |
| Edit, duplicate       | existingCustomerId, archived                     | lookup by businessId and cleaned phone after a unique-index conflict, excluding the edited id                                                                                                |
| Search results        | name, phone, id                                  | `customers` collection filtered to businessId and empty `archivedAt`                                                                                                                         |
| Search paging         | default limit, next cursor                       | server default of 20; query fetches one extra result to determine nextCursor, which is null when no more results exist; cursor encodes last name, id, trimmed query, and effective page size |
| Profile               | orderCount, totalSpent, totalDue                 | `orderCount` is the count of orders not cancelled or returned; `totalSpent` is the sum of `total` across those orders; `totalDue` is the sum of `dueAmount` across those orders              |
| Profile               | currency                                         | business currency from spec 0004 (`Business` entity)                                                                                                                                         |
| Profile phone link    | `tel:` target                                    | stored cleaned phone                                                                                                                                                                         |
| Order history         | orderNumber, createdAt, status, total, dueAmount | `orders` collection for this customer, sorted by createdAt descending                                                                                                                        |
| Order history paging  | default limit, next cursor                       | server default of 20; query fetches one extra result to determine nextCursor, which is null when no more results exist; cursor encodes last createdAt, id, and effective page size           |
| Legacy order handling | profile totals and history membership            | orders with a `customerId`; unassigned legacy orders are excluded                                                                                                                            |
| Date display          | local date and time                              | the seller's browser timezone; the API sends UTC ISO strings                                                                                                                                 |
| Archive, restore      | actorUserId                                      | auth context from `requireBusinessRole`                                                                                                                                                      |
| Archive, restore      | action, customerId, businessId, createdAt        | action from the requested transition; customer and business from the scoped request; time from the server transaction                                                                        |
| Restore conflict      | liveCustomerId                                   | lookup by businessId and phone, excluding this id (cannot match today, see Consequences)                                                                                                     |

**Key invariants**:

- One customer per cleaned phone per business, archived records included.
- Phone is stored as `+` followed by 8 to 15 digits, with no spaces or punctuation.
- Name is required after trimming.
- `version` rises by exactly 1 on each successful write that changes customer data. A no-op edit does not write or increment it; a write with a stale version changes nothing.
- Edit checks run in this order: business scope and existence (404), archived state (409 `CUSTOMER_ARCHIVED`), version (409 `CUSTOMER_CHANGED`), phone uniqueness (409 `DUPLICATE_PHONE`).
- A duplicate-key error from a concurrent create or edit is mapped to `DUPLICATE_PHONE` by looking up the conflicting customer within the business. The response includes its id and archived state.
- Restore checks run in this order: business scope and existence (404), version (409 `CUSTOMER_CHANGED`), archived state (409 `CUSTOMER_NOT_ARCHIVED`), phone uniqueness (409 `PHONE_IN_USE`).
- Archive and restore run the customer update and audit insert in one MongoDB transaction. The deployment, including local development, must support transactions through a replica set. If either write fails, the transaction aborts and neither change is committed.
- Concurrent archive or restore requests with the same version: the first to reach the version check succeeds; the second finds a stale version and returns 409 `CUSTOMER_CHANGED`.
- Spend totals are computed at read time: `totalSpent` is the sum of `total` across orders not cancelled or returned; `totalDue` is the sum of `dueAmount` across the same orders.
- Every query filters on the business id from request context. A different business id returns 404.
- `limit` defaults to 20; values above 50 are clamped to 50, not rejected. Cursors are opaque base64url JSON with the fields specified in AC-5 and AC-7. Invalid cursors or cursors reused with a different query or page size return 400 `VALIDATION_ERROR`.
- Malformed `:id` (non-ObjectId) returns 404, not 400, to avoid leaking whether an id exists.
- `GET /api/customers` with empty or missing `q` returns all non-archived customers in the business.
- Orders without `customerId` are excluded from customer profiles, totals, and history; new orders continue to require it.
- Client requests time out after 10 seconds. There are no automatic retries. After an archive or restore timeout, the client reloads the customer and reconciles the returned state and version; it does not assume the operation failed. A double submit on create is safe, because the second submit hits the unique phone index and gets 409 `DUPLICATE_PHONE`.

**Security model**:

- Roles `OWNER` and `STAFF` can create, edit, search, view profiles and order history with totals, archive, and restore. Enforced by `requireBusinessRole(['OWNER', 'STAFF'])` on every customer route.
- Inferred: `STAFF` can see order history and totals. The seller confirmed `STAFF` sees totals, and spec 0003 gives `STAFF` read access to business data.
- Confirmed (2026-11-21): `STAFF` can see and edit customer notes.
- People outside the business get 403 from the membership check. Customer ids from another business return 404.
- Customer personal data (name, phone, email, address, notes) is not written to application logs. Audit entries store ids and the action, not personal fields.
- Audit entries are write once.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):

- Happy path: create a customer with a `+880` phone, find them by name prefix, edit with the current version, open the profile to see orders newest first and the spend summary, verifies **AC-1**, **AC-4**, **AC-5**, **AC-6**, **AC-7**
- Failure case: two edits sent with the same version. The second returns 409 `CUSTOMER_CHANGED`, and the stored record matches the first save, verifies **AC-4**
- Failure case: create with a phone that already exists returns 409 `DUPLICATE_PHONE` with the existing id, and no customer is saved. Create with an archived customer's phone returns the `archived` flag, verifies **AC-3**
- Concurrency case: two creates or edits race to claim one phone. The losing request returns `DUPLICATE_PHONE` with the winning customer's id and archived state, verifies **AC-3**, **AC-4**
- Edit case: omitted fields stay unchanged, `null` or blank optional fields clear, invalid values fail validation, and a no-op edit does not increment the version, verifies **AC-1**, **AC-4**
- Failure case: phone without a country code returns 400 and nothing is saved. Phone with Bengali digits (০-৯) is normalized and accepted, verifies **AC-2**
- Failure case: empty name returns 400 with `"fields": ["name"]`. Invalid email returns 400 with `"fields": ["email"]`, verifies **AC-1**
- Failure case: archive, then edit returns 409 `CUSTOMER_ARCHIVED`. Restore with the current version succeeds, and both actions write audit entries, verifies **AC-8**, **AC-9**, **AC-10**
- Transaction failure: if the audit insert fails during archive or restore, the customer state and audit entry both remain unchanged; after a client timeout, reloading the customer reveals the committed state and version, verifies **AC-10**
- Auth/permission: `STAFF` can create (201) and archive (200). A user outside the business gets 403. A customer id from another business returns 404, verifies **AC-11**
- Index check: the name search query uses the `{ businessId, name }` index, confirmed with an explain plan in the test suite, verifies **AC-5**
- Restore conflict: the `PHONE_IN_USE` branch is tested with a stubbed repository, because the unique index prevents the state from occurring in the database, verifies **AC-9**
- Empty state: search with no matches shows the empty message. Order history for a customer with no orders shows the empty message, verifies **AC-5**, **AC-7**
- Search: query with spaces or punctuation (e.g., `+880 17...`) matches the stored phone prefix; Bengali digits normalize; a non-phone query searches the trimmed name; punctuation-only input does not broaden to all phone matches; a missing query lists all active customers, verifies **AC-5**
- Cursor paging: default limit is 20; ties sort by the specified `_id` direction; malformed or mismatched cursors return 400, verifies **AC-5**, **AC-7**
- Legacy orders: a linked order appears in history and totals; an order without `customerId` remains excluded and is not assigned by migration, verifies **AC-6**, **AC-7**, **AC-12**
- Limit handling: `limit` above 50 is clamped to 50, not rejected, verifies **AC-5**, **AC-7**

## Build plan

1. Configure local and deployment MongoDB as replica sets so transactions are available. Extend the existing `AuditLog` model with the index `{ businessId, entityType, entityId, createdAt: -1 }` to support customer archive and restore queries. Keep the existing 365-day TTL retention policy, satisfies **AC-10**
2. Add `archivedAt`, `version`, and the `{ businessId, name }` collation index to `Customer`. Update the domain `Customer` entity interface to include these fields. Add the `{ businessId, customerId, createdAt }` index to `Order`. Include a one time backfill that sets `version` to 1 on existing customers using `bypassTenantIsolation: true` or `runWithContext`, satisfies **AC-4**, **AC-5**, **AC-7**, **AC-8**
3. Add customer request and response DTOs and error codes to `packages/contracts`. Add phone cleaning and search-prefix normalization in `backend/src/domain`, keeping the business rules in the domain layer, satisfies **AC-2**, **AC-5**
4. Create use case: validate, check for a duplicate phone, save at version 1, and map unique-index conflicts to `DUPLICATE_PHONE` with the existing id and archived flag, satisfies **AC-1**, **AC-3**
5. Edit use case: apply the create validation and field-clearing rules, check archived state then version then phone uniqueness, and map unique-index conflicts to `DUPLICATE_PHONE`. Save actual changes with the version raised by 1 in one conditional update; return no-op edits without writing, satisfies **AC-4**, **AC-8**
6. Search use case and `GET /api/customers` with name collation, separate partial phone-prefix normalization, default and maximum page sizes, stable sort, and validated opaque cursors, satisfies **AC-5**
7. Profile use case: read the customer and compute the spend summary from orders not cancelled or returned, satisfies **AC-6**
8. Order history use case and `GET /api/customers/:id/orders`, sorted newest first with validated opaque cursors; exclude legacy orders without `customerId` from history and totals, satisfies **AC-6**, **AC-7**, **AC-12**
9. Archive and restore use cases: conditional version update, `PHONE_IN_USE` guard on restore, and customer update plus audit insert in one transaction. After a timeout, reload current state rather than retry automatically, satisfies **AC-8**, **AC-9**, **AC-10**
10. Wire every customer route to `requireBusinessRole(['OWNER', 'STAFF'])`. Confirm that another business's id returns 404 through the tenant plugin, satisfies **AC-11**
11. Frontend customers page: search, create form that shows the duplicate block with a link to the existing record, and edit form that sends `version`. Use the shared loading, empty, and error states from spec 0001 (frontend), with its own empty messages for search and history, satisfies **AC-1**, **AC-3**, **AC-4**, **AC-5**
12. Frontend profile: tappable phone, spend summary, order history excluding unassigned legacy orders, and archive and restore actions that reload after a timeout, satisfies **AC-6**, **AC-7**, **AC-8**, **AC-9**, **AC-12**

## Consequences

**Positive**:

- Order history and totals always match recorded orders, because totals are computed on read.
- Stale edits cannot overwrite each other, and the rule is the same on every app instance.
- Archive is reversible, so a mistaken archive costs one click.
- Reuses the existing tenant plugin, role guard, and error shape, so no new patterns are needed.

**Negative / tradeoffs**:

- An archived buyer's phone stays reserved. A new buyer with that number must be handled by restoring the old record first.
- A duplicate phone blocks the create. A seller who enters a buyer twice must open the existing record and make any change there, which adds a step.
- Archive and restore require MongoDB transactions, so local development and deployed databases must run as replica sets. If either the state update or audit insert fails, neither commits.
- Restore's `PHONE_IN_USE` guard cannot trigger today, because the unique index already stops a second live record with the same phone. It stays as a guard in case archived phones are released.
- Name search matches prefixes only. Contains search needs a text index, which belongs to row 16.
- Spend summary is computed on each profile view. It is cheap at small business volume, but it grows with a buyer's order count, and there is no cache.

**Neutral**:

- Extends the existing `auditlogs` collection with a new index for customer archive and restore queries.
- Adds one new index to `orders` and one new index to `customers` (the name collation index; the phone index already exists), plus the `version` and `archivedAt` fields.
- One backfill for existing customer documents (`version` set to 1). Existing orders are not reassigned; legacy orders without a customer remain unassigned and are excluded.

## Follow-up

- [ ] Revisit phone reuse only if product policy changes. Releasing archived numbers requires a partial unique index on live records and makes the `PHONE_IN_USE` restore guard reachable.
- [x] Row 9 (orders) must reject new orders for archived customers. Closed by spec 0007 AC-13, which returns 409 `CUSTOMER_ARCHIVED` on create and on edit.
- [ ] Row 16 (search and filters) adds contains match search with a text index.
- [x] Confirm that `STAFF` can see customer notes (default in this spec: yes). Confirmed 2026-11-21: `STAFF` can see and edit customer notes.
