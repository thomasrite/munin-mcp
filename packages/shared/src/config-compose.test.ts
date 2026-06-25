import { describe, expect, it } from 'vitest';
import {
  ConfigurationCompositionError,
  composeConfiguration,
  computeSchemaHash,
} from './config-compose';
import { entityType, num, relationshipType, role, str } from './config-helpers';
import type { Configuration, Overlay } from './config-schema';

function baseConfiguration(): Configuration {
  return {
    id: 'test-base',
    version: '0.1.0',
    entityTypes: [
      entityType({
        name: 'Project',
        description: 'A unit of work',
        properties: { name: str(), status: str({ enum: ['planning', 'active', 'done'] }) },
        required: ['name'],
        fewShots: [
          {
            input: 'The Atlas project began in March.',
            output: {
              entities: [{ type: 'Project', properties: { name: 'Atlas', status: 'active' } }],
            },
          },
        ],
      }),
    ],
    relationshipTypes: [
      relationshipType({
        name: 'managedBy',
        description: 'A Project is managed by a Person',
        fromTypes: ['Project'],
        toTypes: ['Person'],
      }),
    ],
    terminology: { 'entity.Project.singular': 'Project', 'entity.Project.plural': 'Projects' },
    roles: [role({ name: 'admin', description: 'Admin', baseTags: ['t:admin'] })],
    tagExpansion: (tags) => tags,
    queryTemplates: [],
    connectors: [],
  };
}

describe('composeConfiguration — no overlays', () => {
  it('returns the base wrapped with hashes and empty applied overlays', () => {
    const composed = composeConfiguration(baseConfiguration());
    expect(composed.appliedOverlays).toEqual([]);
    expect(composed.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(composed.compositeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(composed.entityTypes).toEqual(baseConfiguration().entityTypes);
  });
});

describe('schemaHash — extraction-affecting only', () => {
  it('is stable across changes to terminology', () => {
    const a = baseConfiguration();
    const b: Configuration = {
      ...baseConfiguration(),
      terminology: { ...baseConfiguration().terminology, 'extra.key': 'extra' },
    };
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b));
  });

  it('is stable across changes to roles', () => {
    const a = baseConfiguration();
    const b: Configuration = {
      ...baseConfiguration(),
      roles: [
        ...baseConfiguration().roles,
        role({ name: 'guest', description: 'Guest', baseTags: ['t:guest'] }),
      ],
    };
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b));
  });

  it('changes when an entity type is added', () => {
    const a = baseConfiguration();
    const b: Configuration = {
      ...baseConfiguration(),
      entityTypes: [
        ...baseConfiguration().entityTypes,
        entityType({
          name: 'Task',
          description: 'A discrete chunk of work',
          properties: { title: str() },
          required: ['title'],
          fewShots: [],
        }),
      ],
    };
    expect(computeSchemaHash(a)).not.toBe(computeSchemaHash(b));
  });

  it('changes when an entity type description changes (description is in the prompt)', () => {
    const a = baseConfiguration();
    const b: Configuration = {
      ...baseConfiguration(),
      entityTypes: [
        entityType({
          name: 'Project',
          description: 'A different description',
          properties: { name: str() },
          required: ['name'],
          fewShots: baseConfiguration().entityTypes[0]!.fewShots,
        }),
      ],
    };
    expect(computeSchemaHash(a)).not.toBe(computeSchemaHash(b));
  });

  it('is invariant to property insertion order in objects', () => {
    const a: Configuration = {
      ...baseConfiguration(),
      entityTypes: [
        entityType({
          name: 'Person',
          description: 'A human',
          properties: { fullName: str(), email: str() },
          required: ['fullName'],
          fewShots: [],
        }),
      ],
    };
    const b: Configuration = {
      ...baseConfiguration(),
      entityTypes: [
        entityType({
          name: 'Person',
          description: 'A human',
          properties: { email: str(), fullName: str() },
          required: ['fullName'],
          fewShots: [],
        }),
      ],
    };
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b));
  });
});

