import { date, relationshipType } from '@muninhq/shared';
import type { RelationshipTypeDefinition } from '@muninhq/shared';

export const belongsToProject: RelationshipTypeDefinition = relationshipType({
  name: 'belongsToProject',
  description: 'A Task contributes to a Project.',
  fromTypes: ['Task'],
  toTypes: ['Project'],
});

export const assignedTo: RelationshipTypeDefinition = relationshipType({
  name: 'assignedTo',
  description: 'A Task is owned by a Person.',
  fromTypes: ['Task'],
  toTypes: ['Person'],
});

export const worksOn: RelationshipTypeDefinition = relationshipType({
  name: 'worksOn',
  description: 'A Person contributes to a Project (not necessarily as manager).',
  fromTypes: ['Person'],
  toTypes: ['Project'],
  properties: {
    since: date({ description: 'When they began contributing.' }),
  },
});

export const managedBy: RelationshipTypeDefinition = relationshipType({
  name: 'managedBy',
  description: 'A Project is managed by a Person.',
  fromTypes: ['Project'],
  toTypes: ['Person'],
});

export const relationships: readonly RelationshipTypeDefinition[] = [
  belongsToProject,
  assignedTo,
  worksOn,
  managedBy,
];
