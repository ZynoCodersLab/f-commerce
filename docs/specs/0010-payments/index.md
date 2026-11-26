# 0010. Payments as an order ledger with refunds and voids

**Date**: 2026-11-27
**Status**: In Progress

## Summary

This feature lets a seller record money they have already received for an order (cash, cash on delivery, bKash, Nagad, bank transfer, card, PayPal, or other), either while creating the order or later, and always see the correct paid amount, due amount, and payment status. It is a record only ledger (a list of money entries per order): no payment gateway, no card data, and no PCI scope (the card industry security rules). Mistakes are fixed by voiding an entry with a reason, money given back is recorded as a refund entry, and a cancelled or returned order shows any money still held as Refund owed. A new `/payments` page lists every entry across orders with collected, refunded, and net totals.

## Requirements

**User stories**:

- As a seller, I want to record the advance or full payment while I create the order so that the money taken at the sale is attached to the order it pays for.
- As a seller, I want to add later payments to the same order so that partial payments and cash on delivery collections add up to the right due amount.
- As a seller, I want to see at a glance which orders still owe money so that I can follow up with the buyer.
- As an owner, I want to void a wrong entry and record refunds so that the books stay correct without deleting history.
- As an owner, I want a cancelled or returned order to show the money I still hold so that I remember to give it back.
- As a seller, I want one page listing every payment in a date range with totals so that I can check what I collected this month.
- As a staff member, I want to record payments so that the counter keeps moving when the owner is away, without being able to erase money from the books.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: `POST /api/orders` accepts an optional `initialPayment` object with `amount` (required integer), `method` (required payment method), `paymentDate` (optional `YYYY-MM-DD`), `referenceNumber` (optional), and `notes` (optional). Omitted or null means no payment. When present, the create transaction loads the active business currency and timezone, inserts one `PAYMENT` entry recorded by the current user with `idempotency_key` null, sets `paidAmount` to the amount and `dueAmount` to `total` minus the amount, and writes one `PAYMENT_RECORDED` audit row, all in the same transaction as the order, items, history, counter, and `ORDER_CREATED` audit row (whose metadata stays `{ orderNumber, total }` per spec 0007 AC-17). `CASH_ON_DELIVERY` is accepted as a first payment and counts toward paid immediately, like any other method. The 201 response is the full order including its `payments`, `paymentStatus`, and `refundOwed`.
- **AC-2**: A first payment whose amount is above the computed order `total` returns 400 `VALIDATION_ERROR` with `fields` naming `initialPayment.amount`, and nothing is written. The first payment follows the same field rules as AC-14 and the method rule of AC-13, reported with `initialPayment.<field>` names (while `items.*` stays collapsed to `items`). All `initialPayment` checks (fields, currency method, future date, and amount above total) run before the 24 hour duplicate check. A 409 `DUPLICATE_ORDER` writes nothing, including the payment; resending with `confirmDuplicate` true creates the order with its payment. An `Idempotency-Key` replay (spec 0007 AC-6) returns the stored order with its stored payments and never inserts a second payment, even when the replayed payload carries a different `initialPayment`.
- **AC-3**: `POST /api/orders/:id/payments` records a later `PAYMENT` entry with `amount` (required), `method` (required), `paymentDate` (optional), `referenceNumber` (optional), and `notes` (optional). It locks the order row, inserts the entry, recomputes `paidAmount` and `dueAmount` (AC-7), bumps the order `updatedAt`, does not change `version`, writes one `PAYMENT_RECORDED` audit row, all in one transaction, and returns 201 with the full order detail.
- **AC-4**: A new payment is accepted only while the order status is `PENDING`, `CONFIRMED`, `PROCESSING`, `SHIPPED`, or `DELIVERED`. A `CANCELLED` or `RETURNED` order returns 409 `ORDER_CLOSED`. An amount above the current `dueAmount` returns 409 `PAYMENT_EXCEEDS_DUE` with the current `dueAmount` in the body, so an order with due 0 accepts no payment. The status and due checks run after the order row is locked, so two concurrent payments that together exceed the due leave exactly one stored and the other rejected with 409.
- **AC-5**: `POST /api/orders/:id/refunds` records a `REFUND` entry with the same inputs as AC-3. Only `OWNER` may call it; `STAFF` gets 403. A refund is accepted in any order status. Its amount must not exceed the current `paidAmount` (live payments minus live refunds), else 409 `REFUND_EXCEEDS_PAID` with the current `paidAmount`. On an active order a refund lowers `paidAmount` and raises `dueAmount`; on a `CANCELLED` or `RETURNED` order it lowers `refundOwed`. Same lock, `updatedAt`, no version change, and transaction rules as AC-3, with one `REFUND_RECORDED` audit row. Returns 201 with the full order detail.
- **AC-6**: `POST /api/orders/:id/payments/:paymentId/void` accepts `reason` (required, 1 to 200 characters after trimming). Only `OWNER` may call it; `STAFF` gets 403. It locks the order row, sets `voidedAt`, `voidedByUserId`, `voidedByName`, and `voidReason` on the entry, recomputes the order totals, bumps the order `updatedAt` without changing `version`, and writes one `PAYMENT_VOIDED` audit row in one transaction. A void is allowed in any order status and cannot be undone. An already voided entry returns 409 `PAYMENT_ALREADY_VOIDED`. A void that would leave the recomputed `paidAmount` outside `0 <= paidAmount <= total` (in any order status, active or closed) returns 409 `VOID_BREAKS_BALANCE` with the current `paidAmount` and `total` and changes nothing. A `paymentId` that is malformed, unknown, from another order, or from another business returns 404 `NOT_FOUND`. Returns 200 with the full order detail.
- **AC-7**: For every order, `paidAmount` equals the sum of live (not voided) `PAYMENT` amounts minus the sum of live `REFUND` amounts, and `0 <= paidAmount <= total` always holds. On an active order (`PENDING` to `DELIVERED`), `dueAmount` equals `total` minus `paidAmount` and `refundOwed` is 0. On a `CANCELLED` or `RETURNED` order, `dueAmount` is 0 and `refundOwed` equals `paidAmount`. `paidAmount` and `dueAmount` are stored on the order and rewritten in the same transaction as every payment, refund, void, edit, and status change; `refundOwed` and `paymentStatus` are derived when read. The client never supplies any of them.
- **AC-8**: An order with payments can be cancelled or returned through the existing status endpoint (spec 0007 AC-10). The status change transaction locks the order row first (`FOR UPDATE`), checks transition validity then `version`, sets `dueAmount` to 0 when moving to `CANCELLED` or `RETURNED` alongside the existing stock movement, and returns the full order detail including `payments`, `paymentStatus`, and `refundOwed`. Payments are not touched, so `refundOwed` shows the money still held until refunds or voids bring it to 0.
- **AC-9**: `PATCH /api/orders/:id` (spec 0007 AC-9) locks the order row first (`FOR UPDATE`) and checks in order: `ORDER_LOCKED`, resolve edit lines and compute the new total, `TOTAL_BELOW_PAID` (409 with the current `paidAmount` when the new total is below the locked `paidAmount`, writing nothing), `ORDER_CHANGED` (stale version), then `CUSTOMER_ARCHIVED` when the customer changed. Any accepted edit that changes `total` rewrites `dueAmount` as `total` minus the locked `paidAmount`. Both a saved edit and a no op edit return the full order detail including `payments`, `paymentStatus`, and `refundOwed`.
- **AC-10**: Every order representation (create response, list row, detail) carries `paymentStatus`, derived from status, `total`, and `paidAmount`: on an active order `UNPAID` when `paidAmount` is 0 and `total` is above 0, `PARTIAL` when `paidAmount` is above 0 and below `total`, and `PAID` when `paidAmount` equals `total` (including a total of 0); on a `CANCELLED` or `RETURNED` order `REFUND_OWED` when `paidAmount` is above 0, else `NONE`. `GET /api/orders` accepts an optional `paymentStatus` query (one value or a comma separated list of `UNPAID`, `PARTIAL`, `PAID`, `REFUND_OWED`) combined with the existing `status` and `q` filters by AND. Passing `NONE` or any unknown value returns 400 `VALIDATION_ERROR` naming `paymentStatus`. The cursor is bound to the payment status set as well, and replaying it against a different set returns 400 `VALIDATION_ERROR` naming `cursor`. List rows also carry `paidAmount` and `refundOwed`. `GET /api/customers/:id/orders` stays unchanged, and customer `totalDue` continues to sum `orders.due_amount`.
- **AC-11**: `GET /api/orders/:id` adds `payments` (every entry for the order including voided ones, ordered by `paymentDate` then `createdAt` then `id`, oldest first), `refundOwed`, and `paymentStatus`. Each entry has `id`, `kind`, `amount`, `method`, `referenceNumber`, `notes`, `paymentDate` (`YYYY-MM-DD`), `recordedByName`, `createdAt`, `voidedAt`, `voidedByName`, and `voidReason`. Payment events never add rows to the status timeline.
- **AC-12**: The payment and refund endpoints accept an optional `Idempotency-Key` header of 1 to 100 characters; an empty or over length header returns 400 `VALIDATION_ERROR` with `fields` naming `Idempotency-Key`. After authentication, role check, header validation, and verifying the `:id` order exists in the active business (404 otherwise), the server looks up the key in the business before body validation. A key already used for an entry on the same order with the same `kind` (`PAYMENT` on `/payments`, `REFUND` on `/refunds`) returns 200 with the current order detail and inserts nothing, even when the payload differs. A key already used on a different order or with a different `kind` returns 409 `IDEMPOTENCY_KEY_CONFLICT`. Keys are unique per business across payments and refunds. When two requests race on one key, the loser rolls back, reads the stored entry, and returns 200 with the order detail if both order and kind match, or 409 `IDEMPOTENCY_KEY_CONFLICT` if either differs, so exactly one entry exists. The void endpoint ignores `Idempotency-Key`.
- **AC-13**: Payment methods are `CASH`, `CASH_ON_DELIVERY`, `BKASH`, `NAGAD`, `BANK_TRANSFER`, `CARD`, `PAYPAL`, and `OTHER`. `BKASH` and `NAGAD` are accepted for a new payment or refund only when the business currency is `BDT`; otherwise 400 `VALIDATION_ERROR` naming `method`. Existing entries keep and show their stored method whatever the current currency. Every write method select in the UI (create order, record payment, record refund) offers only the methods the server accepts for the business; the `/payments` filter select offers all eight methods so historical `BKASH` and `NAGAD` entries remain filterable after a currency change.
- **AC-14**: `amount` is an integer 1 to 100,000,000 in the business currency's whole units, the same unit as order totals. `paymentDate` is a real calendar date in `YYYY-MM-DD`; omitted, null, or blank stores the business's today (the calendar day in `businesses.timezone`, spec 0008). A date after the business's today returns 400 naming `paymentDate`; any past date is accepted, including one before the order was created. `referenceNumber` is at most 100 characters and `notes` at most 500 characters after trimming, and blank stores null. Every invalid input returns 400 `VALIDATION_ERROR` with `fields` and changes nothing.
- **AC-15**: Every recorded payment, recorded refund, and void writes exactly one `audit_logs` row in the same transaction, with entity type `PAYMENT`, the entry id, action `PAYMENT_RECORDED`, `REFUND_RECORDED`, or `PAYMENT_VOIDED`, and metadata with `orderId`, `orderNumber`, `kind`, `amount`, `method`, and for a void the `reason`. Each entry stores `recorded_by_user_id` and `recorded_by_name` from the current user when written, and a void stores the voiding user's id and name, so a later rename does not rewrite them. If any write in a request fails, nothing from that request is stored. Entries are never updated except to set the void fields once, and are never deleted.
- **AC-16**: Every route requires a bearer token and `x-business-id`, with the existing 401, 400, and 403 rules. `OWNER` and `STAFF` may record payments, record a first payment at create, read order payments, and read `/api/payments`. Only `OWNER` may record refunds and void entries; `STAFF` gets 403 before anything is read or written. Role middleware is applied per route (never stacked with a broader router middleware) so each request queries `business_members` once. Every query filters by the active business, and an order or entry from another business returns 404. `GET /api/business/me` returns the active member's database verified `role` (`OWNER` or `STAFF`) in `data.role`, and `BusinessSettingsProvider` exposes it so screens gate owner only controls from live server state.
- **AC-17**: `GET /api/payments` lists entries for the active business, newest first by `paymentDate` then `createdAt` then `id`. Optional query values are `from` and `to` (`YYYY-MM-DD`, inclusive business days; omitted `from` is the first day of the business's current month and omitted `to` is the business's today; future filter dates are accepted), `method` (one or a comma separated list), `kind` (`PAYMENT` or `REFUND`), `cursor`, and `limit` (1 to 50, default 20). `from` after `to`, or a range of more than 366 inclusive calendar days (`to` minus `from` is 366 or more days), returns 400 `VALIDATION_ERROR` with `fields` naming `from` and `to`. The response returns `items`, `summary`, and `nextCursor`. Each item has the entry fields from AC-11 plus `orderId`, `orderNumber`, and `customerName` (from `orders.customer_name_snapshot`). Voided entries are included and marked. `summary` carries `collected` (live `PAYMENT` sum), `refunded` (live `REFUND` sum), and `net` (`collected` minus `refunded`) for the whole filtered range (including any `kind` filter, so `kind=REFUND` yields `collected` 0 and negative `net`), excluding voided entries. The cursor carries the last item's sort keys plus the normalized filter fields (`from`, `to`, sorted methods, `kind`, `limit`), and replaying it against different filters returns 400 naming `cursor`.
- **AC-18**: `/orders/new` shows a Payment received section under the totals with amount (blank means no payment), a Full amount control that fills the live order total, method (only the methods AC-13 allows, defaulting to `CASH` and updating once business currency loads), a reference field labelled `Transaction ID (optional)` for `BKASH`, `NAGAD`, `BANK_TRANSFER`, `CARD`, and `PAYPAL` and `Reference (optional)` for the others, a note when `CARD` is selected reminding the seller never to enter a full card number, and a date defaulting to the business's today. An amount above the live total shows an inline error and blocks the save. A blank amount sends no `initialPayment`, so the 60 second flow from spec 0007 AC-15 is unchanged. On 409 `DUPLICATE_ORDER`, Create anyway resubmits the same payment.
- **AC-19**: `/orders/[id]` shows paid, due, Refund owed when above 0, and the payment status badge, plus a Payments section listing every entry with kind, amount, method, reference, date, recorded by, notes, and for a voided entry a Voided badge with who voided it and the reason; voided amounts are visibly excluded from the totals. A Record payment button (`OWNER` and `STAFF`, hidden on `CANCELLED` and `RETURNED` orders and when due is 0) opens a dialog with the amount prefilled to the current due and method defaulting to `CASH` (with the same reference label and `CARD` help text as AC-18, updating options once currency loads). A Record refund button (shown only when `BusinessSettingsProvider` reports `role` is `OWNER` and `paidAmount` is above 0) opens a dialog with the amount prefilled to `refundOwed` on a closed order and blank on an active one. A Void action on each live entry (shown only when `role` is `OWNER`) opens a confirmation that requires a reason. The payment and refund dialogs each generate one `Idempotency-Key` when they open and reuse it on retry. On a 409, the page shows the error message and refreshes the order: `ORDER_CLOSED` and `PAYMENT_ALREADY_VOIDED` close the dialog, while `PAYMENT_EXCEEDS_DUE`, `REFUND_EXCEEDS_PAID`, and `VOID_BREAKS_BALANCE` keep the dialog open so the seller sees the updated ceiling or reason and can adjust. Edit on an order whose total change hits 409 `TOTAL_BELOW_PAID` explains that a refund or void is needed first. The dialogs trap focus, are keyboard operable, and meet WCAG AA.
- **AC-20**: `/orders` shows the payment status badge (text plus color, never color alone) on the desktop table and phone cards, and a payment filter with All, Has due (`UNPAID` and `PARTIAL`), Unpaid, Partial, Paid, and Refund owed. The payment filter combines with the status filter and search, survives filter changes like the status filter, and resets paging.
- **AC-21**: `/payments` is reachable for `OWNER` and `STAFF` from the main sidebar on desktop and under `More` (`secondaryRoutes`) on phones, keeping the mobile bar at five slots. Once the settings provider mounts, it resolves this month so far in the business timezone and sends explicit `from` and `to` dates on every request (including Load more) so crossing midnight never invalidates a cursor. It offers from and to dates, all eight methods, and kind filters, shows the collected, refunded, and net summary for the filter, and lists entries 20 at a time with Load more on a desktop table and phone cards. Each row shows date, order number linking to `/orders/[id]`, customer name, kind, method, reference, amount, recorded by, and a Voided badge when voided. Empty, no match, loading, and error states are present and announced. Amounts display in the business currency. The page meets WCAG AA.
- **AC-22**: The migration extends `payments` and `orders` in three ordered migrations (matching the existing `0002`, `0003`, `0004` pattern) without losing any existing row: (1) generated migration adding nullable columns (`kind`, actor fields, void fields, `idempotency_key`, and temporary `payment_date_day date`); (2) custom SQL backfill setting legacy `kind` to `PAYMENT`, legacy actor to nil uuid and `Legacy record`, converting any existing `payment_date` timestamp to `payment_date_day` in the owning business's timezone (checked against `pg_timezone_names`, falling back to `Asia/Dhaka` for a corrupt zone per spec 0008 AC-11), recomputing every order's `paid_amount` from live entries, and setting `due_amount` to `total` minus `paid_amount` on active orders and to 0 on `CANCELLED` and `RETURNED` orders; (3) generated migration swapping `payment_date_day` to `payment_date`, enforcing `NOT NULL`, and adding the check constraints and indexes. A fresh database and an existing one both migrate cleanly.

