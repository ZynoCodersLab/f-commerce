ALTER TABLE "payments" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_date_day" date;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recorded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recorded_by_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voided_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voided_by_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text;