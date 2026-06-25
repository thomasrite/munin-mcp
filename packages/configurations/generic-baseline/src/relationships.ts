import { relationshipType } from '@muninhq/shared';
import type { RelationshipTypeDefinition } from '@muninhq/shared';

// A deliberately small, neutral relationship set. Just enough to connect the
// five baseline entities into a useful graph without committing to any vertical
// model — a tenant that wants richer structure picks a richer cartridge.

export const affiliatedWith: RelationshipTypeDefinition = relationshipType({
  name: 'affiliatedWith',
  description: 'A Person is affiliated with an Organisation.',
  fromTypes: ['Person'],
  toTypes: ['Organisation'],
});

export const mentions: RelationshipTypeDefinition = relationshipType({
  name: 'mentions',
  description: 'A Document refers to a Person, Organisation, or Topic.',
  fromTypes: ['Document'],
  toTypes: ['Person', 'Organisation', 'Topic'],
});

export const involvedIn: RelationshipTypeDefinition = relationshipType({
  name: 'involvedIn',
  description: 'A Person took part in an Event.',
  fromTypes: ['Person'],
  toTypes: ['Event'],
});

export const relationships: readonly RelationshipTypeDefinition[] = [
  affiliatedWith,
  mentions,
  involvedIn,
];
