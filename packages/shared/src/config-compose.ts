// Composition of a base configuration with zero or more overlays.
//
// Rules (see `decisions.md`):
//   - Extension-only on extraction schema. Adding a new entity type with a
//     name that already exists, or extending a type by redefining an
//     existing property, throws.
//   - Cosmetic items (terminology, roles, tag expansion, query templates,
//     connectors) are merged with per-key last-write-wins semantics.
//   - The composed configuration carries two hashes:
//       - schemaHash    — over extraction-affecting parts only
//       - compositeHash — over the whole effective configuration including
//                         cosmetic items and applied overlay ids

import { createHash } from 'node:crypto';
import type {
  ComposedConfiguration,
  Configuration,
  EntityTypeDefinition,
  Overlay,
  RelationshipTypeDefinition,
} from './config-schema';

export function composeConfiguration(
  base: Configuration,
  ...overlays: readonly Overlay[]
): ComposedConfiguration {
  let result: Configuration = base;
  const appliedOverlayIds: string[] = [];

  for (const overlay of overlays) {
    if (overlay.baseConfigurationId !== base.id) {
      throw new ConfigurationCompositionError(
        `Overlay '${overlay.id}' targets base configuration '${overlay.baseConfigurationId}', ` +
          `but the base provided is '${base.id}'`,
      );
    }
    result = applyOverlay(result, overlay);
    appliedOverlayIds.push(overlay.id);
  }

  const schemaHash = computeSchemaHash(result);
  const compositeHash = computeCompositeHash(result, appliedOverlayIds);

  return {
    ...result,
    schemaHash,
    compositeHash,
    appliedOverlays: appliedOverlayIds,
  };
}

function applyOverlay(base: Configuration, overlay: Overlay): Configuration {
  const entityTypes = applyEntityTypeChanges(base.entityTypes, overlay);
  const relationshipTypes = applyRelationshipTypeChanges(base.relationshipTypes, overlay);

  return {
    ...base,
    entityTypes,
    relationshipTypes,
    terminology: overlay.terminology
      ? { ...base.terminology, ...overlay.terminology }
      : base.terminology,
    roles: overlay.roles ? mergeByKey(base.roles, overlay.roles, (r) => r.name) : base.roles,
    tagExpansion: overlay.tagExpansion ?? base.tagExpansion,
    queryTemplates: overlay.queryTemplates
      ? mergeByKey(base.queryTemplates, overlay.queryTemplates, (q) => q.id)
      : base.queryTemplates,
    connectors: overlay.connectors
      ? mergeByKey(base.connectors, overlay.connectors, (c) => c.packageName)
      : base.connectors,
    // Only override when the overlay supplies templates; otherwise `...base`
    // carries the base value (avoids setting an optional prop to undefined under
    // exactOptionalPropertyTypes).
    ...(overlay.documentTemplates
      ? {
          documentTemplates: mergeByKey(
            base.documentTemplates ?? [],
            overlay.documentTemplates,
            (d) => d.id,
          ),
        }
      : {}),
  };
}

function applyEntityTypeChanges(
  base: readonly EntityTypeDefinition[],
  overlay: Overlay,
): readonly EntityTypeDefinition[] {
  let next: EntityTypeDefinition[] = [...base];

  for (const added of overlay.addEntityTypes ?? []) {
    if (next.some((e) => e.name === added.name)) {
      throw new ConfigurationCompositionError(
        `Overlay '${overlay.id}' adds entity type '${added.name}' but it already exists. Use extendEntityTypes to add properties, or rename the new type. Redefinition of existing entity types is not permitted.`,
      );
    }
    next.push(added);
  }

  for (const ext of overlay.extendEntityTypes ?? []) {
    const existingIndex = next.findIndex((e) => e.name === ext.name);
    if (existingIndex < 0) {
      throw new ConfigurationCompositionError(
        `Overlay '${overlay.id}' extends entity type '${ext.name}' but it does not exist`,
      );
    }
    const existing = next[existingIndex];
    if (!existing) {
      throw new ConfigurationCompositionError(
        `Internal: entity type '${ext.name}' lookup returned undefined`,
      );
    }

    for (const propName of Object.keys(ext.addProperties)) {
      if (propName in existing.propertySchema.properties) {
        throw new ConfigurationCompositionError(
          `Overlay '${overlay.id}' adds property '${ext.name}.${propName}' but a property with that name already exists. Property redefinition is not permitted on extraction-schema items.`,
        );
      }
    }

    const mergedProperties: Record<string, (typeof existing.propertySchema.properties)[string]> = {
      ...existing.propertySchema.properties,
      ...ext.addProperties,
    };
    const mergedRequired = uniqueStrings([
      ...existing.propertySchema.required,
      ...(ext.addRequired ?? []),
    ]);
    const mergedFewShots = [...existing.fewShots, ...(ext.addFewShots ?? [])];

    const updated: EntityTypeDefinition = {
      name: existing.name,
      description: existing.description,
      propertySchema: {
        type: 'object',
        properties: mergedProperties,
        required: mergedRequired,
        ...(existing.propertySchema.description !== undefined
          ? { description: existing.propertySchema.description }
          : {}),
        ...(existing.propertySchema.additionalProperties !== undefined
          ? { additionalProperties: existing.propertySchema.additionalProperties }
          : {}),
      },
      fewShots: mergedFewShots,
    };
    next = next.map((e, i) => (i === existingIndex ? updated : e));
  }

  return next;
}

