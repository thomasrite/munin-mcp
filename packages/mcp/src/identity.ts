// The configuration's identity layer, in ContextRetriever terms.
//
// Subject types are the entity types that declare `resolution` hints — the
// configuration's stated identity layer (M1.1). This is deliberately broader
// than the web ask action's documentTemplates-derived subject list: a
// configuration with no document templates would otherwise lose the gather
// path entirely, and resolution hints are the more direct declaration of
// "this type has an identity worth gathering by".

import type { IdentityRouting } from '@muninhq/engine';
import type { Configuration, EntityResolutionHints } from '@muninhq/shared';

export function buildIdentity(configuration: Configuration, pick?: string): IdentityRouting {
  const withHints = configuration.entityTypes.filter((e) => e.resolution);
  const hintsByType = new Map<string, EntityResolutionHints>();
  for (const e of withHints) {
    if (e.resolution) hintsByType.set(e.name, e.resolution);
  }
  return {
    subjectTypes: withHints.map((e) => e.name),
    hintsByType,
    ...(pick !== undefined ? { pick } : {}),
  };
}
