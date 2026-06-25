import { describe, expect, it } from 'vitest';

import { documentTemplates, personDossier } from './document-templates';
import { personalConfiguration } from './index';

describe('personDossier document template', () => {
  it('is wired into the configuration', () => {
    expect(personalConfiguration.documentTemplates).toBe(documentTemplates);
    expect(personalConfiguration.documentTemplates?.[0]).toBe(personDossier);
  });

  it('targets the generic Person entity type', () => {
    expect(personDossier.subjectEntityType).toBe('Person');
    // Rule 1: a personal template must not name a vertical concept. Check the
    // human-authored text (headings, instructions, static, slot descriptions) on
    // word boundaries — substring-matching JSON keys would false-trip ("format").
    const humanText = personDossier.sections
      .flatMap((s) => [
        s.heading,
        s.fill.kind === 'auto-from-gather' ? s.fill.instruction : '',
        s.fill.kind === 'static' ? s.fill.text : '',
        s.fill.kind === 'asked-of-user' ? (s.fill.slot.description ?? '') : '',
      ])
      .join(' ')
      .toLowerCase();
    for (const term of ['pupil', 'school', 'trust', 'safeguarding', 'ofsted', 'mat']) {
      expect(new RegExp(`\\b${term}\\b`).test(humanText), `must not name "${term}"`).toBe(false);
    }
  });

  it('exercises all three provenance classes', () => {
    const kinds = personDossier.sections.map((s) => s.fill.kind);
    expect(kinds).toContain('auto-from-gather');
    expect(kinds).toContain('static');
    expect(kinds).toContain('asked-of-user');
  });

  it('has at least one grounded (auto-from-gather) section for the eval to score', () => {
    const auto = personDossier.sections.filter((s) => s.fill.kind === 'auto-from-gather');
    expect(auto.length).toBeGreaterThanOrEqual(1);
    for (const s of auto) {
      if (s.fill.kind === 'auto-from-gather') expect(s.fill.instruction.length).toBeGreaterThan(10);
    }
  });

  it('has unique, non-empty section headings', () => {
    const headings = personDossier.sections.map((s) => s.heading);
    expect(new Set(headings).size).toBe(headings.length);
    for (const h of headings) expect(h.trim().length).toBeGreaterThan(0);
  });
});
