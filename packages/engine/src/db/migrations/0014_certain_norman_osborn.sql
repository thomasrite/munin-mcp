CREATE TABLE "generation_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_draft" text NOT NULL,
	"human_final" text NOT NULL,
	"decision" text NOT NULL,
	"scope" text DEFAULT 'personal' NOT NULL,
	"inferred_rule_id" uuid,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learned_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"scope" text DEFAULT 'personal' NOT NULL,
	"rule_text" text NOT NULL,
	"rule_key" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"source_feedback_id" uuid NOT NULL,
	"confidence" real NOT NULL,
	"reinforcement_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "style_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"scope" text DEFAULT 'personal' NOT NULL,
	"profile_text" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_rules" ADD CONSTRAINT "learned_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_rules" ADD CONSTRAINT "learned_rules_source_feedback_id_generation_feedback_id_fk" FOREIGN KEY ("source_feedback_id") REFERENCES "public"."generation_feedback"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_feedback_tenant_actor_idx" ON "generation_feedback" USING btree ("tenant_id","actor","created_at");--> statement-breakpoint
CREATE INDEX "learned_rules_tenant_actor_idx" ON "learned_rules" USING btree ("tenant_id","actor","scope");--> statement-breakpoint
CREATE INDEX "learned_rules_embedding_hnsw" ON "learned_rules" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "style_profiles_tenant_actor_scope_key" ON "style_profiles" USING btree ("tenant_id","actor","scope");