describe('overlay — extension on extraction schema', () => {
  it('adds a new entity type', () => {
    const overlay: Overlay = {
      id: 'ovl-add',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      addEntityTypes: [
        entityType({
          name: 'Task',
          description: 'A unit of work',
          properties: { title: str() },
          required: ['title'],
          fewShots: [],
        }),
      ],
    };
    const composed = composeConfiguration(baseConfiguration(), overlay);
    expect(composed.entityTypes.map((e) => e.name)).toEqual(['Project', 'Task']);
    expect(composed.appliedOverlays).toEqual(['ovl-add']);
  });

  it('extends an existing entity type with new properties', () => {
    const overlay: Overlay = {
      id: 'ovl-extend',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      extendEntityTypes: [
        {
          name: 'Project',
          addProperties: { budget: num({ minimum: 0 }) },
        },
      ],
    };
    const composed = composeConfiguration(baseConfiguration(), overlay);
    const project = composed.entityTypes.find((e) => e.name === 'Project');
    expect(project?.propertySchema.properties.budget).toEqual({
      type: 'number',
      minimum: 0,
    });
  });

  it('refuses to redefine an existing entity type', () => {
    const overlay: Overlay = {
      id: 'ovl-redefine',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      addEntityTypes: [
        entityType({
          name: 'Project',
          description: 'redefined',
          properties: { title: str() },
          required: ['title'],
          fewShots: [],
        }),
      ],
    };
    expect(() => composeConfiguration(baseConfiguration(), overlay)).toThrow(
      ConfigurationCompositionError,
    );
  });

  it('refuses to extend a non-existent entity type', () => {
    const overlay: Overlay = {
      id: 'ovl-bad-extend',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      extendEntityTypes: [{ name: 'Nope', addProperties: { x: str() } }],
    };
    expect(() => composeConfiguration(baseConfiguration(), overlay)).toThrow(/does not exist/);
  });

  it('refuses to redefine an existing property on an extended entity type', () => {
    const overlay: Overlay = {
      id: 'ovl-prop-clash',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      extendEntityTypes: [{ name: 'Project', addProperties: { name: str({ minLength: 5 }) } }],
    };
    expect(() => composeConfiguration(baseConfiguration(), overlay)).toThrow(
      /redefinition is not permitted/i,
    );
  });

  it('refuses to redefine an existing relationship type', () => {
    const overlay: Overlay = {
      id: 'ovl-rel-redefine',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      addRelationshipTypes: [
        relationshipType({
          name: 'managedBy',
          description: 'duplicate',
          fromTypes: ['Project'],
          toTypes: ['Person'],
        }),
      ],
    };
    expect(() => composeConfiguration(baseConfiguration(), overlay)).toThrow(
      ConfigurationCompositionError,
    );
  });
});

describe('overlay — cosmetic overrides', () => {
  it('merges terminology last-write-wins per key', () => {
    const overlay: Overlay = {
      id: 'ovl-term',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      terminology: { 'entity.Project.singular': 'Initiative' },
    };
    const composed = composeConfiguration(baseConfiguration(), overlay);
    expect(composed.terminology['entity.Project.singular']).toBe('Initiative');
    expect(composed.terminology['entity.Project.plural']).toBe('Projects');
  });

  it('replaces a role of the same name', () => {
    const overlay: Overlay = {
      id: 'ovl-role',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      roles: [role({ name: 'admin', description: 'Re-defined admin', baseTags: ['t:super'] })],
    };
    const composed = composeConfiguration(baseConfiguration(), overlay);
    const admin = composed.roles.find((r) => r.name === 'admin');
    expect(admin?.baseTags).toEqual(['t:super']);
  });

  it('terminology change does not affect schemaHash', () => {
    const baseConfig = baseConfiguration();
    const overlay: Overlay = {
      id: 'ovl-term',
      version: '0.1.0',
      baseConfigurationId: 'test-base',
      terminology: { 'entity.Project.singular': 'Initiative' },
    };
    const a = composeConfiguration(baseConfig);
    const b = composeConfiguration(baseConfig, overlay);
    expect(a.schemaHash).toBe(b.schemaHash);
    expect(a.compositeHash).not.toBe(b.compositeHash);
  });

  it('entity-resolution hints (M1.1) affect compositeHash but NOT schemaHash', () => {
    // Resolution is query-time config; it must never invalidate the extraction
    // prompt cache (schemaHash). It must be reflected in compositeHash.
    const baseConfig = baseConfiguration();
    const withResolution: Configuration = {
      ...baseConfig,
      entityTypes: baseConfig.entityTypes.map((e) =>
        e.name === 'Project' ? { ...e, resolution: { identityProperties: ['name'] } } : e,
      ),
    };
    const a = composeConfiguration(baseConfig);
    const b = composeConfiguration(withResolution);
    expect(a.schemaHash).toBe(b.schemaHash);
    expect(a.compositeHash).not.toBe(b.compositeHash);
  });

  it('document templates (M2.2) affect compositeHash but NOT schemaHash', () => {
    // DocumentTemplates are generation-time config; like queryTemplates they
    // must never invalidate the extraction prompt cache (schemaHash).
    const baseConfig = baseConfiguration();
    const withTemplate: Configuration = {
      ...baseConfig,
      documentTemplates: [
        {
          id: 'dossier',
          title: 'Person dossier',
          subjectEntityType: 'Person',
          sections: [
            {
              heading: 'Summary',
              format: 'prose',
              fill: { kind: 'auto-from-gather', instruction: 'Summarise.' },
            },
          ],
        },
      ],
    };
    const a = composeConfiguration(baseConfig);
    const b = composeConfiguration(withTemplate);
    expect(a.schemaHash).toBe(b.schemaHash);
    expect(a.compositeHash).not.toBe(b.compositeHash);
  });
});

describe('overlay — base configuration mismatch', () => {
  it('throws when overlay targets a different base', () => {
    const overlay: Overlay = {
      id: 'ovl-wrong-base',
      version: '0.1.0',
      baseConfigurationId: 'some-other-config',
    };
    expect(() => composeConfiguration(baseConfiguration(), overlay)).toThrow(
      /targets base configuration/,
    );
  });
});
