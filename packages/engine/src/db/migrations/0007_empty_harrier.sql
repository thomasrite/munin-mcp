CREATE TABLE "tenant_config_overlays" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"overlay_id" text NOT NULL,
	"overlay_version" text NOT NULL,
	"overlay" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_config_overlays" ADD CONSTRAINT "tenant_config_overlays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;