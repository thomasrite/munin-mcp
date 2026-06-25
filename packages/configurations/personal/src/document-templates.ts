import type { DocumentTemplate } from '@muninhq/shared';

// Document templates for the personal configuration (M2.2 generation programs).
//
// A DocumentTemplate is a GENERATION grammar, distinct from the retrieval
// QueryTemplate: it describes a structured document about ONE subject entity,
// section by section. The engine executor gathers the subject's records and
// fills each section by its declared provenance class:
//   • auto-from-gather — Munin SYNTHESISES the content, grounded + cited per
//     claim (fail-closed: an ungrounded claim is dropped, never invented).
//   • static — verbatim boilerplate; not a Munin fact-claim.
//   • asked-of-user — a value the human supplies; not a Munin fact-claim.
//
// VERTICAL-AGNOSTIC: the grammar (formats, fill kinds) is the engine's; what a
// "person dossier" is (these sections, this subject type) is configuration.
// Nothing here names a MAT/HR/safeguarding concept — `Person` is the generic
// personal-knowledge entity (a friend, collaborator, author named in your own
// notes), the same type the extraction schema and few-shots target.

// One subject (a Person named in the owner's notes), three provenance classes:
// two grounded auto sections (the quality-bearing, model-sensitive part the eval
// measures), one static disclaimer, and one human-supplied field — so the
// template exercises every FillSource the executor distinguishes.
export const personDossier: DocumentTemplate = {
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
          'In two or three sentences, summarise who this person is and how they appear in the ' +
          'notes, using only the sources. Do not speculate beyond what is written.',
      },
    },
    {
      heading: 'Projects & collaborations',
      format: 'list',
      fill: {
        kind: 'auto-from-gather',
        instruction:
          'List the projects, works, or activities this person is involved in, and who else is ' +
          'named alongside them, drawing only on the sources. One item per project or activity.',
      },
    },
    {
      heading: 'Provenance',
      format: 'prose',
      fill: {
        kind: 'static',
        text: 'Compiled by Munin from the owner’s personal notes. Synthetic demonstration data.',
      },
    },
    {
      heading: 'Compiled by',
      format: 'field',
      fill: {
        kind: 'asked-of-user',
        slot: {
          kind: 'text',
          required: false,
          description: 'Who assembled this dossier (the human’s own input, not a Munin claim).',
        },
      },
    },
  ],
};

export const documentTemplates: readonly DocumentTemplate[] = [personDossier];
