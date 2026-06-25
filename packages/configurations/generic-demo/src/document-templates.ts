import type { DocumentTemplate } from '@muninhq/shared';

// Generation programs (M2.2) for the generic Projects/Tasks/People demo. Proves
// the DocumentTemplate grammar + executor with NO vertical concept (Rule 3:
// demo against generic data before any MAT/HR template). A "Person dossier" —
// assemble everything on file about a person into a structured, grounded write-up.
export const documentTemplates: readonly DocumentTemplate[] = [
  {
    id: 'person-dossier',
    title: 'Person dossier',
    subjectEntityType: 'Person',
    sections: [
      {
        heading: 'Overview',
        format: 'prose',
        fill: {
          kind: 'auto-from-gather',
          instruction:
            'In two or three sentences, summarise who this person is and the kinds of records held about them.',
        },
      },
      {
        heading: 'Involvement',
        format: 'list',
        fill: {
          kind: 'auto-from-gather',
          instruction:
            'Summarise this person’s involvement across the records — the projects and tasks they relate to. Group near-identical items into one claim (keeping every source) rather than repeating similar lines.',
        },
      },
      {
        heading: 'Prepared by',
        format: 'field',
        fill: { kind: 'asked-of-user', slot: { kind: 'text', required: false } },
      },
    ],
  },
];
