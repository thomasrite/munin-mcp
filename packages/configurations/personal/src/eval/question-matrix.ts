// Hand-authored Q&A question matrix for the personal eval corpus (corpus.ts).
//
// Each item is a question the owner might ask their own notes, carrying its
// KNOWN-correct answer so the e2e harness can SCORE the real ask path
// (QueryPipeline) against ground truth, not just eyeball it:
//   • expectedFacts — substrings an accurate answer MUST contain (all of them).
//   • expectedSource — the single corpus paragraph a correct citation must point
//     at: { docFile, paragraphIndex } where paragraphIndex is the 0-based index
//     into paragraphsOf(doc) (blank-line split). Citation-match checks the cited
//     paragraph is the RIGHT one, not merely that *a* citation exists.
//   • expectedStatus — 'answered' for corpus-grounded questions; 'no_evidence'
//     for the NEGATIVE cases (a fact absent from the corpus must yield the honest
//     decline, never an invented answer — this is the no-fabrication probe).
//
// ENTIRELY SYNTHETIC: every name, work, and project is fictional, matching
// corpus.ts. Generic-personal only — no vertical (MAT/HR/safeguarding) concept.
// Paragraph indices are pinned to corpus.ts; the question-matrix unit test
// re-derives them from the corpus so a corpus edit that moves a paragraph fails
// loudly rather than silently scoring the wrong span.

export interface PersonalQuestion {
  readonly id: string;
  readonly question: string;
  // All must appear (case-insensitive substring) in an accurate answer.
  readonly expectedFacts: readonly string[];
  // The corpus paragraph a correct citation must point at. Omitted for negatives.
  readonly expectedSource?: { readonly docFile: string; readonly paragraphIndex: number };
  readonly expectedStatus: 'answered' | 'no_evidence';
}

export const personalQuestionMatrix: readonly PersonalQuestion[] = [
  {
    id: 'qa-author',
    question: "Who wrote 'The Quiet Orchard'?",
    expectedFacts: ['Sefa Adeyemi'],
    expectedSource: { docFile: 'reading-the-quiet-orchard.md', paragraphIndex: 1 },
    expectedStatus: 'answered',
  },
  {
    id: 'qa-zine-layout',
    question: 'Who is handling the layout for the Paper Lantern zine?',
    expectedFacts: ['Callum'],
    expectedSource: { docFile: 'meeting-2026-03-04-printshop.md', paragraphIndex: 1 },
    expectedStatus: 'answered',
  },
  {
    id: 'qa-darkroom-safelight',
    question: 'Who helped wire the safelight during the darkroom conversion?',
    expectedFacts: ['Marta'],
    expectedSource: { docFile: 'project-log-darkroom.md', paragraphIndex: 2 },
    expectedStatus: 'answered',
  },
  {
    id: 'qa-lexika',
    question: 'What is Lexika?',
    expectedFacts: ['flashcard'],
    expectedSource: { docFile: 'project-log-lexika.md', paragraphIndex: 1 },
    expectedStatus: 'answered',
  },
  {
    id: 'qa-long-discharge',
    question: "What is the article 'The Long Discharge' about?",
    expectedFacts: ['battery'],
    expectedSource: { docFile: 'reading-notes-batteries.md', paragraphIndex: 0 },
    expectedStatus: 'answered',
  },
  {
    id: 'qa-bookclub-april',
    question: 'Which book did Theo pick for the book club in April?',
    expectedFacts: ['Salt Roads North'],
    expectedSource: { docFile: 'meeting-2026-02-10-bookclub.md', paragraphIndex: 1 },
    expectedStatus: 'answered',
  },
  {
    id: 'qa-cabin',
    question: 'What is Imogen renovating?',
    expectedFacts: ['cabin'],
    expectedSource: { docFile: 'journal-2026-03-21.md', paragraphIndex: 0 },
    expectedStatus: 'answered',
  },
  // --- NEGATIVE cases: nothing in the corpus answers these. A grounded,
  //     fail-closed pipeline must DECLINE (no_evidence), not invent an answer.
  {
    id: 'qa-negative-absent-person',
    question: 'What did Gregory Wainwright decide about the budget?',
    expectedFacts: [],
    expectedStatus: 'no_evidence',
  },
  {
    id: 'qa-negative-off-topic',
    question: 'What is the capital of France?',
    expectedFacts: [],
    expectedStatus: 'no_evidence',
  },
];

// People the dossier-generation leg drafts for. Each is a Person named in the
// corpus with at least one groundable activity, so a correct extraction yields a
// gatherable record set. (A subject the local model fails to extract surfaces as
// a measured gap — recordCount 0 → no_evidence — not a harness error.)
export const personalGenerationSubjects: readonly string[] = [
  'Callum Reyes',
  'Marta',
  'Kerttu',
  'Imogen',
];
