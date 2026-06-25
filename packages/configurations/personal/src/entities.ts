import { entityType, str } from '@muninhq/shared';
import type { EntityTypeDefinition } from '@muninhq/shared';

// Personal-knowledge entity types (prosumer arc, step 4).
//
// Four conservative types — Person / Project / Topic / Source — chosen for
// PRECISION over coverage (the mat-hr F12 lesson: over-extraction is the
// failure mode, and a personal corpus is full of chatty prose that should
// extract NOTHING). Descriptions are written for an extraction model reading
// personal prose: meeting notes, journal entries, reading notes, project logs.
// Personal prose differs from business prose in two load-bearing ways the
// descriptions and few-shots must teach:
//
//   1. People are usually FIRST NAMES ONLY ("Dana came round") — the name as
//      written IS the identity; demanding a full name would drop most people.
//   2. The writer narrates in the first person. "I" is never an entity, and
//      unnamed relations ("my sister", "the plumber") are not extractable.
//
// Few-shots are authored from SEPARATE fictional examples (no overlap with the
// eval corpus in src/eval/) so the model generalises rather than memorises —
// the same discipline mat-hr's spike validated. At least one example per
// over-extraction-prone type is an "extract nothing" example on realistic
// chatty prose; restraint is taught, not hoped for.

export const Person: EntityTypeDefinition = entityType({
  name: 'Person',
  description:
    'A named person the writer knows, met, or worked with, or the named author of a work. ' +
    'Personal notes often use FIRST NAMES ONLY — a bare first name is a valid fullName; record it ' +
    'as written. Do NOT extract the writer ("I"/"my"), unnamed relations ("my sister", "the ' +
    'plumber"), or generic groups ("the team").',
  properties: {
    fullName: str({
      description:
        'The name exactly as written — a bare first name is fine if that is all the note gives.',
    }),
    role: str({
      description:
        "Who they are to the writer or what they do, in the note's own words — e.g. " +
        '"climbing partner", "freelance editor", "Maya\'s teacher". Omit if not stated.',
    }),
  },
  required: ['fullName'],
  // Query-time resolution hints (M1.1): the name as written is the identity;
  // role distinguishes two same-name people. compositeHash-only — never
  // invalidates the extraction cache.
  resolution: {
    identityProperties: ['fullName'],
    distinguishingProperties: ['role'],
  },
  fewShots: [
    {
      // Positive: a full name with a role, plus a bare first name — both count.
      input:
        'Coffee with Renata Voss this morning — she is the freelance editor Tomas recommended. ' +
        'She offered to read the first three chapters.',
      output: {
        entities: [
          { type: 'Person', properties: { fullName: 'Renata Voss', role: 'freelance editor' } },
          { type: 'Person', properties: { fullName: 'Tomas' } },
        ],
      },
    },
    {
      // Negative: first-person narration and unnamed relations — nothing to extract.
      input:
        'My sister rang in the evening; the plumber finally turned up too. Otherwise a quiet day — ' +
        'I mostly tidied the study and answered email.',
      output: { entities: [] },
    },
  ],
});

export const Project: EntityTypeDefinition = entityType({
  name: 'Project',
  description:
    'A named, ongoing piece of work the writer keeps returning to — a side project, a renovation, ' +
    'a piece of writing, an event being organised. Use the name the note uses, even if informal ' +
    '("the allotment redesign", "Fieldnotes"). Do NOT extract one-off chores or errands ("book ' +
    'the dentist") — a Project has continuity, not a to-do item; omit work the note leaves unnamed.',
  properties: {
    name: str({
      description:
        'The name the note uses for the project, e.g. "Fieldnotes" or "the loft conversion".',
    }),
    status: str({
      description:
        'Where the project stands, in the note\'s own words — e.g. "stalled", "nearly done", ' +
        '"waiting on parts". Omit if the note does not say.',
    }),
    description: str({
      description: 'One short phrase on what the project is, if the note gives one.',
    }),
  },
  required: ['name'],
  resolution: {
    identityProperties: ['name'],
  },
  fewShots: [
    {
      // Positive: an informally named project from a project-log entry.
      input:
        'Two more hours on the allotment redesign this evening — the raised beds are finally ' +
        'level. Still waiting on the timber before the cold frame can go in.',
      output: {
        entities: [
          {
            type: 'Project',
            properties: { name: 'allotment redesign', status: 'waiting on the timber' },
          },
        ],
      },
    },
    {
      // Positive: a named project plus the person working on it — and the
      // worksOn edge between them. (The writer is NOT an entity.)
      input:
        'Call with Priya about Fieldnotes, the trail-logging app we started in January. She has ' +
        'the sync bug nearly fixed; I still owe her the icon set.',
      output: {
        entities: [
          { type: 'Person', properties: { fullName: 'Priya' } },
          {
            type: 'Project',
            properties: { name: 'Fieldnotes', description: 'trail-logging app' },
          },
        ],
        relationships: [{ type: 'worksOn', fromIndex: 0, toIndex: 1 }],
      },
    },
    {
      // Negative: a to-do list of one-off errands is not a Project.
      input:
        'Need to book the dentist, renew the car insurance, and clear the gutters before the ' +
        'rain comes back.',
      output: { entities: [] },
    },
  ],
});

