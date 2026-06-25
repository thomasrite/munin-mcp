// Grounded document generation (M2.1) — the safety keystone of the generation arm.
//
// Assembles a multi-section document/summary about a subject from an M1 GATHERED
// record set, where EVERY factual claim traces to a gathered, permitted record
// (the Q&A grounding guarantee, extended to generation). The unit of grounding
// is the CLAIM: the model emits atomic claims each backed by a verbatim quote;
// the engine verifies each quote against its cited paragraph and DROPS any claim
// that does not ground — its text never reaches output (fail-closed, literal).
//
// SAFETY PROPERTIES:
//   • Grounded + cited + fail-closed — an ungrounded claim is dropped and its
//     section gap marked; if NOTHING grounds, the document fails closed
//     (status 'no_evidence'). No confabulation path. The same off-path
//     QueryAuditor (decisions 18) may audit surviving claims for semantic
//     support (caller's choice; not on this hot path).
//   • Completeness-honesty — the document INHERITS the gather's
//     `mayHaveUnlinkedRecords` and surfaces it ("based on N records; there may
//     be more I could not link"). It reflects ONLY no-key/unlinked
//     incompleteness, NEVER permission-withheld records (computed over the
//     caller-visible space, inherited from the gather).
//
// PERMISSION-CORRECT: this module reads NOTHING. It consumes the sources the
// caller already gathered + materialised under the caller's ReadContext (no new
// read path, no internalBypass). It can therefore cite only records the caller
// can see.
//
// VERTICAL-AGNOSTIC: the section set is supplied by the caller (M2.2 will source
// it from a config DocumentTemplate); the engine names no vertical document.

import type { DocumentId, Paragraph, ParagraphId } from '../graph/types';
import type { LLMProvider, ProviderCallContext } from '../providers';
import { verifyQuoteGrounding } from './faithfulness';
import {
  GENERATION_TOOL_NAME,
  NO_EVIDENCE_DOCUMENT_MESSAGE,
  assembleGenerationPrompt,
} from './generation-prompt';
import {
  SECTION_RELEVANCE_TOOL_NAME,
  assembleSectionRelevancePrompt,
} from './section-relevance-prompt';

// One numbered source from the gathered set (materialised by the caller).
export interface GenerationSource {
  readonly sourceId: string; // "P1", "P2", … — assigned by the caller
  readonly paragraph: Paragraph;
  readonly documentTitle?: string;
}

// A requested section. `instruction` tells the model what to synthesise; the
// minimal built-in set (M2.1) is generic. M2.2 sources these from a config
// DocumentTemplate.
export interface GenerationSection {
  readonly heading: string;
  readonly instruction: string;
}

export interface GenerateRequest {
  readonly subject: string; // display name of the gathered entity
  readonly sections: readonly GenerationSection[];
  readonly sources: readonly GenerationSource[];
  // Inherited from the gather (M1.2). recordCount is the visible record count.
  readonly completeness: { readonly mayHaveUnlinkedRecords: boolean; readonly recordCount: number };
  readonly model?: string; // default: the generation model (Opus — the quality bar)
  readonly maxOutputTokens?: number;
  // COST CONTROL (Move 1, default ON). Route each section to only the sources it
  // needs via a cheap (Haiku) pre-step, so each (Opus) section call carries its
  // slice — not the full set — which on a multi-section, multi-source document is
  // the dominant input saving. Set false to send every source to every section
  // (e.g. a tiny document where the extra routing call is not worth it). A routing
  // miss can only GAP a section; it never ungrounds or fabricates a claim — the
  // per-claim verifier (`resolve`) is unchanged and still runs over the full set.
  readonly scopeSourcesToSections?: boolean;
  // P5a — the caller's accumulated personal style/preference rules, as a single
  // OPAQUE string. CACHE-SAFETY INVARIANT (F4): this is tenant content, so it
  // rides ONLY in the user-turn message (a <learning-rules> block, see
  // renderUserMessage) — NEVER the cacheable system/tool prefix. The engine never
  // reads a learning table; the web/metadata layer loads the rules and passes them
  // here. Additive guidance only: an injected rule cannot unground or fabricate a
  // claim — the per-claim verifier (`resolve`) is unchanged and still drops any
  // claim whose quote does not ground.
  readonly learningRules?: string;
}

