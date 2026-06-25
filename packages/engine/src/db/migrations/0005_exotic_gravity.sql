CREATE TYPE "public"."query_event_status" AS ENUM('answered', 'no_evidence', 'error');--> statement-breakpoint
CREATE TABLE "query_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"status" "query_event_status" NOT NULL,
	"result_count" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_events" ADD CONSTRAINT "query_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "query_events_tenant_occurred_idx" ON "query_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "query_events_tenant_actor_occurred_idx" ON "query_events" USING btree ("tenant_id","actor","created_at");