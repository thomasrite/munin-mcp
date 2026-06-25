-- Hand-written migration: tighten llm_calls.purpose to an enum and add an
-- optional document_id reference.
--
-- Operational cost analysis is the driver: "how much did extraction cost
-- for tenant X last month" should be a single tight query, not a free-text
-- LIKE.

-- Step 1: create the enum type.
CREATE TYPE "llm_call_purpose" AS ENUM ('extraction', 'query', 'embedding', 'other');
--> statement-breakpoint

-- Step 2: convert the existing purpose column.
-- Any row whose purpose is not in the enum becomes 'other' rather than
-- failing the migration.
ALTER TABLE llm_calls
  ALTER COLUMN purpose TYPE "llm_call_purpose"
  USING CASE
    WHEN purpose IN ('extraction', 'query', 'embedding', 'other') THEN purpose::"llm_call_purpose"
    ELSE 'other'::"llm_call_purpose"
  END;
--> statement-breakpoint

-- Step 3: add optional document_id, FK to documents. NULL is permitted
-- because not every call (query, 'other') has an obvious document context.
ALTER TABLE llm_calls
  ADD COLUMN document_id UUID NULL
  REFERENCES documents(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX llm_calls_document_idx ON llm_calls (tenant_id, document_id)
  WHERE document_id IS NOT NULL;
