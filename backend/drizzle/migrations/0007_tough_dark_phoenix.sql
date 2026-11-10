-- The unique email index is built after the placeholder cleanup on purpose: a
-- legacy placeholder can share lower(email) with a real account, and the
-- cleanup has to remove it before the index can be created. Keep this order.
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'STAFF' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"accepted_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone NOT NULL,
	"email_status" text DEFAULT 'QUEUED' NOT NULL,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	"last_email_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_members" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_unq" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_business_email_idx" ON "invitations" USING btree ("business_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_business_email_live_unq" ON "invitations" USING btree ("business_id",lower("email")) WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "invitations_business_expires_idx" ON "invitations" USING btree ("business_id","expires_at");--> statement-breakpoint
CREATE INDEX "business_members_business_status_idx" ON "business_members" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "business_members_user_status_idx" ON "business_members" USING btree ("user_id","status");--> statement-breakpoint
DELETE FROM "business_members" WHERE "status" = 'INVITED';--> statement-breakpoint
DELETE FROM "users"
	WHERE "name" = 'Pending Invite'
	AND "password_hash" IS NULL
	AND COALESCE(jsonb_array_length("oauth"), 0) = 0
	AND NOT EXISTS (SELECT 1 FROM "business_members" WHERE "business_members"."user_id" = "users"."id")
	AND NOT EXISTS (SELECT 1 FROM "audit_logs" WHERE "audit_logs"."user_id" = "users"."id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unq" ON "users" USING btree (lower("email"));