CREATE TYPE "public"."binding_subject_kind" AS ENUM('app_role', 'group');--> statement-breakpoint
CREATE TABLE "group_role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_kind" "binding_subject_kind" NOT NULL,
	"subject_id" text NOT NULL,
	"role_name" text NOT NULL,
	"scope_org_unit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"access_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenant_directory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entra_tenant_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_unit_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_oid" text NOT NULL,
	"org_unit_id" uuid NOT NULL,
	"role_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "group_role_bindings" ADD CONSTRAINT "group_role_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_role_bindings" ADD CONSTRAINT "group_role_bindings_scope_org_unit_id_org_units_id_fk" FOREIGN KEY ("scope_org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_id_org_units_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_directory" ADD CONSTRAINT "tenant_directory_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_unit_assignments" ADD CONSTRAINT "user_unit_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_unit_assignments" ADD CONSTRAINT "user_unit_assignments_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_role_bindings_tenant_idx" ON "group_role_bindings" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "group_role_bindings_unique_idx" ON "group_role_bindings" USING btree ("tenant_id","subject_kind","subject_id","role_name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "org_units_tenant_idx" ON "org_units" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_directory_entra_tid_idx" ON "tenant_directory" USING btree ("entra_tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "user_unit_assignments_tenant_actor_idx" ON "user_unit_assignments" USING btree ("tenant_id","actor_oid") WHERE deleted_at IS NULL;
