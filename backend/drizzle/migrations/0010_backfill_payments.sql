-- Backfill legacy payment rows without losing data. Convert any legacy
-- payment_date timestamp into the owning business's calendar day, falling back
-- to Asia/Dhaka if a business row carries a corrupt timezone (spec 0008 AC-11).
UPDATE "payments" AS p
SET
  "kind" = COALESCE(p."kind", 'PAYMENT'),
  "recorded_by_user_id" = COALESCE(
    p."recorded_by_user_id",
    '00000000-0000-0000-0000-000000000000'::uuid
  ),
  "recorded_by_name" = COALESCE(p."recorded_by_name", 'Legacy record'),
  "payment_date_day" = COALESCE(
    p."payment_date_day",
    (
      p."payment_date" AT TIME ZONE (
        CASE
          WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = b."timezone")
            THEN b."timezone"
          ELSE 'Asia/Dhaka'
        END
      )
    )::date
  )
FROM "businesses" AS b
WHERE p."business_id" = b."id"
  AND (
    p."kind" IS NULL
    OR p."recorded_by_user_id" IS NULL
    OR p."recorded_by_name" IS NULL
    OR p."payment_date_day" IS NULL
  );
--> statement-breakpoint
-- Recompute cached order balances from live ledger entries before enforcing
-- check constraints. Closed orders (CANCELLED, RETURNED) always owe 0.
UPDATE "orders" AS o
SET
  "paid_amount" = COALESCE(p."net_paid", 0),
  "due_amount" = CASE
    WHEN o."status" IN ('CANCELLED', 'RETURNED') THEN 0
    ELSE GREATEST(0, o."total" - COALESCE(p."net_paid", 0))
  END
FROM (
  SELECT
    ord."id" AS "order_id",
    COALESCE(
      SUM(
        CASE
          WHEN pay."voided_at" IS NOT NULL THEN 0
          WHEN pay."kind" = 'REFUND' THEN -pay."amount"
          ELSE pay."amount"
        END
      ),
      0
    )::integer AS "net_paid"
  FROM "orders" AS ord
  LEFT JOIN "payments" AS pay
    ON pay."order_id" = ord."id"
    AND pay."business_id" = ord."business_id"
  GROUP BY ord."id"
) AS p
WHERE o."id" = p."order_id";