// A surviving (grounded) claim's citation. Mirrors the Q&A Citation shape.
export interface GeneratedCitation {
  readonly marker: number;
  readonly paragraphId: ParagraphId;
  readonly documentId: DocumentId;
  readonly quote: string;
}

export interface CompletenessDisposition {
  readonly complete: boolean; // false when the gather flagged unlinked records
  readonly recordCount: number; // visible records the document is based on
  readonly note: string | null; // human-readable banner when not complete
}

export type GenerationStatus = 'generated' | 'no_evidence';

// One grounded claim: its text + the marker(s) of its supporting citation(s).
// A claim consolidating several near-identical records (M2.2 de-dup) keeps ALL
// its citations — de-dup is presentational; grounding completeness is not lost.
export interface GeneratedClaim {
  readonly text: string;
  readonly markers: readonly number[];
}

// A rendered section's structured result. The STRUCTURE (not just a markdown
// blob) is preserved so a caller — the M2.2 template executor, then the M2.3
// workspace — can render Munin-asserted claims visibly distinct from boilerplate
// / user input.
export interface GeneratedSectionResult {
  readonly heading: string;
  readonly claims: readonly GeneratedClaim[];
  readonly gap: boolean; // true when the section had no grounded claim
}

export interface GeneratedDocument {
  readonly status: GenerationStatus;
  // Rendered markdown: per section a heading then its grounded claims (each
  // "claim text [n]…"), or an explicit gap line when a section has no grounded
  // claim. Empty string when status is 'no_evidence'. Convenience view.
  readonly body: string;
  // Structured sections (the source of truth for downstream rendering).
  readonly sections: readonly GeneratedSectionResult[];
  readonly citations: readonly GeneratedCitation[];
  readonly completeness: CompletenessDisposition;
  // Citations the model emitted whose quote did NOT ground → dropped (never
  // rendered). Informative (an integrity signal), not an error.
  readonly droppedClaims: number;
}

// Default generation model. Reads GENERATION_MODEL (default Sonnet — Opus is not
// enabled on the Bedrock account; set GENERATION_MODEL to 'claude-opus-4-7' once
// access is granted). Per-call override via req.model still wins.
// Env read, not a prompt/retrieval change.
const DEFAULT_GENERATION_MODEL = process.env.GENERATION_MODEL?.trim() || 'claude-sonnet-4-6';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const GAP_LINE = '_No record found for this section._';

// The section-relevance routing pre-step (Move 1) runs on the CHEAP model — it
// only routes sources to sections, never writes prose. The quality-bearing
// per-section writing stays on the generation model (Opus). Right-sized: a
// routing miss can only gap a section, never fabricate (the per-claim verifier is
// unchanged). A model-id string is generic engine config, like the Opus default
// above — no vertical concept.
const SECTION_RELEVANCE_MODEL = 'claude-haiku-4-5-20251001';
// The routing output is tiny (per source: an id + a few section numbers). Ample
// headroom; a routing call that nonetheless truncates is treated as "no routing"
// and falls back to the full source set (never under-grounds a section).
const SECTION_RELEVANCE_MAX_OUTPUT_TOKENS = 2048;

/**
 * Raised when a generation call is cut off by the output-token ceiling
 * (`stopReason === 'max_tokens'`). F30: a truncated `submit_document` tool call
 * yields incomplete/unparseable JSON, which would otherwise be swallowed as a
 * SILENT `no_evidence` — indistinguishable from "the sources genuinely support
 * nothing". That is the F30 failure mode: an empty document on the subject with
 * the MOST records. Surfacing truncation as a distinct, LOUD error means a
 * too-large generation can never masquerade as honest emptiness; the caller (or
 * the M2.2 section-chunked executor) handles it explicitly.
 */
export class GenerationTruncatedError extends Error {
  readonly outputTokens: number;
  readonly maxOutputTokens: number;
  constructor(outputTokens: number, maxOutputTokens: number) {
    super(
      `Generation was truncated by the output-token limit (emitted ${outputTokens} of ${maxOutputTokens} max). The document is too large to generate in a single call; split it (e.g. per section) and retry. A truncated response is NOT treated as no_evidence.`,
    );
    this.name = 'GenerationTruncatedError';
    this.outputTokens = outputTokens;
    this.maxOutputTokens = maxOutputTokens;
  }
}

