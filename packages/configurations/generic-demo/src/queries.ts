import { queryTemplate } from '@muninhq/shared';
import type { QueryTemplate } from '@muninhq/shared';

export const tasksForProject: QueryTemplate = queryTemplate({
  id: 'tasksForProject',
  title: 'Tasks for a project',
  description: 'List the Tasks that belong to a given Project.',
  slots: {
    project: {
      kind: 'entityRef',
      required: true,
      description: 'The Project to list tasks for.',
      entityTypes: ['Project'],
    },
  },
  expansion: {
    startSlot: 'project',
    traverse: [{ edgeTypes: ['belongsToProject'], direction: 'in', maxDepth: 1 }],
    resultLimit: 200,
  },
});

export const personActivity: QueryTemplate = queryTemplate({
  id: 'personActivity',
  title: 'What is this Person working on?',
  description: 'Projects a Person works on and Tasks assigned to them.',
  slots: {
    person: {
      kind: 'entityRef',
      required: true,
      description: 'The Person to summarise activity for.',
      entityTypes: ['Person'],
    },
  },
  expansion: {
    startSlot: 'person',
    traverse: [
      { edgeTypes: ['worksOn'], direction: 'out', maxDepth: 1 },
      { edgeTypes: ['assignedTo'], direction: 'in', maxDepth: 1 },
    ],
    resultLimit: 100,
  },
});

export const recentInProject: QueryTemplate = queryTemplate({
  id: 'recentInProject',
  title: 'Recent activity in a project',
  description: 'Tasks updated within a date range for a given Project.',
  slots: {
    project: {
      kind: 'entityRef',
      required: true,
      description: 'The Project to scope the activity to.',
      entityTypes: ['Project'],
    },
    when: {
      kind: 'dateRange',
      required: true,
      description: 'The date range to filter Task updates by.',
    },
  },
  expansion: {
    startSlot: 'project',
    traverse: [{ edgeTypes: ['belongsToProject'], direction: 'in', maxDepth: 1 }],
    filterByDate: { slot: 'when', field: 'updatedAt' },
    resultLimit: 100,
  },
});

export const queryTemplates: readonly QueryTemplate[] = [
  tasksForProject,
  personActivity,
  recentInProject,
];
