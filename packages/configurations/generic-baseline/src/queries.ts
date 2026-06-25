import { queryTemplate } from '@muninhq/shared';
import type { QueryTemplate } from '@muninhq/shared';

// Two small, generic structured queries — enough to prove the grammar composes
// over the baseline graph without committing to a vertical. The free-text ask
// path does not depend on these; they are optional structured affordances.

export const documentsMentioningPerson: QueryTemplate = queryTemplate({
  id: 'documentsMentioningPerson',
  title: 'Documents mentioning a person',
  description: 'List the Documents that mention a given Person.',
  slots: {
    person: {
      kind: 'entityRef',
      required: true,
      description: 'The Person to find mentions of.',
      entityTypes: ['Person'],
    },
  },
  expansion: {
    startSlot: 'person',
    traverse: [{ edgeTypes: ['mentions'], direction: 'in', maxDepth: 1 }],
    resultLimit: 200,
  },
});

export const peopleAtOrganisation: QueryTemplate = queryTemplate({
  id: 'peopleAtOrganisation',
  title: 'People at an organisation',
  description: 'List the People affiliated with a given Organisation.',
  slots: {
    organisation: {
      kind: 'entityRef',
      required: true,
      description: 'The Organisation to list affiliated people for.',
      entityTypes: ['Organisation'],
    },
  },
  expansion: {
    startSlot: 'organisation',
    traverse: [{ edgeTypes: ['affiliatedWith'], direction: 'in', maxDepth: 1 }],
    resultLimit: 200,
  },
});

export const queryTemplates: readonly QueryTemplate[] = [
  documentsMentioningPerson,
  peopleAtOrganisation,
];