/**
 * Generate a grounded document from a gathered record set. Reads nothing; pure
 * over the passed sources. Fail-closed per claim.
 *
 * F30 — SECTION-CHUNKED. Rather than one LLM call that must emit the WHOLE
 * document within a single output-token budget (which truncated to a silent
 * empty doc on the largest subjects), this runs ONE grounding call PER SECTION.
 * Each section call carries the full source set but emits only that section's
 * claims, so per-call output is bounded by one section — well under the cap even
 * for large N. The per-claim, purely-local fail-closed grounding guarantee
 * (`verifyQuoteGrounding`, one quote vs one paragraph, no cross-claim/cross-call
 * state) is preserved by construction: we assemble already-verified survivors.
 *
 * Citation markers are assigned GLOBALLY at assembly time (each section call's
 * own marker numbering is internal and discarded), so there is no collision or
 * mislink when per-section results are merged.
 *
 * COST (Move 1): rather than send the FULL source set to every section call
 * (F32: the static prefix is below Anthropic's ~1024-token cache floor, and the
 * sources sit in the never-cacheable user turn, so caching never fired and each
 * Opus call re-billed the whole set), a cheap (Haiku) routing pre-step scopes
 * each section to only the sources it needs. Each Opus call then carries its
 * slice. Grounding is untouched: `resolve` still verifies every surviving claim's
 * quote against the caller's FULL gathered set, so a routing miss can only GAP a
 * section (conservative) — never ground a fabricated claim.
 */
export async function generateDocument(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  req: GenerateRequest,
): Promise<GeneratedDocument> {
  const completeness = dispositionOf(req.completeness);

  // No sources → nothing can ground. Fail closed without spending a call.
  // No sections → nothing to emit.
  if (req.sources.length === 0 || req.sections.length === 0) {
    return emptyDocument(completeness);
  }

  // Move 1 — scope each section to only the sources it needs (cheap Haiku routing
  // pre-step). Cost only; grounding unaffected. Falls back to the full set on any
  // doubt, so it is never worse than sending everything. Opt out with
  // scopeSourcesToSections: false.
  const scopedByHeading =
    req.scopeSourcesToSections === false ? null : await scopeSourcesPerSection(llm, ctx, req);

  // One call per section. A section that genuinely grounds nothing yields an
  // empty (gapped) section; a section TRUNCATED by the output cap throws
  // GenerationTruncatedError (loud — never a silent empty section).
  const perSection: ParsedSection[] = [];
  for (const section of req.sections) {
    const scopedSources = scopedByHeading?.get(section.heading) ?? req.sources;
    const parsed = await generateOneSection(llm, ctx, req, section, scopedSources);
    // A section the model marked no_evidence, or with no claims, still occupies
    // its heading as a gap (heading preserved, never invented/dropped).
    perSection.push(parsed ?? { heading: section.heading, claims: [] });
  }

  return resolve({ status: 'generated', sections: perSection }, req.sources, completeness);
}

/**
 * One grounding call for a SINGLE section. Returns the parsed section (claims
 * still un-grounded — grounding happens at assembly), or null when the model
 * emitted no usable section for it. Throws GenerationTruncatedError if the call
 * hit the output-token ceiling.
 */
async function generateOneSection(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  req: GenerateRequest,
  section: GenerationSection,
  scopedSources: readonly GenerationSource[],
): Promise<ParsedSection | null> {
  const prompt = assembleGenerationPrompt();
  // Single-section request carrying only THIS section's scoped sources (Move 1).
  // sourceIds stay global, so `resolve` maps a cited id to the right paragraph in
  // the full set regardless of which slice the model saw.
  const userMessage = renderUserMessage({ ...req, sources: scopedSources, sections: [section] });
  const maxOutputTokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const response = await llm.complete(
    {
      model: req.model ?? DEFAULT_GENERATION_MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: userMessage }],
      cacheableSystemPrefix: true,
      maxOutputTokens,
      tools: [prompt.tool],
      toolChoice: { type: 'tool', name: prompt.toolName },
    },
    ctx,
  );

  // F30 truncation guard — BEFORE parsing. A call cut off by the output-token
  // ceiling yields truncated/unparseable tool JSON; parsing it would silently
  // empty this section (indistinguishable from honest emptiness). Surface
  // truncation LOUD instead — per section, so a too-large SECTION still cannot
  // masquerade as honest emptiness.
  if (response.stopReason === 'max_tokens') {
    throw new GenerationTruncatedError(response.outputTokens, maxOutputTokens);
  }

  const call = response.toolCalls.find((c) => c.name === GENERATION_TOOL_NAME);
  const parsed = call ? parseDocumentInput(call.input) : null;
  if (!parsed || parsed.status === 'no_evidence') return null;

  // The model was asked for ONE section. Prefer the section whose heading
  // matches the requested one; fall back to the first emitted section. Either
  // way we relabel it with the REQUESTED heading so the assembled document's
  // headings are authoritative (never model-invented).
  const norm = (h: string) => h.trim().toLowerCase();
  const match =
    parsed.sections.find((s) => norm(s.heading) === norm(section.heading)) ?? parsed.sections[0];
  if (!match) return null;
  return { heading: section.heading, claims: match.claims };
}