## Decision

**Chosen option**: Option 1, a record only payment ledger per order with cached order totals, refund entries, and voids.

Each money movement is one immutable row in `payments` (kind `PAYMENT` or `REFUND`), corrected only by a reasoned void; the order keeps `paid_amount` and `due_amount` as totals rewritten inside the same locked transaction, and everything else (refund owed, payment status) is derived on read.

Decisions settled while writing (pick, why, runner up):

- **Refunds get their own endpoint** (`/refunds`) so the `OWNER` only rule is a route middleware (`requireBusinessRole(OWNER_ONLY)`) like the team routes, not a body field check, with role checks placed per route so `business_members` is queried once. Runner up: one endpoint with a `kind` field and a role check in the service.
- **Live role from `GET /api/business/me`.** Frontend auth state holds only the token and business id, and JWT claims can lag behind a role change. Returning the database verified `role` on `GET /api/business/me` and exposing it in `BusinessSettingsProvider` gives every screen a live source with zero extra requests. Runner up: decoding the JWT on the client (stale up to 15 minutes).
- **Order row lock, no version bump.** Payment, refund, void, edit, and status change all `SELECT ... FOR UPDATE` the order row first, so balance checks never race. Payments bump `updatedAt` but not `version`, so a seller mid edit is not thrown out by a staff payment. Runner up: bump `version` on every payment, simpler but disruptive.
- **Payment status is derived, never stored.** One domain function maps status, total, and paid to a value, and the list filter uses the same rule as a SQL `CASE`; a test pins that both agree. Runner up: a stored column, which can drift.
- **Database checks back the invariants**: `payments.amount > 0`, `kind IN ('PAYMENT','REFUND')`, `0 <= orders.paid_amount <= orders.total`, `orders.due_amount >= 0`. A bug then fails loudly instead of storing bad money.
- **Idempotency key per business on payments and refunds**, checked after verifying order existence (so an invalid order still returns 404) and rejecting both cross order and cross kind replays with 409. Runner up: keys scoped per order, which hides a client bug that reuses keys.
- **Writes return the full order detail**, so every screen refreshes totals, badge, and the Payments section from one response.
- **The `/payments` summary covers the whole filtered range on every page**, capped at 366 inclusive days, with plain normalized filter fields serialized in the cursor (matching the existing order cursor). Runner up: summary on the first page only.
- **Legacy actor is the nil uuid with name `Legacy record`**, matching the `Unknown customer` backfill approach in spec 0007. No code path ever wrote payments, so in practice no row should need it.

