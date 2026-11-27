# Review, feat/payments, 2026-11-28

**Reviewed by**: MiniMax-M2 (author on Gemini 4 Neon)
**Scope**: 65 files, branch vs main (0b8bb128)
**Verdict**: Changes requested

## Summary

The feature implements a full payment ledger per order with initial payments at create, subsequent payments/refunds, voids, role-gated mutations, idempotency, row-level locking, a ledger list page, and all derived payment status fields. The Clean Architecture layers are correctly separated, the domain balance logic is sound, and the migration follows the three-step pattern. One correctness bug in `derivePaymentStatus` and a test that asserts the wrong result stand between this change and merge.

## Blockers

_(None)_

## Major

### 🟠 `derivePaymentStatus` returns `'PAID'` instead of `'NONE'` for closed orders with total=0, `backend/src/domain/order-payments.ts:44-46`

**Problem**: When `total` and `paidAmount` are both 0, `paidAmount >= total` evaluates to `true` (0 >= 0). The closed-order check at line 41 runs **after** that comparison, so a `CANCELLED` or `RETURNED` order with total=0 and paidAmount=0 falls through to `return 'PAID'` instead of returning `'NONE'` as the spec requires.

**Why it matters**: AC-10 states that on a `CANCELLED` or `RETURNED` order, `paymentStatus` must be `REFUND_OWED` when paid > 0, else `NONE`. The SQL CASE in `order.repository.ts:237-242` checks closed status first and correctly returns `NONE` for this case, so the list query is right but the domain function and all detail responses are wrong. A cancelled order with no items and no payments would show a `PAID` badge in the UI, which is misleading.

**Suggested fix**: Check `isOrderClosedForPayment` before the `paidAmount >= total` guard. The closed-order path should short-circuit with `NONE` / `REFUND_OWED` before any paid-total comparison. Also update `order-payments.test.ts:29` which asserts `derivePaymentStatus(OrderStatus.PENDING, 0, 0).toBe('PAID')` — an active-order total=0 with 0 paid is an edge case not defined by the spec; the correct result per AC-10 table is `NONE`.

## Minor

_(None)_

## Nits

- ⚪ `derivePaymentStatus` test at `backend/src/domain/order-payments.test.ts:29` asserts `toBe('PAID')` for `derivePaymentStatus(PENDING, 0, 0)`. Even if the PENDING case is considered edge-case undefined, the corresponding `CANCELLED` case at line 34 needs the same check, and the test should not assert the buggy output of the broken function. Fix the function first, then correct the test.
- ⚪ `recordEntry` in `payment.service.ts:327` catches unique violations and re-checks `findByIdempotencyKey` inside the catch — if the key was consumed by a different kind on a different order, this re-throws the original constraint error. This is correct but relies on the error not being suppressed; consider a comment explaining why `findByIdempotencyKey` is not called before the insert attempt.

## Strengths

- The three-migration pattern for `payments.payment_date` (nullable cols → backfill with timezone-safe date conversion → NOT NULL + checks) is exactly right and includes the corrupt-timezone fallback specified in AC-22.
- `SELECT ... FOR UPDATE` on the order row is applied consistently across `recordEntry`, `voidEntry`, `update`, and `changeStatus`, preventing all race conditions on balance-changing operations.
- The domain module `order-payments.ts` owns all balance computation and business rules in pure functions with no I/O, making the service layer genuinely thin as required.
- The `assertCanVoidPayment` guard correctly prevents a void that would violate `0 <= paidAmount <= total` on both active and closed orders, protecting the `orders_paid_within_total` check constraint from ever triggering a database error.
- Idempotency on payments and refunds is checked after order existence (404 before 409), the key is scoped per business, and a cross-order or cross-kind replay correctly returns 409 `IDEMPOTENCY_KEY_CONFLICT` before any body validation.

## Test coverage

The domain, cursor, and contract tests cover the pure logic thoroughly, including edge cases for void balance guards and cursor filter binding. The payment service tests cover idempotency, currency restrictions, and date defaults via mocks. The route integration tests in `payment.controller.route.test.ts` (1,491 lines) cover the full request paths for payments, refunds, and voids.

The one gap: `PaymentService.voidPayment` has no dedicated unit test covering its own logic path (it delegates to the repository, which is tested as part of the route test). Given the complexity of the void flow, a focused unit test for the service method would catch regressions if the repository contract ever changes.

## Verdict

One Major correctness bug in `derivePaymentStatus` and an incorrect test assertion need to be resolved before merge. The rest of the implementation is solid.