// ---------------------------------------------------------------------------
// Move 1 — per-section source scoping (cheap Haiku routing pre-step)
// ---------------------------------------------------------------------------

/**
 * Route each gathered source to the section(s) it could support, so each Opus
 * section call carries only its slice. Returns a map (section heading → its
 * scoped sources), or null to mean "no scoping — every section gets the full
 * set" (the safe default whenever routing is skipped, fails, truncates, or
 * yields nothing usable).
 *
 * COST ONLY. The cheap router can MISS, but a miss only shrinks a section's input
 * (it then grounds fewer claims / gaps — conservative). It can never produce an
 * ungrounded or fabricated claim, because `resolve` is unchanged and verifies
 * every surviving quote against the caller's FULL gathered set. Conservative
 * choices throughout: a section the router assigns NOTHING falls back to the full
 * set rather than gapping on the router's word.
 */
async function scopeSourcesPerSection(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  req: GenerateRequest,
): Promise<Map<string, readonly GenerationSource[]> | null> {
  // A single section already receives the whole set — nothing to narrow, and the
  // routing call would be pure overhead.
  if (req.sections.length <= 1) return null;

  let routing: Map<string, Set<number>> | null = null;
  try {
    const prompt = assembleSectionRelevancePrompt();
    const response = await llm.complete(
      {
        // The CHEAP model — never the (Opus) generation model. Routing, not prose.
        model: SECTION_RELEVANCE_MODEL,
        system: prompt.system,
        messages: [{ role: 'user', content: renderRelevanceUserMessage(req) }],
        cacheableSystemPrefix: true,
        maxOutputTokens: SECTION_RELEVANCE_MAX_OUTPUT_TOKENS,
        tools: [prompt.tool],
        toolChoice: { type: 'tool', name: prompt.toolName },
      },
      ctx,
    );
    // A truncated routing call yields a partial map — under-routing a section
    // would silently shrink its input. Treat truncation as "no routing" (full set).
    if (response.stopReason !== 'max_tokens') {
      const call = response.toolCalls.find((c) => c.name === SECTION_RELEVANCE_TOOL_NAME);
      routing = call ? parseRelevance(call.input) : null;
    }
  } catch {
    // Any provider failure → fall back to the full set per section (never worse
    // than today; generation must not fail because the cheap pre-step did).
    routing = null;
  }
  if (!routing) return null;
  const routed = routing;

  const result = new Map<string, readonly GenerationSource[]>();
  req.sections.forEach((section, idx) => {
    const sectionNumber = idx + 1;
    const scoped = req.sources.filter((s) => routed.get(s.sourceId)?.has(sectionNumber));
    // Conservative: a section the router left empty gets the FULL set, so a router
    // miss can never gap a section that real sources could have supported.
    result.set(section.heading, scoped.length > 0 ? scoped : req.sources);
  });
  return result;
}

// The routing user turn: the indexed sections + every source's text. Carries
// tenant content, so (like the generation user turn) it is NEVER cacheable. Uses
// a `[n] heading — instruction` section format deliberately distinct from the
// generation prompt's <section heading="…"> so the two turns never alias.
function renderRelevanceUserMessage(req: GenerateRequest): string {
  const lines: string[] = [];
  lines.push('<sections>');
  req.sections.forEach((section, idx) => {
    lines.push(
      `[${idx + 1}] ${neutraliseAngleBrackets(section.heading)} — ${neutraliseAngleBrackets(section.instruction)}`,
    );
  });
  lines.push('</sections>');
  lines.push('');
  lines.push('<sources>');
  for (const s of req.sources) {
    lines.push(
      `<source id="${s.sourceId}">\n${neutraliseAngleBrackets(s.paragraph.text)}\n</source>`,
    );
  }
  lines.push('</sources>');
  return lines.join('\n');
}