**Implementation skills**: `web-design-guidelines` (`vercel-labs/agent-skills`, `.agents/skills/web-design-guidelines/`) · `lucide-icons` (`aksuharun/skills`, `.agents/skills/lucide-icons/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.agents/skills/vercel-react-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch**:

`payments` (exists from spec 0002, extended here; N entries belong to 1 order):

| Column                | Type                              | Rule                                                                     |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `id`                  | uuid PK                           | existing                                                                 |
| `business_id`         | uuid not null FK `businesses`     | existing, tenant scope                                                   |
| `order_id`            | uuid not null FK `orders` cascade | existing                                                                 |
| `kind`                | text not null default `PAYMENT`   | new; `PAYMENT` or `REFUND`; check constraint                             |
| `amount`              | integer not null                  | existing; check `amount > 0`; at most 100,000,000 at the API             |
| `method`              | text not null                     | existing; one of the eight methods                                       |
| `reference_number`    | text null                         | existing; at most 100 characters at the API                              |
| `notes`               | text null                         | existing; at most 500 characters at the API                              |
| `payment_date`        | date not null, string mode        | changed from timestamptz via three step migration; business calendar day |
| `recorded_by_user_id` | uuid not null                     | new; no FK, matching the `audit_logs` and status history convention      |
| `recorded_by_name`    | text not null                     | new; the actor name when written                                         |
| `voided_at`           | timestamptz null                  | new; set once                                                            |
| `voided_by_user_id`   | uuid null                         | new                                                                      |
| `voided_by_name`      | text null                         | new                                                                      |
| `void_reason`         | text null                         | new; 1 to 200 characters at the API                                      |
| `idempotency_key`     | text null                         | new; null on `initialPayment` from order create                          |
| `created_at`          | timestamptz not null default now  | existing                                                                 |
| `updated_at`          | timestamptz not null default now  | existing; set by hand on void                                            |

Indexes: keep `payments_business_order_idx (business_id, order_id)`; add `payments_business_date_idx (business_id, payment_date, created_at, id)` for `/api/payments`; add partial unique `payments_business_idempotency_unq (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. Check: the four void columns are all null or `voided_at`, `voided_by_user_id`, `voided_by_name`, and `void_reason` are all set.

`orders` (existing columns, new meaning and checks): `paid_amount` is the cached net paid, `due_amount` the cached due (`total - paid_amount` on active orders, `0` on `CANCELLED` and `RETURNED`). Add checks `orders_paid_within_total (paid_amount >= 0 AND paid_amount <= total)` and `orders_due_non_negative (due_amount >= 0)`. No new column.

Domain: extend `Payment` in `backend/src/domain/entities/financial.entity.ts` with `kind`, actor, and void fields, and `paymentDate` as a `YYYY-MM-DD` string. Update the `dueAmount` comment on `Order` in `backend/src/domain/entities/order.entity.ts` to document that closed orders have due 0. Add a pure domain module (for example `backend/src/domain/order-payments.ts`) that owns `computeOrderBalance(status, total, entries)`, `derivePaymentStatus(status, total, paid)`, and the guards for record, refund, void, and edit, so the services stay thin.

Contracts: export `IsoDateSchema` and `CreateOptionalDateSchema` from `packages/contracts/src/datetime.ts` (promoted from private helpers in `order.ts`) so orders and payments share one calendar date parser. Add `packages/contracts/src/payment.ts` with `PAYMENT_METHODS`, `BD_ONLY_PAYMENT_METHODS` (`BKASH`, `NAGAD`), `availablePaymentMethods(currency)`, `PAYMENT_KINDS`, `PAYMENT_STATUSES`, `PAYMENT_STATUS_FILTER_VALUES` (`UNPAID`, `PARTIAL`, `PAID`, `REFUND_OWED`), `PaymentEntrySchema`, `PaymentCreateSchema`, `PaymentVoidSchema`, `InitialPaymentSchema`, `PaymentLedgerQuerySchema`, `PaymentLedgerItemSchema`, `PaymentLedgerPageSchema`, `PaymentAuditAction`, and `PaymentErrorCode`. `order.ts` adds `initialPayment` to `OrderCreateSchema`, `paymentStatus` to the list query, and `payments`, `refundOwed`, `paymentStatus`, and `paidAmount` to the read schemas. `business.ts` adds optional `role: TeamRoleSchema.optional()` to `BusinessResponseSchema.shape.data`. The backend `PaymentMethod` enum must equal the contract list.

**State transitions**:

Entry: `live` → `voided` (once, `OWNER`, reason required). No other change.

Order payment status (derived):

| Order status             | Condition             | `paymentStatus` | New payment | Refund | Void |
| ------------------------ | --------------------- | --------------- | ----------- | ------ | ---- |
| `PENDING` to `DELIVERED` | paid 0, total above 0 | `UNPAID`        | yes         | no     | yes  |
| `PENDING` to `DELIVERED` | 0 < paid < total      | `PARTIAL`       | yes         | yes    | yes  |
| `PENDING` to `DELIVERED` | paid equals total     | `PAID`          | no (due 0)  | yes    | yes  |
| `CANCELLED`, `RETURNED`  | paid above 0          | `REFUND_OWED`   | no          | yes    | yes  |
| `CANCELLED`, `RETURNED`  | paid 0                | `NONE`          | no          | no     | yes  |

The order status workflow from spec 0007 is unchanged; moving to `CANCELLED` or `RETURNED` sets `due_amount` to 0.

**API surface**:

| Endpoint                                   | Method | Key inputs                                                                                               | Key outputs                                                 | Auth                   | Key errors                                                                              |
| ------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `/api/business/me`                         | GET    | existing                                                                                                 | existing + `role` (`OWNER` or `STAFF`)                      | bearer, OWNER or STAFF | existing                                                                                |
| `/api/orders`                              | POST   | existing spec 0007 inputs + `initialPayment` {amount, method, paymentDate, referenceNumber, notes} (opt) | full order with `payments`, `paymentStatus`, `refundOwed`   | bearer, OWNER or STAFF | 400 validation (`initialPayment.*`), existing 409s                                      |
| `/api/orders`                              | GET    | existing + `paymentStatus` list (`UNPAID`, `PARTIAL`, `PAID`, `REFUND_OWED`)                             | `items` + `paidAmount`, `paymentStatus`, `refundOwed`       | bearer, OWNER or STAFF | 400 validation                                                                          |
| `/api/orders/:id`                          | GET    | id                                                                                                       | detail + `payments`, `paymentStatus`, `refundOwed`          | bearer, OWNER or STAFF | 404                                                                                     |
| `/api/orders/:id`                          | PATCH  | existing                                                                                                 | full order detail                                           | bearer, OWNER or STAFF | existing + 409 `TOTAL_BELOW_PAID`                                                       |
| `/api/orders/:id/status`                   | POST   | existing                                                                                                 | full order detail (due 0 when closed)                       | bearer, OWNER or STAFF | existing                                                                                |
| `/api/orders/:id/payments`                 | POST   | amount (req), method (req), paymentDate, referenceNumber, notes, `Idempotency-Key`                       | 201 full order detail (200 on replay)                       | bearer, OWNER or STAFF | 400, 404, 409 `ORDER_CLOSED`, 409 `PAYMENT_EXCEEDS_DUE`, 409 `IDEMPOTENCY_KEY_CONFLICT` |
| `/api/orders/:id/refunds`                  | POST   | same as payments                                                                                         | 201 full order detail (200 on replay)                       | bearer, OWNER only     | 400, 403, 404, 409 `REFUND_EXCEEDS_PAID`, 409 `IDEMPOTENCY_KEY_CONFLICT`                |
| `/api/orders/:id/payments/:paymentId/void` | POST   | reason (req); `Idempotency-Key` ignored                                                                  | 200 full order detail                                       | bearer, OWNER only     | 400, 403, 404, 409 `PAYMENT_ALREADY_VOIDED`, 409 `VOID_BREAKS_BALANCE`                  |
| `/api/payments`                            | GET    | from, to, method list, kind, cursor, limit                                                               | `items`, `summary` {collected, refunded, net}, `nextCursor` | bearer, OWNER or STAFF | 400 validation                                                                          |

Check order on `/payments` and `/refunds`: authentication and role (401/400/403) → `Idempotency-Key` header length (400 naming `Idempotency-Key`) → `:id` UUID and tenant order existence (404) → idempotency lookup in the business (200 if same order and kind, 409 `IDEMPOTENCY_KEY_CONFLICT` if different order or kind) → body validation including currency method and future date (400) → transaction locking order row (`FOR UPDATE`), rechecking status and balance rules (409), writing entry, totals, and audit row. On `/void`: authentication and role (403) → `:id` and `:paymentId` UUID check (404) → body validation (400) → transaction locking order row (`FOR UPDATE`), checking order and entry existence (404), already voided and balance rules (409), writing void, totals, and audit row.

Error bodies follow the existing convention (`error`, `message`, `fields`), plus extra balance fields: `PAYMENT_EXCEEDS_DUE` adds `dueAmount`, `REFUND_EXCEEDS_PAID` and `TOTAL_BELOW_PAID` add `paidAmount`, and `VOID_BREAKS_BALANCE` adds `paidAmount` and `total`. New error codes: `ORDER_CLOSED`, `PAYMENT_EXCEEDS_DUE`, `REFUND_EXCEEDS_PAID`, `PAYMENT_ALREADY_VOIDED`, `VOID_BREAKS_BALANCE`, `TOTAL_BELOW_PAID`, `IDEMPOTENCY_KEY_CONFLICT`.

**Value sourcing**:

| Action                            | Value produced or displayed       | Source                                                                                                         |
| --------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Record, refund, first payment     | Amount, method, reference, notes  | Client input                                                                                                   |
| Record, refund, first payment     | Payment date when omitted         | `todayInTimeZone(businesses.timezone)` from `backend/src/domain/timezone.ts`, read in the same request         |
| Record, refund, first payment     | Future date check                 | Input date compared as `YYYY-MM-DD` strings with the same business today                                       |
| Record, refund, first payment     | Allowed methods                   | `businesses.currency` through `availablePaymentMethods(currency)` in contracts                                 |
| Record, refund, void              | Recorded or voided by id and name | `requestContext.userId` and `users.name` captured when written                                                 |
| Record, refund, void              | Tenant                            | `requestContext.businessId` from the auth middleware                                                           |
| Record                            | Due ceiling                       | Locked `orders.due_amount`                                                                                     |
| Refund, void                      | Paid ceiling and floor            | Locked `orders.paid_amount` and `orders.total`                                                                 |
| First payment                     | Total ceiling                     | The order total computed by the create transaction (spec 0007 AC-4)                                            |
| Any payment write, edit, status   | `paid_amount`                     | Derived: live `PAYMENT` sum minus live `REFUND` sum for the order, recomputed under the lock                   |
| Any payment write, edit, status   | `due_amount`                      | Derived: `total - paid_amount` when active, 0 when `CANCELLED` or `RETURNED`                                   |
| Detail, list                      | `refundOwed`                      | Derived: `paid_amount` when `CANCELLED` or `RETURNED`, else 0                                                  |
| Detail, list, filter              | `paymentStatus`                   | Derived by `derivePaymentStatus(status, total, paid_amount)`; the list filter uses the same rule as SQL `CASE` |
| Detail                            | Entry list and void details       | `payments` rows for the order                                                                                  |
| Replay                            | Prior entry                       | `payments.idempotency_key` in the business (matched on `order_id` and `kind`)                                  |
| Ledger                            | Default from and to               | First day of the month and today from `todayInTimeZone(businesses.timezone)`                                   |
| Ledger                            | Order number, `customerName`      | Join to `orders.order_number` and `orders.customer_name_snapshot`                                              |
| Ledger                            | Summary collected, refunded, net  | Derived: sums over live entries matching all active filters (including `kind`), whole range                    |
| Ledger                            | Next cursor                       | Encoded `payment_date`, `created_at`, `id` of the last item plus plain normalized filter fields                |
| Create form                       | Full amount value                 | The form's live computed order total                                                                           |
| Create form, dialogs, `/payments` | Date defaults                     | Business today from `todayInTimeZone` and the shared settings provider (spec 0008)                             |
| Record payment dialog             | Amount prefill                    | Order detail `dueAmount`                                                                                       |
| Record refund dialog              | Amount prefill                    | Order detail `refundOwed` on a closed order, blank on an active one                                            |
| Dialogs                           | Idempotency key                   | `crypto.randomUUID()` generated when the dialog opens                                                          |
| Screens                           | Role gated buttons                | Database verified `role` returned by `GET /api/business/me` and exposed by `BusinessSettingsProvider`          |
| Screens                           | Currency display and methods      | `businesses.currency` through the shared settings provider, `formatMoney`, and `availablePaymentMethods`       |
| Audit                             | Order number in metadata          | Locked order row                                                                                               |

**Key invariants**:

- `paid_amount` equals live payments minus live refunds, and `0 <= paid_amount <= total` in every order status, backed by a database check.
- `due_amount` equals `total - paid_amount` on active orders and 0 on `CANCELLED` and `RETURNED` orders; it is never negative.
- Every entry belongs to one order and one business, and the entry's business equals the order's business.
- Entries are never deleted. The only update is setting the four void fields once, together.
- Every balance changing write (payment, refund, void, order edit, status change) locks the order row first (`FOR UPDATE`) and recomputes or updates the totals in the same transaction.
- Payment writes never change `orders.version` and never add a status history row.
- `paymentStatus` and `refundOwed` are never stored.
- `BKASH` and `NAGAD` are never accepted for a new entry when the business currency is not `BDT`.
- `payment_date` is never after the business's today when written, and is a plain calendar day that never passes through a timestamp.
- Every payment, refund, and void writes exactly one audit row in its transaction.

**Security model**:

- Record only ledger: no gateway, no card numbers, no wallet credentials, no PCI DSS scope. `referenceNumber` holds a transaction id, and when `CARD` is selected the UI tells sellers never to type a full card number.
- Every route is authenticated and tenant scoped; repositories filter on `businessId` and cross tenant ids return 404.
- `OWNER` and `STAFF`: record payments, first payment at create, read order payments, read `/payments`. `OWNER` only: refunds and voids, enforced per route by `requireBusinessRole(OWNER_ONLY)` (one database role query per request) and mirrored in the UI via live `role` from `GET /api/business/me`.
- Money mutations are audited in the same transaction (non negotiable for money).
- The existing global rate limiter covers these authenticated routes; no new limiter.

**Configuration required**: none. No new environment variable, credential, or dependency.

**Critical test scenarios**:

- Happy path: create an order with a 500 bKash advance on a 1,200 total, add a 700 cash on delivery payment later, and read paid 1,200, due 0, `PAID` on detail, list, and `/payments`, verifies **AC-1**, **AC-3**, **AC-7**, **AC-10**, **AC-11**, **AC-17**.
- First payment rules: amount above total (`initialPayment.amount`), future date, bKash on a USD business (all returning 400 before duplicate detection), a duplicate 409 then Create anyway, and an order idempotency replay with a changed payment, verifies **AC-2**, **AC-13**, **AC-14**.
- Concurrency and idempotency: two payments that together exceed the due, a payment racing a cancel, an edit racing a payment, two requests racing on one key for the same order (200) and for different orders (409), a payment key replayed on `/refunds` (409), and a used key sent to an unknown order (404), verifies **AC-4**, **AC-9**, **AC-12**.
- Closing: cancel a partially paid order (confirming due 0 and existing stock movement), see Refund owed, record a refund that clears it, and try a new payment (409 `ORDER_CLOSED`), verifies **AC-5**, **AC-8**.
- Voids: void a payment, void it again (409), void a payment that a refund depends on (409 `VOID_BREAKS_BALANCE` with `paidAmount` and `total`), and void a refund on a closed order after total was reduced earlier (409 `VOID_BREAKS_BALANCE`, never 500), verifies **AC-6**, **AC-7**.
- Edit guard: reduce the total below paid (409 `TOTAL_BELOW_PAID`), verify check order (`ORDER_LOCKED`, `TOTAL_BELOW_PAID`, `ORDER_CHANGED`, `CUSTOMER_ARCHIVED`), then refund and edit successfully, verifies **AC-9**.
- Auth and permission: `STAFF` records a payment (201), refunds and voids (403, nothing written), `GET /api/business/me` returns live `role`, another business's order and entry (404), verifies **AC-16**.
- Audit and atomicity: each write leaves one audit row (`ORDER_CREATED` metadata unchanged); a forced audit failure stores nothing, verifies **AC-15**.
- Ledger: default month range in a non Dhaka timezone near midnight, explicit date resend on Load more, a 366 day leap year range (200) vs 367 days (400 naming `from`, `to`), future filter dates (200), `kind=REFUND` summary yielding negative `net`, a cursor replayed on other filters (400), and voided entries excluded from summary, verifies **AC-17**.
- Screens: create form section with `CARD` help text and currency load sync, detail dialogs with role gating, focus trap, retry reuse, and 409 close vs keep open behavior, list badge and filter (rejecting `NONE`), `/payments` on phone and desktop reachable under `More` on phones, verifies **AC-18**, **AC-19**, **AC-20**, **AC-21**.
- Migration: run the three migrations on a fresh database and on a seeded database with cancelled orders, legacy payment rows, and a business with a corrupt timezone, verifies **AC-22**.

## Build plan

Tracer Bullet: the first task is one thin, real path (record a later payment and see it on the order) through the migration, domain, API, and screen; later tasks thicken it.

1. [x] Thin payment thread: shared date schemas in `packages/contracts/src/datetime.ts` and new `packages/contracts/src/payment.ts`; the three step `payments` and `orders` migrations (nullable columns, custom timezone safe backfill and totals recompute, column swap plus `NOT NULL`, checks, and indexes); the domain balance module and updated `Payment` and `Order` entities; the payment repository; per route role middleware on `orderRouter`; `POST /api/orders/:id/payments` with header and order checks, idempotency, row lock, totals rewrite, and audit; `payments`, `paymentStatus`, and `refundOwed` on order detail; and on `/orders/[id]` the Payments section plus the Record payment dialog. Satisfies **AC-3**, **AC-4**, **AC-7**, **AC-11**, **AC-12**, **AC-13**, **AC-14**, **AC-15**, **AC-22**.
2. [x] First payment at create: `initialPayment` on the create contract and transaction, business currency and timezone load, nested `initialPayment.<field>` error mapping, validation before duplicate detection, null payment idempotency key, replay behavior, and the Payment received section on `/orders/new`. Satisfies **AC-1**, **AC-2**, **AC-18**.
3. [x] Refunds, voids, live role, and closing: `role` on `GET /api/business/me` and `BusinessSettingsProvider`; `POST /api/orders/:id/refunds` and the void endpoint behind `OWNER_ONLY`; row locking and due 0 on cancel and return in the status transaction; row locking and `TOTAL_BELOW_PAID` check order in the edit transaction; the Record refund and Void dialogs (role gated, with 409 close vs keep open handling), Refund owed display, and the edit error message. Satisfies **AC-5**, **AC-6**, **AC-8**, **AC-9**, **AC-16**, **AC-19**.
4. [x] Payment status on the list: the SQL `CASE` matching the domain rule, the `paymentStatus` filter (rejecting `NONE`) and cursor binding, `paidAmount` and `refundOwed` on list rows, and the badge and payment filter on `/orders`. Satisfies **AC-10**, **AC-20**.
5. [x] Ledger: `GET /api/payments` with business day defaults, filters, 366 inclusive day cap, plain filter cursor, and range summary; the `/payments` page (explicit dates on every request, all eight methods in the filter) and the Payments link in the desktop sidebar and phone `More` menu. Satisfies **AC-17**, **AC-21**.
6. [x] Harden and test: idempotency, cross kind, cross order, and lock races, the full role and tenant matrix, currency method rule on every write, audit atomicity, the three migrations on a fresh and a seeded database (including corrupt timezone fallback), accessibility checks, and unit, integration, contract, and browser tests across the screens. Satisfies **AC-1** to **AC-22**.

## Consequences

**Positive**:

- Paid and due are correct everywhere they already show (order list, detail, customer profile due) with no new read path.
- Every money change is an immutable, audited entry with a named actor, so the books can be explained later and reports (feature 15) and profit (feature 13) can read one ledger.
- Live role on `GET /api/business/me` gives every screen an accurate permission check without adding a second network call.
- No gateway means no PCI scope, no webhooks, and no provider outage path.

**Negative / tradeoffs**:

- Cash on delivery entered as a first payment counts as paid before the rider hands over the money. If delivery fails, the owner must void it, and until then the order reads `PAID`.
- Staff cannot fix their own mistakes or give money back; an owner must void or refund, which can stall a counter when the owner is away.
- An edit that lowers the total below paid is blocked until an owner refunds or voids, adding a step for a common correction.
- Cached `paid_amount` and `due_amount` must be rewritten on every balance changing path; a future path that forgets will be caught by the checks only when it breaks the bounds, not when it is merely stale.
- No online collection: a seller still takes money outside the app and types it in.

**Neutral**:

- `payment_date` changes from a timestamp to a date column via a three step migration (add nullable columns, custom backfill, then swap and enforce), matching `0002`, `0003`, and `0004`.
- Spec 0007's statements that `paidAmount` stays 0 and that feature 10 owns it are now fulfilled by this spec; `PATCH /api/orders/:id` and `POST /api/orders/:id/status` gain a row lock, and edit checks `TOTAL_BELOW_PAID` before `ORDER_CHANGED`.
- A Payments link is added to the desktop sidebar and under `More` on phones.

## Follow-up

- [ ] Profit and expenses (feature 13) and reports (feature 15) should read revenue from live ledger entries by `payment_date`, using `todayInTimeZone` for day boundaries.
- [ ] Invoices (feature 18) should show the payment entries and due from this ledger.
- [ ] Notifications (feature 17) may add payment reminders from orders with `paymentStatus` `UNPAID` or `PARTIAL`.
- [ ] Online collection (a bKash, SSLCommerz, or Stripe payment link) stays deferred; if added, it should write ledger entries through the same domain rules.
- [ ] After the build, `/sync` should record the payment lock and cached totals rule in `backend/AGENTS.md` and `payment.ts` in `packages/contracts/AGENTS.md`.
