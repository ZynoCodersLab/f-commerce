# Rationale for 0010. Payments as an order ledger with refunds and voids

## Context

Sellers on Facebook, WhatsApp, and Instagram take money in many ways at once: a bKash or Nagad advance before packing, cash on delivery handed over by a rider days later, a bank transfer, sometimes a card on their own terminal. One order often has two or three payments, and some buyers pay after delivery. The seller needs to know, per order and across the business, who still owes what.

The schema already has a `payments` table (spec 0002) and `paid_amount` and `due_amount` columns on `orders`, but nothing writes them: spec 0007 keeps paid at 0 and due equal to total, and hands feature 10 the open questions of how a first payment reaches order creation, how edits and cancels behave once money exists, and whether cash on delivery can be a first payment. Paid and due already appear on the order list, order detail, and customer profile, so those screens are currently wrong for any order that has been paid.

Forces: money must never silently change (audit and immutability), two staff on two phones can act on one order at once (concurrency), sellers on slow networks retry (idempotency), the order create flow must stay near 60 seconds, the product is multi tenant, and the team is small with a Node API, PostgreSQL, and no payment provider account. bKash and Nagad exist only in Bangladesh, while the product allows USD, EUR, and GBP businesses.

## Options considered

### Option 1: Record only ledger with cached order totals, refund entries, and voids (chosen)

Each money movement is an immutable row (payment or refund). Mistakes are voided with a reason, never edited or deleted. The order keeps paid and due as cached totals rewritten in the same locked transaction as every entry, edit, and status change.

**Pros**:

- Full history with actors and reasons; reports and profit read one ledger.
- Paid and due stay cheap to list, filter, and sum, and match the columns the screens already read.
- No provider, no PCI scope, no webhooks.

**Cons**:

- Two writes per entry (row plus order totals) and a row lock on every balance change.
- Cached totals can go stale if a future code path forgets to rewrite them.
- Corrections take two steps (void, then record again).

### Option 2: A single editable paid amount on the order

The seller types the paid amount on the order; no entries.

**Pros**:

- Smallest build; no new table logic.
- Matches the current columns exactly.

**Cons**:

- No record of when, how, or by whom money came in; partial payments and methods are lost.
- Cannot show a payments list or support reports by method or date.
- An overwrite silently erases history, which is unacceptable for money.

### Option 3: Ledger computed on read, no cached totals

Same entries as Option 1, but paid and due are always a `SUM` over entries at read time.

**Pros**:

- One source of truth; nothing can go stale.

**Cons**:

- Every list page, filter, and customer total needs an aggregate join; the payment status filter becomes a `HAVING` over a join with cursor paging.
- The existing `due_amount` readers (customer totals, list) all need rewriting.

### Option 4: Integrate a payment gateway now

Buyers pay online through bKash, SSLCommerz, or Stripe; the app records results from webhooks.

**Pros**:

- Money arrives verified, no manual typing for online payments.

**Cons**:

- Provider accounts, merchant onboarding, webhook security, and reconciliation, for a seller base that mostly takes cash and personal wallet transfers.
- Still needs a manual ledger for cash and cash on delivery, so it adds to Option 1 rather than replacing it.

## Rationale

Option 1 fits the forces. Sellers take most money outside any gateway, so a manual ledger is the core need, and an immutable entry per movement with a named actor and void reason is the only design that keeps money history trustworthy. Keeping the existing cached columns means the order list, detail, customer due, and the new payment status filter stay simple indexed reads; the staleness risk is contained by recomputing from entries under a row lock on every balance changing path and by database checks that bound paid within total. Option 3's purity is not worth rewriting every reader for a product with small per order entry counts. Option 4 is deferred, not rejected: a later gateway writes into this same ledger.

The row lock, rather than a version bump, is what keeps concurrent staff actions safe without throwing a seller out of an open edit form. Locking the order row in edits and status changes closes the race where a concurrent payment lands between a non locked read and a version checked write. Refunds as entries (not negative amounts or a separate table) keep one query and one void path, and zeroing due on cancel or return while showing Refund owed matches how a seller thinks: nothing is owed on a dead order, but money held must go back.

Returning the database verified `role` on `GET /api/business/me` gives `BusinessSettingsProvider` a live source for owner only buttons without decoding a potentially stale token or adding another request on every page load. Converting `payment_date` through a three step migration (add nullable column, backfill in each business's timezone with a fallback to `Asia/Dhaka`, then swap and enforce) guarantees existing databases never shift dates to UTC or fail check constraints before totals are recomputed.

**On cash on delivery as a first payment.** The recommendation was to reject cash on delivery at order creation, because that money is not yet in hand. The engineer chose to allow it, counting toward paid immediately, so a seller who treats a confirmed cash on delivery order as paid can record it that way. This works, with a tradeoff the team accepts consciously: such an order reads `PAID` before cash arrives, and a failed delivery needs an owner to void the entry. A later "expected method" field on the order would remove the need, if it becomes a pain point.

**On owner only refunds.** The recommendation was `OWNER` and `STAFF` for refunds with voids owner only. The engineer chose owner only for both, since a refund also takes money out of the books. The cost is that a staff member cannot complete a return refund alone; the spec makes the buttons owner only and the API answers 403 for staff.