// Parse the routing tool input into sourceId → set of 1-based section numbers.
// Defensive (the tool schema already constrains the shape); a malformed payload
// yields null → the caller falls back to the full set.
function parseRelevance(input: Readonly<Record<string, unknown>>): Map<string, Set<number>> | null {
  if (!Array.isArray(input.sources)) return null;
  const out = new Map<string, Set<number>>();
  for (const raw of input.sources) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.sourceId !== 'string' || !Array.isArray(r.sectionNumbers)) continue;
    const numbers = new Set<number>();
    for (const n of r.sectionNumbers) {
      if (typeof n === 'number' && Number.isInteger(n)) numbers.add(n);
    }
    out.set(r.sourceId, numbers);
  }
  return out;
}

function emptyDocument(completeness: CompletenessDisposition): GeneratedDocument {
  return {
    status: 'no_evidence',
    body: '',
    sections: [],
    citations: [],
    completeness,
    droppedClaims: 0,
  };
}

// ---------------------------------------------------------------------------
// Grounding resolution — claim-level, fail-closed
// ---------------------------------------------------------------------------
function resolve(
  parsed: ParsedDocument,
  sources: readonly GenerationSource[],
  completeness: CompletenessDisposition,
): GeneratedDocument {
  const bySourceId = new Map(sources.map((s) => [s.sourceId, s.paragraph]));
  const citations: GeneratedCitation[] = [];
  const sections: GeneratedSectionResult[] = [];
  let marker = 0;
  let dropped = 0;

  for (const section of parsed.sections) {
    const claims: GeneratedClaim[] = [];
    for (const claim of section.claims) {
      const text = claim.text.trim();
      if (text.length === 0) {
        // An empty claim contributes nothing; count each of its citations as a
        // drop (they assert nothing renderable).
        dropped += claim.citations.length;
        continue;
      }
      // A claim may carry MORE THAN ONE citation (M2.2 de-dup consolidates
      // near-identical records into one claim while KEEPING every source). Each
      // citation is verified independently; ungrounded ones are dropped; the
      // claim survives iff at least one citation grounds. So an ungrounded
      // assertion never reaches output, and a consolidated claim retains the
      // full provenance of every record it merged (refinement 2).
      const markers: number[] = [];
      for (const cite of claim.citations) {
        const paragraph = bySourceId.get(cite.sourceId);
        if (!paragraph || !verifyQuoteGrounding(cite.quote, paragraph.text)) {
          dropped++;
          continue;
        }
        marker += 1;
        markers.push(marker);
        citations.push({
          marker,
          paragraphId: paragraph.id,
          documentId: paragraph.documentId,
          quote: cite.quote,
        });
      }
      if (markers.length === 0) continue; // no citation grounded → drop the claim text entirely
      claims.push({ text, markers });
    }
    sections.push({
      heading: section.heading.trim() || 'Section',
      claims,
      gap: claims.length === 0,
    });
  }

  // Systemic grounding failure: no claim survived anywhere → fail the document
  // closed (the no_evidence analogue). Reserve "fail the document" for this; a
  // partial drop is handled per-section above.
  if (citations.length === 0) {
    return { ...emptyDocument(completeness), droppedClaims: dropped };
  }

  return {
    status: 'generated',
    body: renderBody(sections),
    sections,
    citations,
    completeness,
    droppedClaims: dropped,
  };
}

// Render the structured sections to the convenience markdown `body`.
function renderBody(sections: readonly GeneratedSectionResult[]): string {
  return sections
    .map((s) => {
      const heading = `## ${s.heading}`;
      const body = s.gap
        ? GAP_LINE
        : s.claims.map((c) => `${c.text} ${c.markers.map((m) => `[${m}]`).join('')}`).join('\n\n');
      return `${heading}\n\n${body}`;
    })
    .join('\n\n');
}

