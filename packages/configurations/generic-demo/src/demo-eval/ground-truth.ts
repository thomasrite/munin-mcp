// Ground truth for the generic-demo corpus — the scoring oracle for the
// Phase 1 acceptance gate (session 1.8).
//
// Authored alongside the documents in ../../demo-data/docs. Implements the
// generic EvalGroundTruth vocabulary from @muninhq/shared so the engine's generic
// acceptance harness can score it without knowing anything demo-specific.
//
// Clearance model: each document carries a single sensitivity tag
// (demo:public / demo:member / demo:sysadmin). The config's tagExpansion
// expands a caller's role tag downward, so a member also sees public, etc.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EvalDocument, EvalEntity, EvalGroundTruth, EvalQuestion } from '@muninhq/shared';

// Absolute path to the corpus directory (static assets, outside src).
const here = path.dirname(fileURLToPath(import.meta.url));
export const demoDocsDir = path.resolve(here, '../../demo-data/docs');

// Ingest groups: the corpus is laid out in clearance subdirectories so each can
// be ingested (non-recursively) with the matching access tag through the real
// filesystem connector. The engine harness ingests each group in turn.
export const demoIngestGroups: readonly {
  readonly dir: string;
  readonly accessTags: readonly string[];
}[] = [
  { dir: path.join(demoDocsDir, 'public'), accessTags: ['demo:public'] },
  { dir: path.join(demoDocsDir, 'member'), accessTags: ['demo:member'] },
  { dir: path.join(demoDocsDir, 'sysadmin'), accessTags: ['demo:sysadmin'] },
];

type Level = 'public' | 'member' | 'sysadmin';
const tagFor: Record<Level, readonly string[]> = {
  public: ['demo:public'],
  member: ['demo:member'],
  sysadmin: ['demo:sysadmin'],
};

const p = (key: string): EvalEntity => ({ type: 'Person', key });
const pr = (key: string): EvalEntity => ({ type: 'Project', key });
const t = (key: string): EvalEntity => ({ type: 'Task', key });

const doc = (
  file: string,
  level: Level,
  entities: readonly EvalEntity[],
  relationships: EvalDocument['relationships'],
): EvalDocument => ({ file, accessTags: tagFor[level], entities, relationships });

const documents: readonly EvalDocument[] = [
  doc(
    'atlas-brief.md',
    'public',
    [pr('Atlas'), p('Sarah Chen'), p('Priya Anand'), p('Marcus Webb')],
    [
      { type: 'managedBy', fromKey: 'Atlas', toKey: 'Sarah Chen' },
      { type: 'worksOn', fromKey: 'Priya Anand', toKey: 'Atlas' },
      { type: 'worksOn', fromKey: 'Marcus Webb', toKey: 'Atlas' },
    ],
  ),
  doc(
    'beacon-brief.md',
    'public',
    [pr('Beacon'), p('Tom Okafor'), p('Marcus Webb'), p('David Olsen')],
    [
      { type: 'managedBy', fromKey: 'Beacon', toKey: 'Tom Okafor' },
      { type: 'worksOn', fromKey: 'Marcus Webb', toKey: 'Beacon' },
      { type: 'worksOn', fromKey: 'David Olsen', toKey: 'Beacon' },
    ],
  ),
  doc(
    'cobalt-brief.md',
    'sysadmin',
    [pr('Cobalt'), p('Lena Fischer')],
    [{ type: 'managedBy', fromKey: 'Cobalt', toKey: 'Lena Fischer' }],
  ),
  doc(
    'status-atlas-2026-03-12.txt',
    'member',
    [p('Sarah Chen'), p('Priya Anand'), p('Marcus Webb'), t('Oracle extraction connector')],
    [{ type: 'assignedTo', fromKey: 'Oracle extraction connector', toKey: 'Marcus Webb' }],
  ),
  doc(
    'status-atlas-2026-03-26.txt',
    'member',
    [p('Marcus Webb'), p('Sarah Chen'), p('Priya Anand'), t('cutover runbook')],
    [{ type: 'assignedTo', fromKey: 'cutover runbook', toKey: 'Sarah Chen' }],
  ),
  doc(
    'status-beacon-2026-03-15.txt',
    'member',
    [p('Tom Okafor'), p('David Olsen'), t('support-request flow')],
    [],
  ),
  doc(
    'status-beacon-2026-03-29.txt',
    'member',
    [p('Marcus Webb'), p('David Olsen'), p('Tom Okafor'), t('support-request backend API')],
    [{ type: 'assignedTo', fromKey: 'support-request backend API', toKey: 'Marcus Webb' }],
  ),
  doc(
    'meeting-atlas-kickoff.md',
    'member',
    [pr('Atlas'), p('Sarah Chen'), p('Priya Anand'), p('Marcus Webb')],
    [
      { type: 'managedBy', fromKey: 'Atlas', toKey: 'Sarah Chen' },
      { type: 'worksOn', fromKey: 'Priya Anand', toKey: 'Atlas' },
      { type: 'worksOn', fromKey: 'Marcus Webb', toKey: 'Atlas' },
    ],
  ),
  doc(
    'meeting-leadership-2026-03-20.md',
    'member',
    [pr('Atlas'), pr('Beacon'), pr('Cobalt'), p('Sarah Chen'), p('Tom Okafor'), p('Lena Fischer')],
    [],
  ),
  doc(
    'meeting-beacon-design.md',
    'member',
    [p('Tom Okafor'), p('David Olsen'), t('support-request flow')],
    [],
  ),
  doc(
    'tasks-atlas.md',
    'member',
    [
      p('Priya Anand'),
      p('Marcus Webb'),
      p('Sarah Chen'),
      t('sales-domain dimensional model'),
      t('finance-domain dimensional model'),
      t('Oracle extraction connector'),
      t('cutover runbook'),
    ],
    [
      { type: 'assignedTo', fromKey: 'sales-domain dimensional model', toKey: 'Priya Anand' },
      { type: 'assignedTo', fromKey: 'finance-domain dimensional model', toKey: 'Priya Anand' },
      { type: 'assignedTo', fromKey: 'Oracle extraction connector', toKey: 'Marcus Webb' },
      { type: 'assignedTo', fromKey: 'cutover runbook', toKey: 'Sarah Chen' },
    ],
  ),
  doc(
    'tasks-beacon.md',
    'member',
    [
      p('David Olsen'),
      p('Marcus Webb'),
      t('account-management screens'),
      t('support-request backend API'),
      t('acceptance tests for the support-request flow'),
      t('email-notification rate limit'),
    ],
    [
      { type: 'assignedTo', fromKey: 'account-management screens', toKey: 'David Olsen' },
      { type: 'assignedTo', fromKey: 'support-request backend API', toKey: 'Marcus Webb' },
      {
        type: 'assignedTo',
        fromKey: 'acceptance tests for the support-request flow',
        toKey: 'David Olsen',
      },
    ],
  ),
  doc(
    'tasks-cobalt.md',
    'sysadmin',
    [
      p('Lena Fischer'),
      t('close the high-severity penetration-test findings'),
      t('roll out mandatory multi-factor authentication'),
      t('assemble the Cyber Essentials Plus evidence pack'),
    ],
    [
      {
        type: 'assignedTo',
        fromKey: 'close the high-severity penetration-test findings',
        toKey: 'Lena Fischer',
      },
      {
        type: 'assignedTo',
        fromKey: 'roll out mandatory multi-factor authentication',
        toKey: 'Lena Fischer',
      },
      {
        type: 'assignedTo',
        fromKey: 'assemble the Cyber Essentials Plus evidence pack',
        toKey: 'Lena Fischer',
      },
    ],
  ),
  doc(
    'onboarding-priya.txt',
    'member',
    [p('Priya Anand'), pr('Atlas')],
    [{ type: 'worksOn', fromKey: 'Priya Anand', toKey: 'Atlas' }],
  ),
  doc('personnel-note.txt', 'sysadmin', [p('Sarah Chen'), p('Lena Fischer'), pr('Cobalt')], []),
  doc('newsletter-2026-q1.md', 'public', [pr('Atlas'), pr('Beacon')], []),
];

