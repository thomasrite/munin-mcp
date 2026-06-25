CREATE TYPE "public"."embedding_target_kind" AS ENUM('paragraph', 'entity');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('document_extract', 'connector', 'manual', 'system');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid,
	"access_tags_used" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_package" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_completed_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"consecutive_error_count" jsonb DEFAULT '0'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text,
	"connector_package" text,
	"title" text NOT NULL,
	"mime_type" text,
	"byte_size" bigint,
	"sha256" text,
	"blob_storage_uri" text NOT NULL,
	"source_modified_at" timestamp with time zone,
	"access_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_kind" "source_kind" NOT NULL,
	"source_document_id" uuid,
	"source_paragraph_id" uuid,
	"source_connector_package" text,
	"extractor_version_id" uuid,
	"confidence" double precision,
	"access_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "edges_document_extract_requires_provenance" CHECK (source_kind != 'document_extract' OR (source_paragraph_id IS NOT NULL AND extractor_version_id IS NOT NULL)),
	CONSTRAINT "edges_confidence_range" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
	CONSTRAINT "edges_no_self_loop" CHECK (from_entity_id != to_entity_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_kind" "embedding_target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"vector" vector(1024) NOT NULL,
	"access_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_kind" "source_kind" NOT NULL,
	"source_document_id" uuid,
	"source_paragraph_id" uuid,
	"source_connector_package" text,
	"extractor_version_id" uuid,
	"confidence" double precision,
	"access_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "entities_document_extract_requires_provenance" CHECK (source_kind != 'document_extract' OR (source_paragraph_id IS NOT NULL AND extractor_version_id IS NOT NULL)),
	CONSTRAINT "entities_confidence_range" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "extractor_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"configuration_id" text NOT NULL,
	"configuration_version" text NOT NULL,
	"schema_hash" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "internal_bypass_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"call_site" text NOT NULL,
	"reason" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"model_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_estimate_pence" bigint,
	"latency_ms" integer NOT NULL,
	"region" text NOT NULL,
	"extractor_version_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paragraphs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"paragraph_index" integer NOT NULL,
	"page" integer,
	"text" text NOT NULL,
	"access_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cmk_key_reference" text,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connector_state" ADD CONSTRAINT "connector_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "edges" ADD CONSTRAINT "edges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "edges" ADD CONSTRAINT "edges_from_entity_id_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "edges" ADD CONSTRAINT "edges_to_entity_id_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "edges" ADD CONSTRAINT "edges_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "edges" ADD CONSTRAINT "edges_source_paragraph_id_paragraphs_id_fk" FOREIGN KEY ("source_paragraph_id") REFERENCES "public"."paragraphs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "edges" ADD CONSTRAINT "edges_extractor_version_id_extractor_versions_id_fk" FOREIGN KEY ("extractor_version_id") REFERENCES "public"."extractor_versions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entities" ADD CONSTRAINT "entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entities" ADD CONSTRAINT "entities_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entities" ADD CONSTRAINT "entities_source_paragraph_id_paragraphs_id_fk" FOREIGN KEY ("source_paragraph_id") REFERENCES "public"."paragraphs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entities" ADD CONSTRAINT "entities_extractor_version_id_extractor_versions_id_fk" FOREIGN KEY ("extractor_version_id") REFERENCES "public"."extractor_versions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extractor_versions" ADD CONSTRAINT "extractor_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "internal_bypass_log" ADD CONSTRAINT "internal_bypass_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_extractor_version_id_extractor_versions_id_fk" FOREIGN KEY ("extractor_version_id") REFERENCES "public"."extractor_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "paragraphs" ADD CONSTRAINT "paragraphs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "paragraphs" ADD CONSTRAINT "paragraphs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_tenant_occurred_idx" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_actor_idx" ON "audit_events" USING btree ("tenant_id","actor");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_target_idx" ON "audit_events" USING btree ("tenant_id","target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_state_tenant_package_idx" ON "connector_state" USING btree ("tenant_id","connector_package");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_tenant_idx" ON "documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_access_tags_gin" ON "documents" USING gin ("access_tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_external_idx" ON "documents" USING btree ("tenant_id","connector_package","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_not_deleted_idx" ON "documents" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edges_tenant_type_idx" ON "edges" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edges_tenant_from_idx" ON "edges" USING btree ("tenant_id","from_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edges_tenant_to_idx" ON "edges" USING btree ("tenant_id","to_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edges_access_tags_gin" ON "edges" USING gin ("access_tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edges_not_deleted_idx" ON "edges" USING btree ("tenant_id","type") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_tenant_target_idx" ON "embeddings" USING btree ("tenant_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_access_tags_gin" ON "embeddings" USING gin ("access_tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_vector_hnsw" ON "embeddings" USING hnsw ("vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_tenant_type_idx" ON "entities" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_access_tags_gin" ON "entities" USING gin ("access_tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_source_paragraph_idx" ON "entities" USING btree ("tenant_id","source_paragraph_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_not_deleted_idx" ON "entities" USING btree ("tenant_id","type") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "extractor_versions_natural_key" ON "extractor_versions" USING btree ("tenant_id","configuration_id","schema_hash","prompt_hash","model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "internal_bypass_log_tenant_occurred_idx" ON "internal_bypass_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "internal_bypass_log_call_site_idx" ON "internal_bypass_log" USING btree ("call_site","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_tenant_occurred_idx" ON "llm_calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_purpose_idx" ON "llm_calls" USING btree ("tenant_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paragraphs_tenant_doc_idx" ON "paragraphs" USING btree ("tenant_id","document_id","paragraph_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paragraphs_access_tags_gin" ON "paragraphs" USING gin ("access_tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paragraphs_not_deleted_idx" ON "paragraphs" USING btree ("tenant_id","document_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_not_deleted_idx" ON "tenants" USING btree ("id") WHERE deleted_at IS NULL;--> statement-breakpoint

-- Tamper-evidence triggers for internal_bypass_log.
-- This table is the audit of last resort. UPDATE, DELETE and TRUNCATE are
-- architecturally blocked at the row level. Production DB role configuration
-- must additionally REVOKE UPDATE/DELETE/TRUNCATE on this table; the trigger
-- here is defence-in-depth that works regardless of role configuration.

CREATE OR REPLACE FUNCTION prevent_internal_bypass_log_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'internal_bypass_log is append-only; % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER internal_bypass_log_no_update
  BEFORE UPDATE ON internal_bypass_log
  FOR EACH ROW EXECUTE FUNCTION prevent_internal_bypass_log_modification();
--> statement-breakpoint

CREATE TRIGGER internal_bypass_log_no_delete
  BEFORE DELETE ON internal_bypass_log
  FOR EACH ROW EXECUTE FUNCTION prevent_internal_bypass_log_modification();
--> statement-breakpoint

CREATE TRIGGER internal_bypass_log_no_truncate
  BEFORE TRUNCATE ON internal_bypass_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_internal_bypass_log_modification();
