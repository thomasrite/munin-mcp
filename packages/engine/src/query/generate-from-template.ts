// Template executor (M2.2) — composes a config DocumentTemplate + an M1 gathered
// record set + user-supplied slot values into a grounded, STRUCTURED document.
//
// GENERIC / vertical-agnostic: it operates on an opaque DocumentTemplate; the
// engine names no vertical document. The vertical template ("HR case summary")
// is config-supplied.
//
// REUSES the M2.1 core unchanged: the `auto-from-gather` sections run through
// generateDocument, so per-claim grounding + fail-closed + the completeness
// banner carry over verbatim. One gather feeds all auto sections.
//
// PROVENANCE CLASSES KEPT DISTINCT IN THE OUTPUT STRUCTURE (PLAN-M2.2 D3 /
// refinement 1): each rendered section is tagged `munin-asserted` (cited facts
// synthesised from the gather), `static` (template boilerplate), or
// `asked-of-user` (the human's own input). The structure — not just a markdown
// blob — is preserved so the M2.3 workspace can render Munin-asserted content
// VISIBLY distinct from boilerplate / user input. The grounding guarantee is
// scoped precisely to the munin-asserted class; static/asked content is never
// dressed up as a cited Munin fact.

import type { DocumentTemplate } from '@muninhq/shared';
import type { LLMProvider, ProviderCallContext } from '../providers';
import {
  type CompletenessDisposition,
  type GeneratedCitation,
  type GeneratedClaim,
  type GenerationSection,
  type GenerationSource,
  generateDocument,
} from './generate';

export interface TemplateGenerateRequest {
  readonly template: DocumentTemplate;
  readonly subject: string;
  readonly sources: readonly GenerationSource[];
  readonly completeness: { readonly mayHaveUnlinkedRecords: boolean; readonly recordCount: number };
  // Values the human supplied for `asked-of-user` sections, keyed by section
  // heading. A required asked section with no value renders as a gap (never
  // invented).
  readonly slotValues?: Readonly<Record<string, string>>;
  readonly model?: string;
  readonly maxOutputTokens?: number;
  // P5a — opaque personal style rules, threaded verbatim into the M2.1 core's
  // user message (never the cacheable prefix; see generate.ts). The template
  // executor does not interpret it.
  readonly learningRules?: string;
}

// Discriminated by provenance class — the whole point of the structure.
export type RenderedSection =
  | {
      readonly kind: 'munin-asserted';
      readonly heading: string;
      readonly format: DocumentTemplate['sections'][number]['format'];
      readonly claims: readonly GeneratedClaim[];
      readonly gap: boolean; // no grounded claim for this section
    }
  | {
      readonly kind: 'static';
      readonly heading: string;
      readonly format: DocumentTemplate['sections'][number]['format'];
      readonly text: string;
    }
  | {
      readonly kind: 'asked-of-user';
      readonly heading: string;
      readonly format: DocumentTemplate['sections'][number]['format'];
      readonly slotKind: string;
      readonly value: string | null; // null when the human supplied nothing
      readonly provided: boolean;
    };

export type TemplateDocumentStatus = 'generated' | 'no_evidence';

export interface TemplateDocument {
  readonly status: TemplateDocumentStatus;
  readonly templateId: string;
  readonly subject: string;
  readonly sections: readonly RenderedSection[];
  // Citations for the munin-asserted content only (the cited facts).
  readonly citations: readonly GeneratedCitation[];
  readonly completeness: CompletenessDisposition;
  readonly droppedClaims: number;
  readonly groundedClaimCount: number;
  // Convenience markdown render of the whole document.
  readonly body: string;
}

const normHeading = (h: string) => h.trim().toLowerCase();

/**
 * Execute a DocumentTemplate against a gathered record set. Reads nothing — the
 * sources were gathered + materialised by the caller under their ReadContext
 * (no new read path, no bypass). Auto sections reuse the M2.1 generation core.
 */
