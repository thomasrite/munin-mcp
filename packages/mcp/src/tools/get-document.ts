// munin_get_document — pull the full source behind a citation: document
// title/metadata + ordered paragraph texts with ids. Reads under the same
// single-user context as everything else, so an unknown id and an id the
// context may not see produce the SAME indistinguishable "not found or not
// accessible" result (never an existence oracle, never an exception dump).

import { asDocumentId } from '@muninhq/engine';

import { computeCiteAs } from './shaping';
import type { ToolDeps } from './types';

export interface GetDocumentInput {
  readonly documentId: string;
}

export interface DocumentResult {
  readonly status: 'found';
  readonly documentId: string;
  readonly title: string;
  readonly mimeType: string | null;
  readonly sourceModifiedAt: string | null;
  readonly superseded: boolean;
  readonly paragraphs: readonly {
    readonly paragraphId: string;
    /**
     * The same stable citation token a source carries in munin_retrieve_context /
     * munin_gather_entity — so a `[citeAs]` the client is verifying maps directly
     * onto a paragraph here. Derived from (documentId, paragraphId); see shaping.ts.
     */
    readonly citeAs: string;
    readonly index: number;
    readonly page: number | null;
    readonly text: string;
  }[];
}

export interface DocumentNotFound {
  readonly status: 'not_found';
  readonly message: string;
}

export type GetDocumentResult = DocumentResult | DocumentNotFound;

const NOT_FOUND: DocumentNotFound = {
  status: 'not_found',
  message: 'No such document is visible in this memory (not found or not accessible).',
};

// The as* brand helpers do not validate (see engine graph/types.ts) — a
// non-UUID would surface as a database cast error. Validate shape here so a
// malformed id gets the SAME clean not-found as an unknown or invisible one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getDocument(
  deps: ToolDeps,
  input: GetDocumentInput,
): Promise<GetDocumentResult> {
  if (!UUID_RE.test(input.documentId.trim())) return NOT_FOUND;
  const documentId = asDocumentId(input.documentId.trim());

  const [document] = await deps.store.getDocumentsByIds(deps.context, [documentId]);
  if (!document) return NOT_FOUND;

  const paragraphs = await deps.store.findParagraphsByDocument(deps.context, documentId);
  return {
    status: 'found',
    documentId: document.id,
    title: document.title,
    mimeType: document.mimeType,
    sourceModifiedAt: document.sourceModifiedAt?.toISOString() ?? null,
    superseded: document.validTo !== null,
    paragraphs: [...paragraphs]
      .sort((a, b) => a.paragraphIndex - b.paragraphIndex)
      .map((p) => ({
        paragraphId: p.id,
        citeAs: computeCiteAs(document.id, p.id),
        index: p.paragraphIndex,
        page: p.page,
        text: p.text,
      })),
  };
}
