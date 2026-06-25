// Synthetic personal-prose eval corpus — 9 short documents in the four styles
// the configuration targets: meeting notes, journal entries, reading notes,
// project logs. ENTIRELY INVENTED content: every person, project, topic, and
// titled work is fictional; nothing here is or resembles real personal data.
//
// Deliberately DISJOINT from the few-shots in ../entities.ts (different names,
// projects, topics, sources) so the eval measures generalisation, not recall
// of the prompt. Two documents are pure chatty prose and should extract
// NOTHING — they exist to measure restraint (the F12 lesson: over-extraction
// is the failure mode). Several documents carry precision traps: untitled
// works ("some cooking videos"), errands that are not projects ("booked the
// MOT"), and a person who PICKED a book but did not write it.

export interface PersonalEvalDoc {
  // Basename the document is ingested under.
  readonly file: string;
  // Full text; paragraphs are separated by blank lines.
  readonly text: string;
}

export const personalEvalCorpus: readonly PersonalEvalDoc[] = [
  {
    file: 'meeting-2026-03-04-printshop.md',
    text: `Meeting notes — 4 March 2026

Sat down with Callum Reyes at the print shop to plan the zine project, 'Paper Lantern'. He will handle the layout; I am collecting the submissions. We agreed on a June deadline for the first issue.

Callum suggested asking Wren to illustrate the cover — she did the posters for the climbing club last year and works fast.`,
  },
  {
    file: 'journal-2026-01-18.md',
    text: `Sunday. Rain all day. Did nothing useful — long bath, leftover soup, half a film I did not finish. My brother texted about the weekend but I have not replied yet.

Early night. Tomorrow: actually start the week.`,
  },
  {
    file: 'reading-the-quiet-orchard.md',
    text: `Reading notes — 'The Quiet Orchard'

Started 'The Quiet Orchard' by Sefa Adeyemi. It is a book about attention — the orchard chapters are really an argument for noticing things slowly, one tree at a time.

The section on pruning doubles as advice on cutting commitments. Want to come back to this in the autumn.`,
  },
  {
    file: 'project-log-darkroom.md',
    text: `Darkroom conversion — log

12 Feb. The darkroom conversion is moving again. Cleared the box room and sealed the window. The enlarger arrives Thursday.

19 Feb. Plumbing is in. Marta came over to help wire the safelight — she has built two darkrooms before. Still need the extractor fan before any chemistry happens.`,
  },
  {
    file: 'meeting-2026-02-10-bookclub.md',
    text: `Book club, 10 February

Six of us this month. Theo picked 'Salt Roads North' for April — he says the river chapters are the best travel writing he has read in years.

Ana suggested we alternate fiction and non-fiction from the summer. Agreed to decide at the next meeting.`,
  },
  {
    file: 'reading-notes-batteries.md',
    text: `Clipped 'The Long Discharge' from the weekend paper — an article on home battery storage. Main argument: payback periods are shrinking faster than installers admit. The comparison of winter usage patterns was the most useful part.

Follow-up: find the report it cites on seasonal storage.`,
  },
  {
    file: 'journal-2026-03-21.md',
    text: `Long call with Imogen tonight about the cabin renovation — the surveyor's report came back better than feared. She wants to start on the roof in May; I said I would take a week off to help.

Otherwise: ran 8k, slowest in months. Spring, allegedly.`,
  },
  {
    file: 'project-log-lexika.md',
    text: `Lexika — week 3

Lexika, the flashcard app I am building for Finnish vocab, now has 400 cards. Kerttu is recording audio for the pronunciation deck this week.

Spent the evening reading about spaced repetition — switched the scheduler to expanding intervals and my retention is already better.`,
  },
  {
    file: 'journal-2026-04-02.md',
    text: `Wednesday. The neighbours' scaffolding went up at seven, so the day started earlier than planned. Errands: dropped the parcels, picked up the prescription, finally booked the MOT.

Dinner was just pasta. Watched some cooking videos and went to bed early.`,
  },
];

// Split a document into the paragraphs the engine would store (blank-line
// separated) — the eval inserts these directly, bypassing file I/O.
export function paragraphsOf(doc: PersonalEvalDoc): string[] {
  return doc.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
