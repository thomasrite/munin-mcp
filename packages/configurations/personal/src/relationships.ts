import { relationshipType } from '@muninhq/shared';
import type { RelationshipTypeDefinition } from '@muninhq/shared';

// Three conservative relationships. fromTypes/toTypes make wrong edges
// unrepresentable: a Person can never be "about" a Topic, a Topic can never
// author anything. Relationship examples live INSIDE entity few-shots
// (entities.ts) — the extraction prompt renders entity few-shots only, so an
// example here would never reach the model.

export const worksOn: RelationshipTypeDefinition = relationshipType({
  name: 'worksOn',
  description:
    'A named Person works on or is involved in a Project. Only when the note states it — never ' +
    'infer it from two names appearing near each other.',
  fromTypes: ['Person'],
  toTypes: ['Project'],
});

export const about: RelationshipTypeDefinition = relationshipType({
  name: 'about',
  description: 'A Source or Project is substantively about a Topic — its subject, not a mention.',
  fromTypes: ['Source', 'Project'],
  toTypes: ['Topic'],
});

export const authoredBy: RelationshipTypeDefinition = relationshipType({
  name: 'authoredBy',
  description: 'A Source was created by a named Person — its author, host, or maker.',
  fromTypes: ['Source'],
  toTypes: ['Person'],
});

export const relationships: readonly RelationshipTypeDefinition[] = [worksOn, about, authoredBy];
