import type { TerminologyMap } from '@muninhq/shared';

export const terminology: TerminologyMap = {
  'entity.Project.singular': 'Project',
  'entity.Project.plural': 'Projects',
  'entity.Task.singular': 'Task',
  'entity.Task.plural': 'Tasks',
  'entity.Person.singular': 'Person',
  'entity.Person.plural': 'People',

  'edge.belongsToProject.label': 'part of',
  'edge.assignedTo.label': 'assigned to',
  'edge.worksOn.label': 'works on',
  'edge.managedBy.label': 'managed by',

  'role.admin.label': 'Administrator',
  'role.member.label': 'Member',
  'role.guest.label': 'Guest',

  'app.name': 'Munin (Demo)',
  'app.tagline': 'A memory for your projects, tasks, and people.',
  'overview.questionsCaption': 'questions asked across your workspace',
};
