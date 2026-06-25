// Tool-description wording comes from the LOADED CONFIGURATION's terminology
// map — never from strings this package invents. The engine/adapter tier names
// no vertical or persona concept (Rule 1); whatever the configuration calls its
// records is what the connected LLM client sees.

import type { Configuration } from '@muninhq/shared';

/** The configured noun for the document collection (e.g. terminology['nav.documents']). */
export function recordsNoun(configuration: Configuration): string {
  return configuration.terminology['nav.documents']?.toLowerCase() ?? 'documents';
}

/**
 * The configured plural labels of the entity types that declare resolution
 * hints — the identity layer's subjects, in the configuration's own words.
 */
export function subjectNouns(configuration: Configuration): readonly string[] {
  return configuration.entityTypes
    .filter((e) => e.resolution)
    .map((e) => configuration.terminology[`entity.${e.name}.plural`]?.toLowerCase() ?? e.name);
}

/** Singular label for one entity type, from the terminology map. */
export function entityNoun(configuration: Configuration, typeName: string): string {
  return configuration.terminology[`entity.${typeName}.singular`] ?? typeName;
}
