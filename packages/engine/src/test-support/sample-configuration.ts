// A self-contained, generic Configuration fixture for engine unit/integration
// tests.
//
// The engine is vertical-agnostic and — by deliberate F5 decision — depends on
// NO configuration package, not even as a devDependency. Tests that need a
// representative Configuration to exercise extraction/validation/prompt
// assembly use this inline fixture instead of importing `@muninhq/config-*`.
//
// It mirrors the Projects / Tasks / People shape of the generic-demo
// configuration (Project/Task/Person + the four relationships) because the
// extractor tests assert against those type names. It is intentionally minimal
// on the cosmetic surface (terminology/roles/queryTemplates/connectors) — those
// fields are present and valid but not what these tests probe.

import {
  type Configuration,
  type EntityTypeDefinition,
  type RelationshipTypeDefinition,
  date,
  entityType,
  num,
  relationshipType,
  str,
} from '@muninhq/shared';

const Project: EntityTypeDefinition = entityType({
  name: 'Project',
  description:
    'A coordinated unit of work with a goal, a status, and one or more people responsible for it.',
  properties: {
    name: str({ description: 'The short identifier or codename of the project.' }),
    description: str({ description: 'One sentence describing what the project is for.' }),
    status: str({
      description: 'Lifecycle status.',
      enum: ['planning', 'active', 'on-hold', 'completed', 'cancelled'],
    }),
    startDate: date({ description: 'ISO date the project started.' }),
    endDate: date({ description: 'ISO date the project ended or is planned to end.' }),
  },
  required: ['name'],
  fewShots: [
    {
      input:
        'The Atlas project, led by Sarah Chen, kicked off in March 2026 with a planned six-month delivery window.',
      output: {
        entities: [
          {
            type: 'Project',
            properties: { name: 'Atlas', status: 'active', startDate: '2026-03-01' },
          },
          { type: 'Person', properties: { fullName: 'Sarah Chen' } },
        ],
        relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 1 }],
      },
    },
  ],
});

const Task: EntityTypeDefinition = entityType({
  name: 'Task',
  description:
    'A discrete piece of work that contributes to a project. Has an owner, a status, a priority, and optionally a due date.',
  properties: {
    title: str({ description: 'Short summary of what needs to happen.' }),
    description: str({ description: 'Longer explanation if useful.' }),
    status: str({
      description: 'Lifecycle status.',
      enum: ['todo', 'in-progress', 'blocked', 'done', 'cancelled'],
    }),
    priority: str({
      description: 'Subjective urgency.',
      enum: ['low', 'medium', 'high', 'critical'],
    }),
    dueDate: date({ description: 'ISO date the task is due.' }),
    estimateHours: num({ description: 'Rough effort estimate in hours.', minimum: 0 }),
  },
  required: ['title'],
  fewShots: [
    {
      input: 'Marcus needs to finish the data validation script by Friday — it is blocking QA.',
      output: {
        entities: [
          {
            type: 'Task',
            properties: { title: 'finish the data validation script', status: 'in-progress' },
          },
          { type: 'Person', properties: { fullName: 'Marcus' } },
        ],
        relationships: [{ type: 'assignedTo', fromIndex: 0, toIndex: 1 }],
      },
    },
  ],
});

const Person: EntityTypeDefinition = entityType({
  name: 'Person',
  description: 'A human involved in projects or tasks.',
  properties: {
    fullName: str({ description: 'Full name as it would be spoken or written.' }),
    email: str({ description: 'Email address.', format: 'email' }),
    role: str({ description: 'Their organisational role in their own words (free text).' }),
  },
  required: ['fullName'],
  fewShots: [
    {
      input: 'Priya Anand (priya@example.com), our new senior data engineer, joined last week.',
      output: {
        entities: [
          {
            type: 'Person',
            properties: {
              fullName: 'Priya Anand',
              email: 'priya@example.com',
              role: 'senior data engineer',
            },
          },
        ],
      },
    },
  ],
});

const belongsToProject: RelationshipTypeDefinition = relationshipType({
  name: 'belongsToProject',
  description: 'A Task contributes to a Project.',
  fromTypes: ['Task'],
  toTypes: ['Project'],
});

const assignedTo: RelationshipTypeDefinition = relationshipType({
  name: 'assignedTo',
  description: 'A Task is owned by a Person.',
  fromTypes: ['Task'],
  toTypes: ['Person'],
});

const worksOn: RelationshipTypeDefinition = relationshipType({
  name: 'worksOn',
  description: 'A Person contributes to a Project (not necessarily as manager).',
  fromTypes: ['Person'],
  toTypes: ['Project'],
  properties: { since: date({ description: 'When they began contributing.' }) },
});

const managedBy: RelationshipTypeDefinition = relationshipType({
  name: 'managedBy',
  description: 'A Project is managed by a Person.',
  fromTypes: ['Project'],
  toTypes: ['Person'],
});

// A complete, valid generic Configuration for tests. Cosmetic fields are
// minimal-but-valid; the identity tag-expansion passes base tags through
// unchanged (the engine treats tags as opaque strings).
export const sampleConfiguration: Configuration = {
  id: 'engine-test-fixture',
  version: '0.1.0',
  description: 'Generic Projects / Tasks / People fixture for engine tests.',
  entityTypes: [Project, Task, Person],
  relationshipTypes: [belongsToProject, assignedTo, worksOn, managedBy],
  terminology: {},
  roles: [],
  tagExpansion: (baseTags) => baseTags,
  queryTemplates: [],
  connectors: [],
};
