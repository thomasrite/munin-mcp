// Hand-authored ground truth for the personal eval corpus (corpus.ts).
//
// Per document: the entities (type + canonical key + accepted aliases) and the
// relationships a correct extraction should produce. Aliases absorb honest
// surface variation (a model writing "battery storage" for "home battery
// storage") WITHOUT crediting wrong extractions — keep them tight.
//
// Deliberate negatives (entities that must NOT be credited, encoded simply by
// their absence): the writer and unnamed relations ("my brother", "the
// neighbours"); untitled works ("some cooking videos", "the report it
// cites"); errands ("booked the MOT"); and Theo, who PICKED 'Salt Roads
// North' but did not write it — an authoredBy edge there is a false positive.

export interface PersonalEvalEntity {
  readonly type: string;
  // Canonical identifying value (matched against the type's key property).
  readonly key: string;
  // Accepted alternative surface forms, matched after the same normalisation.
  readonly aliases?: readonly string[];
}

export interface PersonalEvalRelationship {
  readonly type: string;
  // Canonical keys of the endpoints (must name entities in the same document).
  readonly fromKey: string;
  readonly toKey: string;
}

export interface PersonalEvalDocTruth {
  readonly file: string;
  readonly entities: readonly PersonalEvalEntity[];
  readonly relationships: readonly PersonalEvalRelationship[];
}

// Which property of each entity type holds its identifying key.
export const personalKeyProperties: Readonly<Record<string, string>> = {
  Person: 'fullName',
  Project: 'name',
  Topic: 'name',
  Source: 'title',
};

export const personalGroundTruth: readonly PersonalEvalDocTruth[] = [
  {
    file: 'meeting-2026-03-04-printshop.md',
    entities: [
      { type: 'Person', key: 'Callum Reyes', aliases: ['Callum'] },
      { type: 'Person', key: 'Wren' },
      { type: 'Project', key: 'Paper Lantern', aliases: ['the zine project'] },
    ],
    relationships: [{ type: 'worksOn', fromKey: 'Callum Reyes', toKey: 'Paper Lantern' }],
  },
  {
    file: 'journal-2026-01-18.md',
    entities: [],
    relationships: [],
  },
  {
    file: 'reading-the-quiet-orchard.md',
    entities: [
      { type: 'Source', key: 'The Quiet Orchard' },
      { type: 'Person', key: 'Sefa Adeyemi' },
      { type: 'Topic', key: 'attention' },
    ],
    relationships: [
      { type: 'authoredBy', fromKey: 'The Quiet Orchard', toKey: 'Sefa Adeyemi' },
      { type: 'about', fromKey: 'The Quiet Orchard', toKey: 'attention' },
    ],
  },
  {
    file: 'project-log-darkroom.md',
    entities: [
      { type: 'Project', key: 'darkroom conversion', aliases: ['the darkroom', 'darkroom build'] },
      { type: 'Person', key: 'Marta' },
    ],
    relationships: [{ type: 'worksOn', fromKey: 'Marta', toKey: 'darkroom conversion' }],
  },
  {
    file: 'meeting-2026-02-10-bookclub.md',
    entities: [
      { type: 'Person', key: 'Theo' },
      { type: 'Person', key: 'Ana' },
      { type: 'Source', key: 'Salt Roads North' },
    ],
    relationships: [],
  },
  {
    file: 'reading-notes-batteries.md',
    entities: [
      { type: 'Source', key: 'The Long Discharge' },
      { type: 'Topic', key: 'home battery storage', aliases: ['battery storage'] },
    ],
    relationships: [
      { type: 'about', fromKey: 'The Long Discharge', toKey: 'home battery storage' },
    ],
  },
  {
    file: 'journal-2026-03-21.md',
    entities: [
      { type: 'Person', key: 'Imogen' },
      { type: 'Project', key: 'cabin renovation', aliases: ['the cabin'] },
    ],
    relationships: [{ type: 'worksOn', fromKey: 'Imogen', toKey: 'cabin renovation' }],
  },
  {
    file: 'project-log-lexika.md',
    entities: [
      { type: 'Project', key: 'Lexika', aliases: ['the flashcard app'] },
      { type: 'Person', key: 'Kerttu' },
      { type: 'Topic', key: 'spaced repetition' },
    ],
    relationships: [{ type: 'worksOn', fromKey: 'Kerttu', toKey: 'Lexika' }],
  },
  {
    file: 'journal-2026-04-02.md',
    entities: [],
    relationships: [],
  },
];
