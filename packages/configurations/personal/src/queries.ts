import { queryTemplate } from '@muninhq/shared';
import type { QueryTemplate } from '@muninhq/shared';

// Two small structured queries over the personal graph — optional affordances
// proving the grammar composes; the free-text ask path does not depend on them.

export const sourcesAboutTopic: QueryTemplate = queryTemplate({
  id: 'sourcesAboutTopic',
  title: 'Reading on a topic',
  description: 'List the Sources and Projects that are about a given Topic.',
  slots: {
    topic: {
      kind: 'entityRef',
      required: true,
      description: 'The Topic to find sources for.',
      entityTypes: ['Topic'],
    },
  },
  expansion: {
    startSlot: 'topic',
    traverse: [{ edgeTypes: ['about'], direction: 'in', maxDepth: 1 }],
    resultLimit: 200,
  },
});

export const projectsWithPerson: QueryTemplate = queryTemplate({
  id: 'projectsWithPerson',
  title: 'Projects with a person',
  description: 'List the Projects a given Person works on.',
  slots: {
    person: {
      kind: 'entityRef',
      required: true,
      description: 'The Person to list projects for.',
      entityTypes: ['Person'],
    },
  },
  expansion: {
    startSlot: 'person',
    traverse: [{ edgeTypes: ['worksOn'], direction: 'out', maxDepth: 1 }],
    resultLimit: 200,
  },
});

export const queryTemplates: readonly QueryTemplate[] = [sourcesAboutTopic, projectsWithPerson];
