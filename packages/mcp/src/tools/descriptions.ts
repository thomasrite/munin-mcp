// Tool descriptions — extracted as a PURE function of the loaded configuration
// so they are unit-testable (S2 deliverable 2: an agent must reliably pick the
// right Munin tool unprompted). The descriptions contribute no vertical or
// persona words of their own; the only domain colour is the terminology nouns
// (records / subjects) the configuration supplies.

import type { Configuration } from '@muninhq/shared';

import { recordsNoun, subjectNouns } from '../terminology';

export interface ToolDescriptions {
  readonly munin_retrieve_context: string;
  readonly munin_ask: string;
  readonly munin_gather_entity: string;
  readonly munin_get_document: string;
  readonly munin_status: string;
}

// Join sentence fragments with single spaces. A function call (not `a + b`)
// keeps biome's useTemplate rule satisfied while the text stays readable as
// short, individually-quotable fragments.
function sentences(...parts: readonly string[]): string {
  return parts.join(' ');
}

export function buildToolDescriptions(configuration: Configuration): ToolDescriptions {
  const records = recordsNoun(configuration);
  const nouns = subjectNouns(configuration);
  const subjects = nouns.length > 0 ? nouns.join(', ') : 'named subjects';

  return {
    munin_retrieve_context: sentences(
      `Search this private Munin memory of ${records} and return ranked, cited, permission-filtered source paragraphs for a question — YOU then assemble the answer FROM THOSE SOURCES ONLY.`,
      `Choose this when the answer lives in genuinely private ${records} and you will faithfully assemble and cite it yourself from the returned sources. For any question that overlaps what you already know from training, or where strict grounding matters, prefer munin_ask instead — its grounding is ENFORCED server-side, whereas here the contract below rests on you.`,
      'Answer only from the returned sources: do NOT supplement from your own training or general knowledge, even when you are confident.',
      "Cite each claim inline with its source's stable citeAs token, and flag anything the sources do not cover as [not in memory] rather than filling the gap.",
      `It costs only one embedding lookup (no server-side answer model), but choose it for that faithful-private-synthesis case — not by default. Optionally pass a subject to focus on a named ${subjects}.`,
    ),
    munin_ask: sentences(
      `Ask this private Munin memory of ${records} a question and get a fully grounded answer synthesised server-side, with [n] citation markers backed by quoted sources — or an honest 'no_evidence' when nothing in the memory supports it.`,
      `Make this your DEFAULT for questions about the user's own ${records}, notes, or anything this memory might hold — even when the user never names Munin — and ALWAYS prefer it when the question overlaps what you already know from training or when strict grounding matters: this is the STRONGEST-grounding path, where synthesis, the fail-closed no_evidence contract and citation verification run server-side, not on your goodwill.`,
      'It spends the configured answer model; reach for munin_retrieve_context instead only when the material is genuinely private and you will assemble and cite the sources yourself.',
      `Optionally pass a subject (a named ${subjects}) to gather everything known about them and answer over that complete set with a completeness note; if several distinct ${subjects} share the name you get a 'disambiguation' result — ask the user which they mean, then re-call with the SAME subject plus that candidate's pick token (the pick is scoped to the named subject, so re-send both).`,
      "Preserve the [n] markers when you relay the answer (each maps to a citation carrying a stable citeAs token), and report 'no_evidence' as-is — never soften it into a guess or backfill it from your own knowledge.",
    ),
    munin_gather_entity: sentences(
      `Gather everything this memory holds about ONE named subject (${subjects}) by identity.`,
      'Use this instead of munin_retrieve_context when the user wants a complete dossier on a specific person or thing ("what do we know about X") rather than a topical search.',
      `If several distinct ${subjects} share the name, the result is status 'disambiguation' with candidates — ask the user which they mean, then re-call with that candidate's pick token.`,
      'Answer only from the returned sources — do NOT supplement from your own training; cite each with its stable citeAs token, flag uncovered points as [not in memory], and note that a gathered set flags when records may still be missing.',
    ),
    munin_get_document: sentences(
      'Fetch the full source text behind a citation: the document title and metadata plus its ordered paragraphs, each with its paragraphId.',
      'Use this to expand or verify a documentId you got from munin_retrieve_context, munin_ask, munin_gather_entity, or munin_status when the cited snippet is not enough.',
      "An unknown or inaccessible id returns a clean 'not_found' — it is never an existence oracle.",
    ),
    munin_status: sentences(
      `Quick, model-free health check of this Munin memory: how many ${records} and paragraphs it holds, the extracted-entity count, how many paragraphs still await extraction, the active tenant + loaded configuration, and a sample of the most-recently-ingested ${records} (title + id).`,
      'Use it to confirm the memory is populated, to see at a glance WHAT is in it, or to explain empty results (e.g. extraction still pending).',
    ),
  };
}