export async function generateFromTemplate(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  req: TemplateGenerateRequest,
): Promise<TemplateDocument> {
  const slotValues = req.slotValues ?? {};

  // 1. Collect the auto-from-gather sections and run them through M2.1 (one
  //    gather feeds all). Static/asked sections do NOT go to the model.
  const autoSections: GenerationSection[] = req.template.sections
    .filter((s) => s.fill.kind === 'auto-from-gather')
    .map((s) => ({
      heading: s.heading,
      instruction: s.fill.kind === 'auto-from-gather' ? s.fill.instruction : '',
    }));

  const generated =
    autoSections.length > 0
      ? await generateDocument(llm, ctx, {
          subject: req.subject,
          sections: autoSections,
          sources: req.sources,
          completeness: req.completeness,
          ...(req.model ? { model: req.model } : {}),
          ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
          ...(req.learningRules ? { learningRules: req.learningRules } : {}),
        })
      : null;

  // Map generated auto results by heading (robust to the model reordering); an
  // auto section with no matching result (or when generation returned
  // no_evidence) renders as a gap — its heading is preserved, never invented.
  const autoByHeading = new Map(
    (generated?.sections ?? []).map((s) => [normHeading(s.heading), s]),
  );

  // 2. Walk the template in order, building the provenance-tagged structure.
  const sections: RenderedSection[] = [];
  for (const section of req.template.sections) {
    if (section.fill.kind === 'auto-from-gather') {
      const result = autoByHeading.get(normHeading(section.heading));
      sections.push({
        kind: 'munin-asserted',
        heading: section.heading,
        format: section.format,
        claims: result?.claims ?? [],
        gap: !result || result.gap,
      });
    } else if (section.fill.kind === 'static') {
      sections.push({
        kind: 'static',
        heading: section.heading,
        format: section.format,
        text: section.fill.text,
      });
    } else {
      const value = slotValues[section.heading] ?? null;
      sections.push({
        kind: 'asked-of-user',
        heading: section.heading,
        format: section.format,
        slotKind: section.fill.slot.kind,
        value,
        provided: value !== null && value.trim().length > 0,
      });
    }
  }

  const citations = generated?.citations ?? [];
  const droppedClaims = generated?.droppedClaims ?? 0;
  const completeness = generated ? generated.completeness : dispositionFallback(req.completeness);
  const groundedClaimCount = sections
    .filter(
      (s): s is Extract<RenderedSection, { kind: 'munin-asserted' }> => s.kind === 'munin-asserted',
    )
    .reduce((n, s) => n + s.claims.length, 0);

  // The document is no_evidence only when it has NOTHING to show — no grounded
  // claim, no static boilerplate, and no supplied user input. Otherwise it is a
  // real draft (even if some auto sections gapped), for the human to complete.
  const hasContent =
    groundedClaimCount > 0 ||
    sections.some((s) => s.kind === 'static' && s.text.trim().length > 0) ||
    sections.some((s) => s.kind === 'asked-of-user' && s.provided);

  return {
    status: hasContent ? 'generated' : 'no_evidence',
    templateId: req.template.id,
    subject: req.subject,
    sections,
    citations,
    completeness,
    droppedClaims,
    groundedClaimCount,
    body: renderBody(sections),
  };
}

function dispositionFallback(c: TemplateGenerateRequest['completeness']): CompletenessDisposition {
  if (!c.mayHaveUnlinkedRecords) return { complete: true, recordCount: c.recordCount, note: null };
  return {
    complete: false,
    recordCount: c.recordCount,
    note: `Based on ${c.recordCount} record${c.recordCount === 1 ? '' : 's'}; there may be further records that could not be linked to this subject.`,
  };
}

function renderBody(sections: readonly RenderedSection[]): string {
  return sections
    .map((s) => {
      const heading = `## ${s.heading}`;
      let body: string;
      if (s.kind === 'munin-asserted') {
        body = s.gap
          ? '_No record found for this section._'
          : s.claims
              .map((c) => `${c.text} ${c.markers.map((m) => `[${m}]`).join('')}`)
              .join('\n\n');
      } else if (s.kind === 'static') {
        body = s.text;
      } else {
        body = s.provided ? (s.value as string) : '_[to be completed]_';
      }
      return `${heading}\n\n${body}`;
    })
    .join('\n\n');
}
