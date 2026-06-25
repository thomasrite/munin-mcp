-- Hand-written migration: unique constraint for embedding upsert + triggers
-- keeping embeddings.access_tags in sync with the underlying paragraph.
--
-- Natural key for embeddings: (tenant_id, target_kind, target_id, model_id).
-- Required so upsertEmbedding can use ON CONFLICT DO UPDATE.

CREATE UNIQUE INDEX IF NOT EXISTS embeddings_natural_key
  ON embeddings (tenant_id, target_kind, target_id, model_id);
--> statement-breakpoint

-- Triggers for embeddings.access_tags to stay in sync with the
-- underlying paragraph's access_tags.
--
-- The schema-level invariant: every embedding has the same access_tags as
-- its target row. Without enforcement, an application bug that updates a
-- paragraph's access_tags but not the embedding's would create a silent
-- permission divergence (the embedding becomes findable by callers who
-- can no longer see the paragraph, or vice versa).
--
-- Two triggers:
--   1. BEFORE INSERT on embeddings: if access_tags is empty (the default)
--      and target_kind is 'paragraph', copy from the paragraph.
--   2. AFTER UPDATE OF access_tags on paragraphs: cascade the change to
--      every embedding whose target_id is this paragraph.

CREATE OR REPLACE FUNCTION embeddings_default_access_tags() RETURNS trigger AS $$
BEGIN
  IF NEW.target_kind = 'paragraph' AND (NEW.access_tags IS NULL OR cardinality(NEW.access_tags) = 0) THEN
    SELECT access_tags INTO NEW.access_tags
    FROM paragraphs
    WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER embeddings_default_access_tags_trigger
  BEFORE INSERT ON embeddings
  FOR EACH ROW EXECUTE FUNCTION embeddings_default_access_tags();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION paragraph_access_tags_sync_to_embeddings() RETURNS trigger AS $$
BEGIN
  IF NEW.access_tags IS DISTINCT FROM OLD.access_tags THEN
    UPDATE embeddings
    SET access_tags = NEW.access_tags
    WHERE target_kind = 'paragraph'
      AND target_id = NEW.id
      AND tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER paragraph_access_tags_sync_trigger
  AFTER UPDATE OF access_tags ON paragraphs
  FOR EACH ROW EXECUTE FUNCTION paragraph_access_tags_sync_to_embeddings();
