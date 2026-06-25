// Minimal generic Configuration fixture for unit tests. Deliberately
// vertical-free: Alpha/Beta record types, colour-named tags.

import type { Configuration } from '@muninhq/shared';

export function testConfiguration(overrides: Partial<Configuration> = {}): Configuration {
  return {
    id: 'test-config',
    version: '1.0.0',
    entityTypes: [
      {
        name: 'Alpha',
        description: 'A test record type with an identity.',
        propertySchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        fewShots: [],
        resolution: {
          identityProperties: ['name'],
          distinguishingProperties: ['group'],
        },
      },
      {
        name: 'Beta',
        description: 'A test record type without identity.',
        propertySchema: { type: 'object', properties: {}, required: [] },
        fewShots: [],
      },
    ],
    relationshipTypes: [],
    terminology: {
      'entity.Alpha.singular': 'Alpha',
      'entity.Alpha.plural': 'Alphas',
      'nav.documents': 'Test records',
    },
    roles: [
      {
        name: 'reader',
        description: 'Reads red things.',
        baseTags: ['red', 'green'],
      },
      {
        name: 'writer',
        description: 'Reads green and blue things.',
        baseTags: ['green', 'blue'],
      },
    ],
    tagExpansion: (baseTags) => [...baseTags, ...baseTags.map((t) => `${t}:expanded`)],
    queryTemplates: [],
    connectors: [],
    ...overrides,
  };
}
