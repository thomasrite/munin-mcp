// munin_status — cheap, no LLM. Counts via the frozen readers' page totals,
// the pending-extraction signal via findParagraphsPendingExtraction (the same
// reader the extract CLI uses), the active tenant, and the loaded
// configuration's id/version.
//
// MIRRORED BY THE `munin status` CLI VERB (packages/cli/src/munin-status.ts).
// The two compute the same corpus figures the same way, kept in sync by review
// because the dependency edge is one-way (munin-mcp must not import @muninhq/mcp,
// and the lean read-only MCP server must not runtime-depend on the operator CLI).
// The CLI verb is a superset — it adds store posture, MUNIN_HOME and an edge
// count (via getGraphStats) for operators. If this corpus-count shape changes,
// change the CLI mirror too.

import type { ToolDeps } from './types';

/** A document the caller can see — a content-free pointer for "what is in here". */
export interface RecentDocument {
  readonly documentId: string;
  readonly title: string;
  /** ISO-8601 ingest time (createdAt), newest first. */
  readonly ingestedAt: string;
}

export interface StatusResult {
  readonly tenantId: string;
  readonly configuration: { readonly id: string; readonly version: string };
  readonly documentCount: number;
  /**
   * Paragraph total, summed per visible document (the frozen surface exposes
   * no paragraph page). null when the corpus exceeds the counting cap — the
   * count is then omitted rather than reported wrong.
   */
  readonly paragraphCount: number | null;
  readonly entityCount: number;
  /** Paragraphs not yet extracted under the loaded configuration's schema. */
  readonly paragraphsPendingExtraction: number;
  /**
   * The most-recently-ingested visible documents (title + id), newest first,
   * capped at RECENT_DOCUMENTS_LIMIT — a quick "what is in this memory" sample
   * so the caller can SEE the contents, not just the counts. Use the
   * `documentId` with munin_get_document for the full text. Empty for an empty
   * or fully-invisible corpus.
   */
  readonly recentDocuments: readonly RecentDocument[];
}

// Beyond this many documents the per-document paragraph walk is no longer
// "cheap"; report null instead of hammering the store (no silent caps).
const PARAGRAPH_COUNT_DOC_CAP = 2_000;
const DOC_PAGE_SIZE = 200;
// How many recent document pointers to surface — enough to be a useful sample,
// small enough to stay cheap and content-free. Not a cap on the corpus.
const RECENT_DOCUMENTS_LIMIT = 10;

export async function status(deps: ToolDeps): Promise<StatusResult> {
  const [docPage, entityPage, pending] = await Promise.all([
    // One page does double duty: `total` is the document count, `items` are the
    // newest documents (findDocuments returns newest-first) for recentDocuments.
    deps.store.findDocuments(deps.context, { limit: RECENT_DOCUMENTS_LIMIT }),
    deps.store.findEntities(deps.context, { limit: 1 }),
    deps.store.findParagraphsPendingExtraction(deps.context, { schemaHash: deps.schemaHash }),
  ]);

  let paragraphCount: number | null = null;
  if (docPage.total <= PARAGRAPH_COUNT_DOC_CAP) {
    paragraphCount = 0;
    for (let offset = 0; offset < docPage.total; offset += DOC_PAGE_SIZE) {
      const page = await deps.store.findDocuments(deps.context, {
        limit: DOC_PAGE_SIZE,
        offset,
      });
      const counts = await Promise.all(
        page.items.map(async (d) => {
          const paragraphs = await deps.store.findParagraphsByDocument(deps.context, d.id);
          return paragraphs.length;
        }),
      );
      paragraphCount += counts.reduce((a, b) => a + b, 0);
      if (page.items.length < DOC_PAGE_SIZE) break;
    }
  }

  return {
    tenantId: deps.tenantId,
    configuration: { id: deps.configuration.id, version: deps.configuration.version },
    documentCount: docPage.total,
    paragraphCount,
    entityCount: entityPage.total,
    paragraphsPendingExtraction: pending.length,
    recentDocuments: docPage.items.map((d) => ({
      documentId: d.id,
      title: d.title,
      ingestedAt: d.createdAt.toISOString(),
    })),
  };
}
