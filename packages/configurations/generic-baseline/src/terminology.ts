import type { TerminologyMap } from '@muninhq/shared';

// Neutral terminology — the labels the web renders. No vertical words: this is
// the product's day-one default for a tenant that has picked nothing.
export const terminology: TerminologyMap = {
  'entity.Person.singular': 'Person',
  'entity.Person.plural': 'People',
  'entity.Organisation.singular': 'Organisation',
  'entity.Organisation.plural': 'Organisations',
  'entity.Document.singular': 'Document',
  'entity.Document.plural': 'Documents',
  'entity.Event.singular': 'Event',
  'entity.Event.plural': 'Events',
  'entity.Topic.singular': 'Topic',
  'entity.Topic.plural': 'Topics',

  'edge.affiliatedWith.label': 'affiliated with',
  'edge.mentions.label': 'mentions',
  'edge.involvedIn.label': 'involved in',

  'role.admin.label': 'Administrator',
  'role.reader.label': 'Reader',

  'app.name': 'Munin',
  'app.tagline': 'A memory for your organisation.',
  'overview.questionsCaption': 'questions asked across your workspace',
};