function dispositionOf(c: GenerateRequest['completeness']): CompletenessDisposition {
  if (!c.mayHaveUnlinkedRecords) {
    return { complete: true, recordCount: c.recordCount, note: null };
  }
  return {
    complete: false,
    recordCount: c.recordCount,
    note: `Based on ${c.recordCount} record${c.recordCount === 1 ? '' : 's'}; there may be further records that could not be linked to this subject.`,
  };
}

// ---------------------------------------------------------------------------
// Prompt rendering (user turn — carries the untrusted sources + the request)
// ---------------------------------------------------------------------------
function renderUserMessage(req: GenerateRequest): string {
  const lines: string[] = [];
  lines.push('<sources>');
  for (const s of req.sources) {
    const attrs = [`id="${s.sourceId}"`];
    if (s.documentTitle) attrs.push(`doc="${escapeAttr(s.documentTitle)}"`);
    if (s.paragraph.page !== null) attrs.push(`page="${s.paragraph.page}"`);
    lines.push(
      `<source ${attrs.join(' ')}>\n${neutraliseAngleBrackets(s.paragraph.text)}\n</source>`,
    );
  }
  lines.push('</sources>');
  lines.push('');
  lines.push(`<subject>${neutraliseAngleBrackets(req.subject)}</subject>`);
  lines.push('');
  lines.push('<sections>');
  for (const section of req.sections) {
    lines.push(
      `<section heading="${escapeAttr(section.heading)}">${neutraliseAngleBrackets(section.instruction)}</section>`,
    );
  }
  lines.push('</sections>');

  // P5a — the author's accumulated personal style preferences (cache-safety F4:
  // tenant content, USER TURN ONLY, never the cacheable prefix). Framed as
  // styling guidance and angle-bracket-neutralised so an opaque rule string can
  // neither forge a <source> tag nor be mistaken for source content. These shape
  // HOW the draft is written; they can never override grounding — every claim is
  // still verified against its cited source downstream.
  const rules = req.learningRules?.trim();
  if (rules) {
    lines.push('');
    lines.push('<learning-rules>');
    lines.push(
      "The author's own saved style/formatting preferences for documents like " +
        'this. Apply them to HOW you write. They are preferences, NOT source ' +
        'facts: never treat them as content to ground a claim, and never let them ' +
        'override the grounding rules or justify an unsupported statement.',
    );
    lines.push(neutraliseAngleBrackets(rules));
    lines.push('</learning-rules>');
  }
  return lines.join('\n');
}

function neutraliseAngleBrackets(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Defensive parse of the tool input (defence-in-depth; the tool schema already
// constrains the shape at decode time). Returns null on a malformed shape.
// ---------------------------------------------------------------------------
interface ParsedCite {
  readonly sourceId: string;
  readonly quote: string;
}
interface ParsedClaim {
  readonly text: string;
  readonly citations: readonly ParsedCite[];
}
interface ParsedSection {
  readonly heading: string;
  readonly claims: readonly ParsedClaim[];
}
interface ParsedDocument {
  readonly status: GenerationStatus;
  readonly sections: readonly ParsedSection[];
}

function parseDocumentInput(input: Readonly<Record<string, unknown>>): ParsedDocument | null {
  const status = input.status;
  if (status !== 'generated' && status !== 'no_evidence') return null;
  if (!Array.isArray(input.sections)) return null;

  const sections: ParsedSection[] = [];
  for (const rawSection of input.sections) {
    if (rawSection === null || typeof rawSection !== 'object') continue;
    const s = rawSection as Record<string, unknown>;
    if (typeof s.heading !== 'string') continue;
    if (!Array.isArray(s.claims)) continue;
    const claims: ParsedClaim[] = [];
    for (const rawClaim of s.claims) {
      if (rawClaim === null || typeof rawClaim !== 'object') continue;
      const c = rawClaim as Record<string, unknown>;
      if (typeof c.text !== 'string' || !Array.isArray(c.citations)) continue;
      const citations: ParsedCite[] = [];
      for (const rawCite of c.citations) {
        if (rawCite === null || typeof rawCite !== 'object') continue;
        const ct = rawCite as Record<string, unknown>;
        if (typeof ct.sourceId !== 'string' || typeof ct.quote !== 'string') continue;
        citations.push({ sourceId: ct.sourceId, quote: ct.quote });
      }
      claims.push({ text: c.text, citations });
    }
    sections.push({ heading: s.heading, claims });
  }
  return { status, sections };
}

export { NO_EVIDENCE_DOCUMENT_MESSAGE };
