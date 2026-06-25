CREATE TABLE "citation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"document_id" uuid NOT NULL,
	"paragraph_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "citation_events" ADD CONSTRAINT "citation_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_events" ADD CONSTRAINT "citation_events_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_events" ADD CONSTRAINT "citation_events_paragraph_id_paragraphs_id_fk" FOREIGN KEY ("paragraph_id") REFERENCES "public"."paragraphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "citation_events_tenant_paragraph_idx" ON "citation_events" USING btree ("tenant_id","paragraph_id");--> statement-breakpoint
CREATE INDEX "citation_events_tenant_occurred_idx" ON "citation_events" USING btree ("tenant_id","created_at");