CREATE TABLE "review_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid,
	"proposed_change" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"access_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_queue_tenant_status_created_idx" ON "review_queue" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "review_queue_access_tags_gin" ON "review_queue" USING gin ("access_tags");