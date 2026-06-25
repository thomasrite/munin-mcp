-- Hand-written migration: structural metadata for paragraphs.
--
-- Citation rendering at query time (Phase 1.7) needs more than just
-- (document, paragraph_index). For PDF: a page number. For DOCX/Markdown:
-- a heading path ("Chapter 3" > "Section 3.1" > "3.1.2 Cooling"). For
-- everything: an ordinal within the section.
--
-- One JSONB column on paragraphs. Default empty object so existing rows
-- (none in production yet) remain valid. The chunker fills it with whatever
-- the source format supports.

ALTER TABLE paragraphs
  ADD COLUMN structure JSONB NOT NULL DEFAULT '{}'::jsonb;