const questions: readonly EvalQuestion[] = [
  {
    id: 'q1-atlas-lead',
    callerBaseTags: ['demo:member'],
    question: 'Who leads the Atlas project and what is its goal?',
    predictedAnswer:
      'Sarah Chen leads Atlas; the goal is to migrate the legacy reporting stack onto the new data warehouse (retiring the legacy reporting database). Should cite atlas-brief or the Atlas kickoff notes.',
    expectedStatus: 'answered',
    shouldCiteAnyOf: ['atlas-brief.md', 'meeting-atlas-kickoff.md'],
  },
  {
    id: 'q2-marcus-work',
    callerBaseTags: ['demo:member'],
    question: 'What is Marcus Webb working on across all projects?',
    predictedAnswer:
      'Marcus Webb works on Atlas (the extraction connectors / Oracle connector) and on Beacon (the support-request backend API). A complete answer aggregates both projects — this is the duplication probe.',
    expectedStatus: 'answered',
    shouldMentionAll: ['Atlas', 'Beacon'],
  },
  {
    id: 'q3-public-launches',
    callerBaseTags: ['demo:public'],
    question: 'Which projects are launching this year?',
    predictedAnswer:
      'Atlas (going live in September) and Beacon (the customer self-service portal), per the public newsletter. Must NOT mention Cobalt, which is restricted and invisible to a guest.',
    expectedStatus: 'answered',
    shouldCiteAnyOf: ['newsletter-2026-q1.md'],
    mustNotMention: ['Cobalt'],
  },
  {
    id: 'q4-guest-cobalt-blocked',
    callerBaseTags: ['demo:public'],
    question: 'What is Project Cobalt and who manages it?',
    predictedAnswer:
      'A guest holds only demo:public; every Cobalt document is restricted (member/sysadmin). With no visible evidence the engine must honestly decline — no_evidence, zero citations, no leakage of Lena Fischer or the security details.',
    expectedStatus: 'no_evidence',
    mustNotMention: ['Lena Fischer', 'penetration', 'multi-factor'],
  },
  {
    id: 'q5-admin-cobalt',
    callerBaseTags: ['demo:sysadmin'],
    question: 'What is Project Cobalt and who manages it?',
    predictedAnswer:
      'Cobalt is the security-compliance remediation project (closing pen-test findings, rolling out MFA, Cyber Essentials Plus evidence); managed by Lena Fischer. Should cite cobalt-brief.',
    expectedStatus: 'answered',
    shouldCiteAnyOf: ['cobalt-brief.md'],
  },
  {
    id: 'q6-out-of-corpus',
    callerBaseTags: ['demo:member'],
    question: "What is the company's projected annual revenue for next year?",
    predictedAnswer:
      'Nothing in the corpus addresses revenue or financial forecasts. The engine should decline honestly — no_evidence, zero citations.',
    expectedStatus: 'no_evidence',
  },
];

export const demoGroundTruth: EvalGroundTruth = {
  documents,
  logicalEntities: {
    Person: [
      'Sarah Chen',
      'Priya Anand',
      'Marcus Webb',
      'Tom Okafor',
      'David Olsen',
      'Lena Fischer',
    ],
    Project: ['Atlas', 'Beacon', 'Cobalt'],
  },
  keyProperties: {
    Person: 'fullName',
    Project: 'name',
    Task: 'title',
  },
  questions,
};
