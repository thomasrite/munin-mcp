import { date, entityType, num, str } from '@muninhq/shared';
import type { EntityTypeDefinition } from '@muninhq/shared';

export const Project: EntityTypeDefinition = entityType({
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
        'The Atlas project, led by Sarah Chen, kicked off in March 2026 with a planned six-month delivery window. The goal is to migrate the legacy reporting stack to the new data warehouse.',
      output: {
        entities: [
          {
            type: 'Project',
            properties: {
              name: 'Atlas',
              description: 'migrate the legacy reporting stack to the new data warehouse',
              status: 'active',
              startDate: '2026-03-01',
            },
          },
          {
            type: 'Person',
            properties: { fullName: 'Sarah Chen' },
          },
        ],
        relationships: [{ type: 'managedBy', fromIndex: 0, toIndex: 1 }],
      },
    },
  ],
});

export const Task: EntityTypeDefinition = entityType({
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
    estimateHours: num({
      description: 'Rough effort estimate in hours.',
      minimum: 0,
    }),
  },
  required: ['title'],
  fewShots: [
    {
      input:
        "I need to finish the data validation script by Friday 13 March — it's blocking the QA team. Marcus owns it and reckons it's about a day's work.",
      output: {
        entities: [
          {
            type: 'Task',
            properties: {
              title: 'finish the data validation script',
              status: 'in-progress',
              priority: 'high',
              dueDate: '2026-03-13',
              estimateHours: 8,
            },
          },
          { type: 'Person', properties: { fullName: 'Marcus' } },
        ],
        relationships: [{ type: 'assignedTo', fromIndex: 0, toIndex: 1 }],
      },
    },
  ],
});

export const Person: EntityTypeDefinition = entityType({
  name: 'Person',
  description: 'A human involved in projects or tasks.',
  properties: {
    fullName: str({ description: 'Full name as it would be spoken or written.' }),
    email: str({ description: 'Email address.', format: 'email' }),
    role: str({
      description: 'Their organisational role in their own words (free text).',
    }),
  },
  required: ['fullName'],
  // Query-time resolution hints (M1.1): identity is the name; email is an exact
  // key when present; role distinguishes two same-name people. Powers gather-by-
  // identity + the M2.4 disambiguation round-trip. compositeHash only (never
  // schemaHash — does not affect extraction).
  resolution: {
    identityProperties: ['fullName'],
    exactKeyProperties: ['email'],
    distinguishingProperties: ['role'],
  },
  fewShots: [
    {
      input:
        'Priya Anand (priya@example.com), our new senior data engineer, joined the platform team last week.',
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

export const entities: readonly EntityTypeDefinition[] = [Project, Task, Person];
