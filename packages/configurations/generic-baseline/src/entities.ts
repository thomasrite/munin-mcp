import { date, entityType, str } from '@muninhq/shared';
import type { EntityTypeDefinition } from '@muninhq/shared';

// The neutral baseline entity set: the five shapes that recur in almost any
// business corpus — People, Organisations, the Documents/Events/Topics they
// reference. Conservative property schemas (precision over coverage): only
// properties an extractor can pull with high confidence from ordinary prose, so
// a tenant that picks NOTHING at onboarding still gets a useful, low-noise graph
// on day one. Vertical-agnostic by construction — no domain vocabulary anywhere.

export const Person: EntityTypeDefinition = entityType({
  name: 'Person',
  description: 'A named human referred to in the documents.',
  properties: {
    fullName: str({ description: 'Full name as written.' }),
    email: str({ description: 'Email address, if stated.', format: 'email' }),
    role: str({ description: "The person's role or title, in the document's own words." }),
  },
  required: ['fullName'],
  // Query-time resolution hints (M1.1): identity is the name; email is an exact
  // key when present; role distinguishes two same-name people. compositeHash
  // only (never schemaHash — does not affect extraction).
  resolution: {
    identityProperties: ['fullName'],
    exactKeyProperties: ['email'],
    distinguishingProperties: ['role'],
  },
  fewShots: [
    {
      input: 'Priya Anand (priya@example.com), the new operations lead, joined the team last week.',
      output: {
        entities: [
          {
            type: 'Person',
            properties: {
              fullName: 'Priya Anand',
              email: 'priya@example.com',
              role: 'operations lead',
            },
          },
        ],
      },
    },
  ],
});

export const Organisation: EntityTypeDefinition = entityType({
  name: 'Organisation',
  description: 'A named organisation, company, body, or team referred to in the documents.',
  properties: {
    name: str({ description: 'The organisation’s name as written.' }),
    description: str({ description: 'One sentence on what the organisation is or does.' }),
  },
  required: ['name'],
  resolution: {
    identityProperties: ['name'],
  },
  fewShots: [
    {
      input: 'The contract was awarded to Northwind Logistics, a regional distribution company.',
      output: {
        entities: [
          {
            type: 'Organisation',
            properties: {
              name: 'Northwind Logistics',
              description: 'a regional distribution company',
            },
          },
        ],
      },
    },
  ],
});

export const Document: EntityTypeDefinition = entityType({
  name: 'Document',
  description:
    'A document, report, or written artefact REFERRED TO within the text (distinct from the ' +
    'ingested file itself) — e.g. "the 2026 annual report", "the signed agreement".',
  properties: {
    title: str({ description: 'The title or name of the referenced document.' }),
    kind: str({
      description: 'The kind of document, in the text’s own words (e.g. report, agreement, memo).',
    }),
    date: date({ description: 'ISO date associated with the document, if stated.' }),
  },
  required: ['title'],
  fewShots: [
    {
      input: 'These figures are set out in the 2026 annual report, published in March.',
      output: {
        entities: [
          {
            type: 'Document',
            properties: { title: '2026 annual report', kind: 'report', date: '2026-03-01' },
          },
        ],
      },
    },
  ],
});

export const Event: EntityTypeDefinition = entityType({
  name: 'Event',
  description: 'A dated happening or occasion referred to in the documents.',
  properties: {
    title: str({ description: 'Short name for what happened.' }),
    description: str({ description: 'One sentence describing the event.' }),
    date: date({ description: 'ISO date the event occurred, if stated.' }),
  },
  required: ['title'],
  fewShots: [
    {
      input: 'The quarterly review meeting took place on 14 April 2026.',
      output: {
        entities: [
          {
            type: 'Event',
            properties: { title: 'quarterly review meeting', date: '2026-04-14' },
          },
        ],
      },
    },
  ],
});

export const Topic: EntityTypeDefinition = entityType({
  name: 'Topic',
  description: 'A recurring subject, theme, or concept the documents are about.',
  properties: {
    name: str({ description: 'The topic name, as a short noun phrase.' }),
    description: str({ description: 'One sentence describing the topic.' }),
  },
  required: ['name'],
  resolution: {
    identityProperties: ['name'],
  },
  fewShots: [
    {
      input: 'Several teams raised concerns about data retention during the consultation.',
      output: {
        entities: [{ type: 'Topic', properties: { name: 'data retention' } }],
      },
    },
  ],
});

export const entities: readonly EntityTypeDefinition[] = [
  Person,
  Organisation,
  Document,
  Event,
  Topic,
];
