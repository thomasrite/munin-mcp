import type { TerminologyMap } from '@muninhq/shared';

// Neutral-but-personal terminology. Persona framing (second-person voice,
// "documents" as the record noun) is sanctioned ONLY inside this package —
// it appears nowhere else in the codebase. Munin is a memory over the files
// you already have, not a notes app, so user-facing strings avoid "notes".
export const terminology: TerminologyMap = {
  'entity.Person.singular': 'Person',
  'entity.Person.plural': 'People',
  'entity.Project.singular': 'Project',
  'entity.Project.plural': 'Projects',
  'entity.Topic.singular': 'Topic',
  'entity.Topic.plural': 'Topics',
  'entity.Source.singular': 'Source',
  'entity.Source.plural': 'Sources',

  'edge.worksOn.label': 'works on',
  'edge.about.label': 'about',
  'edge.authoredBy.label': 'by',

  'role.owner.label': 'Owner',

  'app.name': 'Munin',
  'app.tagline': 'A memory for everything you read and write.',
  'overview.questionsCaption': 'questions asked across your documents',
};
