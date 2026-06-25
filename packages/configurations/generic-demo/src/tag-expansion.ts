import type { TagExpander } from '@muninhq/shared';

// The demo models a simple three-level clearance hierarchy:
//   demo:sysadmin ⊇ demo:member ⊇ demo:public
// A holder of a higher clearance also sees everything visible to lower ones.
// This is exactly the kind of hierarchy the engine deliberately does NOT know
// about (decisions 5): the engine receives a flat string[] and does set
// intersection; the *configuration* enumerates the hierarchy here. The
// throwaway MAT/accountancy sketches expand trust→school and firm→office the
// same way.
//
// Documents are tagged with a single sensitivity tag (demo:public /
// demo:member / demo:sysadmin). A caller's role base tag is expanded downward
// so the intersection grants the expected visibility:
//   guest  [demo:public]    → [demo:public]
//   member [demo:member]    → [demo:member, demo:public]
//   admin  [demo:sysadmin]  → [demo:sysadmin, demo:member, demo:public]

const BELOW: Record<string, readonly string[]> = {
  'demo:sysadmin': ['demo:member', 'demo:public'],
  'demo:member': ['demo:public'],
  'demo:public': [],
};

export const tagExpansion: TagExpander = (baseTags) => {
  const expanded = new Set<string>(baseTags);
  for (const tag of baseTags) {
    for (const lower of BELOW[tag] ?? []) expanded.add(lower);
  }
  return [...expanded];
};
