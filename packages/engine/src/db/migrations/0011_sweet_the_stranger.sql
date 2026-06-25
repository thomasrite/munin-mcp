CREATE TABLE "document_duplicates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"duplicate_of_document_id" uuid NOT NULL,
	"method" text NOT NULL,
	"score" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "version_group_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "version_seq" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "supersedes_document_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sensitivity_class_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "simhash" text;--> statement-breakpoint
ALTER TABLE "document_duplicates" ADD CONSTRAINT "document_duplicates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_duplicates" ADD CONSTRAINT "document_duplicates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_duplicates" ADD CONSTRAINT "document_duplicates_duplicate_of_document_id_documents_id_fk" FOREIGN KEY ("duplicate_of_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_duplicates_tenant_doc_idx" ON "document_duplicates" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "document_duplicates_tenant_dupof_idx" ON "document_duplicates" USING btree ("tenant_id","duplicate_of_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_duplicates_natural_key" ON "document_duplicates" USING btree ("tenant_id","document_id","duplicate_of_document_id","method");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_supersedes_document_id_documents_id_fk" FOREIGN KEY ("supersedes_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_version_group_idx" ON "documents" USING btree ("tenant_id","version_group_id");--> statement-breakpoint
CREATE INDEX "documents_simhash_idx" ON "documents" USING btree ("tenant_id") WHERE simhash IS NOT NULL;