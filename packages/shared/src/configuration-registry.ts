// The cartridge registry (P4) — the map from a tenant's opaque cartridge id to
// the configuration PACKAGE NAME that supplies it.
//
// LAYERING (invariant 3): this file holds OPAQUE STRINGS ONLY — cartridge ids and
// package-name strings. It imports NO configuration package (that would invert
// the layering: @muninhq/shared sits BELOW the config packages). The actual
// dynamic `import()` of a package lives in the web's static resolver, which
// carries the packages as devDependencies.
//
// RULE 1 (vertical-agnostic shared): the ids and package names here are opaque
// IDENTIFIERS, not vertical concepts — @muninhq/shared never interprets what a
// cartridge id MEANS, exactly as it never interprets the value of the
// MUNIN_CONFIG_PACKAGE env var. Human-readable labels/descriptions for the picker
// are deliberately NOT here: they are vertical vocabulary, so the consumer (the
// web onboarding screen) derives them from each cartridge's OWN loaded
// Configuration (`description` / terminology) — the vertical owns its own name.
//
// OPEN-CORE SCOPE: this public copy registers only the OPEN cartridges (the
// neutral baseline + the personal profile). Closed verticals register their own
// id → package mapping in their own deployment build; the registry stays additive
// and unknown/stale ids resolve to undefined (callers fall back to the
// env/baseline default), so dropping the closed entries here is behaviour-safe.

// A selectable cartridge: its stable id (stored opaquely in tenant_settings) and
// the package name the web resolver imports to load it.
export interface CartridgeDescriptor {
  readonly id: string;
  readonly package: string;
}

// id → package name. The baseline is the neutral product default; `personal` is
// the local-product profile. Add a cartridge by adding an entry here AND an import
// arm in the web's resolver (+ a devDependency) — the two are deliberately
// separate so shared never imports a config package. (Closed verticals are not
// listed in this open-core copy — see the OPEN-CORE SCOPE note above.)
const CARTRIDGE_PACKAGES: Readonly<Record<string, string>> = {
  'generic-baseline': '@muninhq/config-generic-baseline',
  personal: '@muninhq/config-personal',
};

// Resolve a cartridge id to its package name, or undefined for an unknown id.
// Callers treat undefined as "fall back to the env/baseline default" — an unknown
// or stale id must never crash a tenant's config load.
export function cartridgePackage(id: string): string | undefined {
  // Own-property guard so a prototype key ('__proto__', 'toString') can never
  // resolve to a non-string — a malicious/stale id must yield undefined.
  return Object.hasOwn(CARTRIDGE_PACKAGES, id) ? CARTRIDGE_PACKAGES[id] : undefined;
}

// The selectable cartridges (id + package), for the onboarding picker. Display
// labels are NOT here (see the Rule 1 note above) — the picker derives them from
// each cartridge's loaded Configuration.
export function knownCartridges(): readonly CartridgeDescriptor[] {
  return Object.entries(CARTRIDGE_PACKAGES).map(([id, pkg]) => ({ id, package: pkg }));
}

// True iff `id` names a registered cartridge.
export function isKnownCartridge(id: string): boolean {
  return Object.hasOwn(CARTRIDGE_PACKAGES, id);
}