function applyRelationshipTypeChanges(
  base: readonly RelationshipTypeDefinition[],
  overlay: Overlay,
): readonly RelationshipTypeDefinition[] {
  const next: RelationshipTypeDefinition[] = [...base];

  for (const added of overlay.addRelationshipTypes ?? []) {
    if (next.some((r) => r.name === added.name)) {
      throw new ConfigurationCompositionError(
        `Overlay '${overlay.id}' adds relationship type '${added.name}' but it already exists. Redefinition of existing relationship types is not permitted.`,
      );
    }
    next.push(added);
  }

  return next;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

// Hash of the extraction-affecting structural parts. Changes here invalidate
// the Bedrock extraction prompt cache and bump `extractor_version` on facts.
export function computeSchemaHash(config: Configuration): string {
  const structural = {
    id: config.id,
    version: config.version,
    entityTypes: config.entityTypes.map((e) => ({
      name: e.name,
      description: e.description,
      propertySchema: e.propertySchema,
      fewShots: e.fewShots,
    })),
    relationshipTypes: config.relationshipTypes.map((r) => ({
      name: r.name,
      description: r.description,
      fromTypes: r.fromTypes,
      toTypes: r.toTypes,
      propertySchema: r.propertySchema,
      fewShots: r.fewShots,
    })),
  };
  return sha256(canonicalJson(structural));
}

// Hash of the whole effective configuration including cosmetic items and the
// applied overlay sequence. Changes here may invalidate UI/role caches but
// must never invalidate extraction caches unless `schemaHash` also changed.
export function computeCompositeHash(
  config: Configuration,
  appliedOverlays: readonly string[],
): string {
  const full = {
    schemaHash: computeSchemaHash(config),
    terminology: config.terminology,
    roles: config.roles,
    queryTemplates: config.queryTemplates,
    connectors: config.connectors,
    appliedOverlays,
    // Query-time entity-resolution hints (M1.1) are compositeHash-only — they
    // affect resolution/UI behaviour but must NEVER invalidate the extraction
    // schema hash (which projects only name/description/propertySchema/fewShots).
    entityResolution: config.entityTypes.map((e) => ({
      name: e.name,
      resolution: e.resolution ?? null,
    })),
    // Included only when present so configurations without recommended query
    // defaults keep their existing composite hash unchanged. Query defaults are
    // a cosmetic/behavioural item (like queryTemplates) — they never affect the
    // extraction schema hash.
    ...(config.queryDefaults !== undefined ? { queryDefaults: config.queryDefaults } : {}),
    // Document templates (M2.2) are generation-time config — compositeHash only,
    // never schemaHash (they don't affect extraction). Included only when present
    // so configurations without them keep their existing composite hash. Slot
    // definitions serialise structurally; no functions are involved.
    ...(config.documentTemplates !== undefined
      ? { documentTemplates: config.documentTemplates }
      : {}),
  };
  return sha256(canonicalJson(full));
}

// Canonical JSON: recursively sort object keys, then serialise. Functions
// are not serialisable; tag-expansion functions are excluded from hashing
// by construction (they don't appear in the structural projections above).
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'function') {
    throw new ConfigurationCompositionError(
      'Cannot canonicalise function value in configuration hash input',
    );
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function mergeByKey<T>(
  base: readonly T[],
  overlay: readonly T[],
  keyOf: (item: T) => string,
): readonly T[] {
  const byKey = new Map<string, T>();
  for (const item of base) byKey.set(keyOf(item), item);
  for (const item of overlay) byKey.set(keyOf(item), item);
  return Array.from(byKey.values());
}

function uniqueStrings(items: readonly string[]): readonly string[] {
  return Array.from(new Set(items));
}

export class ConfigurationCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationCompositionError';
  }
}
