// Pure scorer for the personal template-generation leg.
//
// The harness gathers a subject's records, runs the engine generation core over
// the template's auto-from-gather sections, then RE-VERIFIES every surviving
// citation by independently grounding its quote against the cited paragraph
// (verifyQuoteGrounding) — that verdict is fed here. This scorer judges:
//
//   • structurePreserved — the generated sections reproduce the template's
//     declared auto-section headings, in order. The executor never invents or
//     reorders headings, so a mismatch is a real regression signal.
//   • sectionsFilled / sectionsTotal — how many auto sections produced ≥1
//     grounded claim vs rendered as an empty gap. Coverage, not a hard gate
//     (a weak local model legitimately gaps a section it can't ground).
//   • groundingPass — THE HARD BAR: every surviving claim re-grounded. An
//     ungrounded survivor is a fail-closed bug, so groundingPass is false iff
//     any survivor failed re-verification. Dropped claims (caught by the engine
//     before emission) are reported but are not failures — that is the engine
//     correctly refusing to assert what it cannot ground.
//
// Pure: no engine, no DB, no provider. Vertical-agnostic.

// One generated section as the harness observed it.
export interface GeneratedSectionObservation {
  readonly heading: string;
  readonly claimCount: number; // grounded claims kept in this section
  readonly gap: boolean; // rendered as an empty section (no grounded claim)
}

export interface GenerationObservation {
  readonly subject: string;
  readonly status: 'generated' | 'no_evidence';
  // Template auto-section headings in declared order (what we expect to see).
  readonly expectedHeadings: readonly string[];
  readonly sections: readonly GeneratedSectionObservation[];
  // Per surviving citation: did its quote independently re-ground in its cited
  // paragraph? Length === surviving citation count.
  readonly regroundVerdicts: readonly boolean[];
  readonly droppedClaims: number;
  readonly recordCount: number;
}

export interface GenerationScore {
  readonly subject: string;
  readonly status: 'generated' | 'no_evidence';
  readonly structurePreserved: boolean;
  readonly sectionsTotal: number;
  readonly sectionsFilled: number;
  readonly survivingClaims: number;
  readonly regroundedClaims: number; // survivors that re-grounded
  readonly ungroundedSurvivors: number; // MUST be 0
  readonly groundingPass: boolean;
  readonly droppedClaims: number;
  readonly recordCount: number;
}

// Headings of the auto sections actually generated, in order (gap or not — the
// executor preserves the heading either way).
function generatedHeadings(o: GenerationObservation): string[] {
  return o.sections.map((s) => s.heading);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function scoreGeneration(o: GenerationObservation): GenerationScore {
  const survivingClaims = o.regroundVerdicts.length;
  const regroundedClaims = o.regroundVerdicts.filter(Boolean).length;
  const ungroundedSurvivors = survivingClaims - regroundedClaims;

  // A no_evidence document (the gather found nothing for the subject) trivially
  // has no ungrounded survivor — grounding is vacuously satisfied; coverage is 0.
  const groundingPass = ungroundedSurvivors === 0;

  // Structure is only meaningful for a generated document; a no_evidence run
  // produces no synthesised sections, so it neither preserves nor breaks structure.
  const structurePreserved =
    o.status === 'generated' && arraysEqual(generatedHeadings(o), o.expectedHeadings);

  return {
    subject: o.subject,
    status: o.status,
    structurePreserved,
    sectionsTotal: o.expectedHeadings.length,
    sectionsFilled: o.sections.filter((s) => !s.gap && s.claimCount > 0).length,
    survivingClaims,
    regroundedClaims,
    ungroundedSurvivors,
    groundingPass,
    droppedClaims: o.droppedClaims,
    recordCount: o.recordCount,
  };
}

export interface GenerationLegScore {
  readonly subjects: number;
  readonly generated: number; // status === 'generated'
  readonly structurePreserved: number; // of generated docs
  readonly totalSurviving: number;
  readonly totalRegrounded: number;
  readonly totalUngrounded: number; // MUST be 0
  readonly totalDropped: number;
  readonly groundingPass: boolean; // no ungrounded survivor across all subjects
  readonly perSubject: readonly GenerationScore[];
}

export function aggregateGenerationScores(scores: readonly GenerationScore[]): GenerationLegScore {
  const generated = scores.filter((s) => s.status === 'generated');
  const totalUngrounded = scores.reduce((n, s) => n + s.ungroundedSurvivors, 0);
  return {
    subjects: scores.length,
    generated: generated.length,
    structurePreserved: generated.filter((s) => s.structurePreserved).length,
    totalSurviving: scores.reduce((n, s) => n + s.survivingClaims, 0),
    totalRegrounded: scores.reduce((n, s) => n + s.regroundedClaims, 0),
    totalUngrounded,
    totalDropped: scores.reduce((n, s) => n + s.droppedClaims, 0),
    groundingPass: totalUngrounded === 0,
    perSubject: scores,
  };
}