export const Topic: EntityTypeDefinition = entityType({
  name: 'Topic',
  description:
    'A subject the note is substantively ABOUT — something the writer is learning or thinking ' +
    'through (e.g. "soil health", "spaced repetition"). Extract SPARINGLY: only when the passage ' +
    'actually engages with the subject, not a passing mention ("small talk about football"). ' +
    'Prefer one well-chosen Topic per passage over several weak ones.',
  properties: {
    name: str({ description: 'The topic as a short noun phrase, e.g. "soil health".' }),
    description: str({
      description: 'One sentence on what the note says about it, if easily summarised.',
    }),
  },
  required: ['name'],
  resolution: {
    identityProperties: ['name'],
  },
  fewShots: [
    {
      // Positive: the passage substantively engages with one subject.
      input:
        'Reading more about soil health lately — the difference between compost and mulch ' +
        'finally clicked: one feeds the soil, the other protects it.',
      output: {
        entities: [
          {
            type: 'Topic',
            properties: {
              name: 'soil health',
              description: 'compost feeds the soil while mulch protects it',
            },
          },
        ],
      },
    },
    {
      // Negative: passing mentions in chatty prose are not Topics.
      input:
        'The meetup ran long — mostly small talk about the weather and football. Nothing worth ' +
        'keeping; next month should be better.',
      output: { entities: [] },
    },
  ],
});

export const Source: EntityTypeDefinition = entityType({
  name: 'Source',
  description:
    'A TITLED external work — book, article, paper, video, or podcast — the writer is reading, ' +
    'watching, or listening to. The title must actually appear in the note. A work named only by ' +
    'description ("some article Dana sent", "a long video about fermentation") has no extractable ' +
    'identity — omit it.',
  properties: {
    title: str({ description: 'The title exactly as the note gives it.' }),
    kind: str({
      description:
        'What kind of work it is, if evident — e.g. "book", "article", "paper", "video", ' +
        '"podcast". Omit if unclear.',
    }),
  },
  required: ['title'],
  resolution: {
    identityProperties: ['title'],
  },
  fewShots: [
    {
      // Positive: a titled book with a named author — and the authoredBy edge.
      input:
        "Finished 'The Salt Path Home' by Ines Okafor last night. The chapter on tidal " +
        'estuaries is worth rereading.',
      output: {
        entities: [
          { type: 'Source', properties: { title: 'The Salt Path Home', kind: 'book' } },
          { type: 'Person', properties: { fullName: 'Ines Okafor' } },
        ],
        relationships: [{ type: 'authoredBy', fromIndex: 0, toIndex: 1 }],
      },
    },
    {
      // Positive: a titled article that is substantively about a subject — the
      // about edge links them.
      input:
        "Read 'Why Small Gardens Fail' on the train — argues most people overplant in year one " +
        'and exhaust the soil. Persuasive on overplanting, thinner on remedies.',
      output: {
        entities: [
          { type: 'Source', properties: { title: 'Why Small Gardens Fail', kind: 'article' } },
          { type: 'Topic', properties: { name: 'overplanting' } },
        ],
        relationships: [{ type: 'about', fromIndex: 0, toIndex: 1 }],
      },
    },
    {
      // Negative: untitled works have no extractable identity.
      input:
        'Listened to half a podcast about sleep on the drive home — cannot remember the name ' +
        'of it. Something about light exposure in the morning.',
      output: { entities: [] },
    },
  ],
});

export const entities: readonly EntityTypeDefinition[] = [Person, Project, Topic, Source];
