ALTER TABLE "payments" ALTER COLUMN "kind" SET DEFAULT 'PAYMENT';--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "payment_date";--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "payment_date_day" TO "payment_date";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "payment_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "recorded_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "recorded_by_name" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_business_date_idx" ON "payments" USING btree ("business_id","payment_date","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_business_idempotency_unq" ON "payments" USING btree ("business_id","idempotency_key") WHERE "payments"."idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_paid_within_total" CHECK ("orders"."paid_amount" >= 0 AND "orders"."paid_amount" <= "orders"."total");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_due_non_negative" CHECK ("orders"."due_amount" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_valid" CHECK ("payments"."kind" IN ('PAYMENT', 'REFUND'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_void_fields_consistent" CHECK (("payments"."voided_at" IS NULL AND "payments"."voided_by_user_id" IS NULL AND "payments"."voided_by_name" IS NULL AND "payments"."void_reason" IS NULL) OR ("payments"."voided_at" IS NOT NULL AND "payments"."voided_by_user_id" IS NOT NULL AND "payments"."voided_by_name" IS NOT NULL AND "payments"."void_reason" IS NOT NULL));