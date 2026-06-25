// Result shaping shared by the retrieval-flavoured tools: engine shapes →
// plain JSON-safe objects for the MCP client. Unit-tested in shaping.test.ts.

import { createHash } from 'node:crypto';

import type { ContextSource, DisambiguationGroup } from '@muninhq/engine';

/**
 * A stable, conversation-spanning citation token for one source, derived purely
 * from its DOCUMENT + PARAGRAPH identity (both stable UUIDs the engine mints).
 *
 * Why it exists: the engine's `sourceId` (`P1..Pn`) is a positional label minted
 * PER retrieval call, so two calls in one conversation both produce a `[P1]` and
 * the same `[P3]` can point at different paragraphs — uncitable across calls. The
 * `citeAs` token is a pure function of `(documentId, paragraphId)`, so the SAME
 * source yields the SAME token on every call and DISTINCT paragraphs yield
 * DISTINCT tokens. It is derivable from identity the client already sees (both
 * ids ride on every `ShapedSource`), and it round-trips into `munin_get_document`
 * via the co-located `documentId`. This is an MCP-tier addition ALONGSIDE the
 * engine's `sourceId` — the engine's per-call minting is untouched.
 *
 * The space separator keeps the hash injective over the id pair (UUIDs never
 * contain a space, so "ab"+"c" and "a"+"bc" cannot collide); 12 hex chars
 * (48 bits) keeps accidental collisions negligible at any realistic local
 * corpus size while staying short enough to cite inline repeatedly.
 */
export function computeCiteAs(documentId: string, paragraphId: string): string {
  const digest = createHash('sha256').update(`${documentId}\u0000${paragraphId}`).digest('hex');
  return `S${digest.slice(0, 12)}`;
}

export interface ShapedSource {
  readonly sourceId: string;
  /**
   * Stable cross-call citation token (see `computeCiteAs`). Cite THIS inline;
   * `sourceId` is only a within-this-result display ordinal.
   */
  readonly citeAs: string;
  readonly text: string;
  readonly documentTitle: string | null;
  readonly documentId: string;
  readonly paragraphId: string;
  readonly method: string;
  /** Cosine distance for a direct vector hit; null for structural inclusion. */
  readonly distance: number | null;
}

export function shapeSource(source: ContextSource): ShapedSource {
  return {
    sourceId: source.sourceId,
    citeAs: computeCiteAs(source.paragraph.documentId, source.paragraph.id),
    text: source.paragraph.text,
    documentTitle: source.documentTitle ?? null,
    documentId: source.paragraph.documentId,
    paragraphId: source.paragraph.id,
    method: source.method,
    distance: source.distance,
  };
}

export interface ShapedCandidate {
  /** Pass this back as `pick` to select the candidate. */
  readonly pick: string;
  readonly label: string;
  readonly entityType: string;
  /** Distinguishing property values across the candidate's visible records. */
  readonly distinguishing: Readonly<Record<string, readonly string[]>>;
  readonly visibleRecordCount: number;
}

export interface ShapedDisambiguation {
  readonly status: 'disambiguation';
  readonly subject: string;
  readonly message: string;
  readonly candidates: readonly ShapedCandidate[];
}

export function shapeDisambiguation(
  subject: string,
  group: DisambiguationGroup,
  pickWasStale: boolean,
  /**
   * The tool the client should re-call to resolve the pick. Each surface passes
   * its own: munin_ask → 'munin_ask' (keep the user on the server-enforced path),
   * munin_gather_entity → 'munin_gather_entity'. munin_retrieve_context has no
   * `pick` argument, so it redirects to 'munin_gather_entity' (which returns the
   * same self-synthesis sources AND accepts a pick). Naming the right tool stops
   * an ask-originated disambiguation steering the client onto a weaker surface.
   */
  reCallTool: string,
): ShapedDisambiguation {
  const stale = pickWasStale
    ? 'The previous pick token no longer matches a candidate (the visible records changed). '
    : '';
  return {
    status: 'disambiguation',
    subject,
    message: `${stale}Several distinct matches share the name "${subject}". Ask the user which one they mean, then call ${reCallTool} again with the same subject "${subject}" and the chosen candidate’s \`pick\` token.`,
    candidates: group.candidates.map((c) => ({
      pick: c.token,
      label: c.logicalKey,
      entityType: c.entityType,
      distinguishing: c.distinguishing,
      visibleRecordCount: c.visibleRecordCount,
    })),
  };
}

/** The honest completeness banner for a gathered set, or null. */
export function completenessBanner(
  subject: string,
  mayHaveUnlinkedRecords: boolean,
): string | null {
  return mayHaveUnlinkedRecords
    ? `This set may be incomplete: there may be records about "${subject}" that are not yet linked to it.`
    : null;
}
