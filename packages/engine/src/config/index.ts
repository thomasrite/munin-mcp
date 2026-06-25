// Configuration loading + the config type surface, re-exported so Phase 2 (and
// the engine's own CLIs/worker) have a single import site for everything
// configuration-related. The configuration *types* live in `@muninhq/shared`
// (vertical-agnostic by construction); the engine adds the runtime loader that
// resolves a configuration package by name.

import type { Configuration, Overlay } from '@muninhq/shared';
import { composeConfiguration } from '@muninhq/shared';

// Re-export the configuration + evaluation type surface from @muninhq/shared.
// Phase 2 imports these from `@muninhq/engine` rather than reaching into shared.
export type {
  Configuration,
  ComposedConfiguration,
  Overlay,
  EntityTypeDefinition,
  EntityTypeExtension,
  RelationshipTypeDefinition,
  RoleDefinition,
  QueryTemplate,
  TerminologyMap,
  TagExpander,
  TagExpansionContext,
  ConnectorBinding,
  FewShotExample,
  EvalGroundTruth,
  EvalQuestion,
} from '@muninhq/shared';
export {
  composeConfiguration,
  computeCompositeHash,
  computeSchemaHash,
  ConfigurationCompositionError,
  MANAGE_TENANT,
  REVIEW_CORRECTIONS,
} from '@muninhq/shared';

// A caller-provided module loader: `(packageName) => import(packageName)`.
// The dynamic import() runs in the CALLER's module context, where the config
// package is a dependency. This is the supported resolution path (F20): the
// engine deliberately depends on no configuration package, so it cannot resolve
// a caller's config package from its own context.
export type ConfigModuleLoader = (packageName: string) => Promise<unknown>;

// Resolve a Configuration using a caller-provided module loader. THE SUPPORTED
// FORM. Callers pass `(pkg) => import(pkg)` so resolution happens in their
// context (CLIs/worker/web all carry the config package as a dependency).
export async function loadConfigurationWithResolver(
  packageName: string,
  load: ConfigModuleLoader,
): Promise<Configuration> {
  const mod = (await load(packageName)) as Record<string, unknown>;
  return pickConfiguration(mod, packageName);
}

// @deprecated Resolves via the ENGINE's module context, which CANNOT resolve a
// configuration package that is only the caller's dependency (F20 —
// `ERR_MODULE_NOT_FOUND`). Use {@link loadConfigurationWithResolver} with a
// caller-provided `(pkg) => import(pkg)`. Retained only for packages that are
// genuinely engine-resolvable (e.g. test fixtures); on failure it throws a clear
// "pass a resolver" message rather than an opaque module-resolution error.
export async function loadConfigurationFromPackage(packageName: string): Promise<Configuration> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(packageName)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `loadConfigurationFromPackage could not resolve '${packageName}' from the engine's module context. Pass a caller-provided resolver instead: loadConfigurationWithResolver('${packageName}', (p) => import(p)).`,
      { cause: err },
    );
  }
  return pickConfiguration(mod, packageName);
}

function pickConfiguration(mod: Record<string, unknown>, packageName: string): Configuration {
  // Preferred export names, tried in order.
  for (const key of ['default', 'configuration']) {
    const value = mod[key];
    if (isConfiguration(value)) return value;
  }
  // Fallback: any single Configuration-shaped export.
  for (const value of Object.values(mod)) {
    if (isConfiguration(value)) return value;
  }
  throw new Error(`no Configuration export found in ${packageName}`);
}

// Compose a tenant's effective configuration: base + the tenant's stored overlay
// (if any). The no-overlay path returns the base configuration BYTE-UNCHANGED
// (Decision 9) — not a re-emitted composition — so nothing that depends on the
// base config's bytes/hashes shifts for a tenant with no overlay. With an
// overlay, the existing shared `composeConfiguration` does the work (the engine
// never reimplements composition); extension-only is enforced there.
export function composeTenantConfiguration(
  base: Configuration,
  overlay?: Overlay | null,
): Configuration {
  if (!overlay) return base;
  return composeConfiguration(base, overlay);
}

function isConfiguration(value: unknown): value is Configuration {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entityTypes' in value &&
    'relationshipTypes' in value
  );
}
