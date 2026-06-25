// A focused, dependency-free `.gitignore` matcher.
//
// Supports the common subset that matters for codebase ingestion:
//   * comments (`#…`) and blank lines;
//   * negation (`!pattern`);
//   * directory-only patterns (trailing `/`);
//   * anchoring — a leading `/` or an interior `/` anchors to the .gitignore's
//     own directory; otherwise the pattern matches at any depth;
//   * `*` (within a path segment), `?`, and `**` (spanning segments);
//   * nested .gitignore files — patterns are evaluated relative to the
//     directory the file lives in, deeper files overriding shallower ones,
//     and within a file the last matching pattern wins.
//
// Deliberately NOT supported (rare in real repos; documented so callers know):
//   * character classes (`[a-z]`), and backslash escapes beyond a leading
//     `\#` / `\!`. Such a pattern is matched literally as best-effort.
//
// All paths handled here are POSIX, relative to the walk root ('' = root).

export interface GitignoreRule {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  // Matches the path itself.
  readonly self: RegExp;
  // Matches paths that live UNDER the matched path (i.e. the matched path is a
  // directory). Used so ignoring `build/` also ignores everything beneath it.
  readonly under: RegExp;
}

interface Layer {
  readonly baseRel: string;
  readonly rules: readonly GitignoreRule[];
}

export function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const rule = compileLine(rawLine);
    if (rule) rules.push(rule);
  }
  return rules;
}

// No real .gitignore pattern is anywhere near this long; anything longer is
// skipped rather than compiled (belt-and-braces against pathological input).
const MAX_PATTERN_LENGTH = 4096;

function compileLine(rawLine: string): GitignoreRule | null {
  // Strip trailing whitespace (git ignores it unless backslash-escaped — that
  // rare escape is not supported here).
  let line = rawLine.replace(/\s+$/, '');
  if (line.length === 0 || line.length > MAX_PATTERN_LENGTH) return null;
  // Blank / comment lines (a leading '\#' is a literal '#').
  if (line.startsWith('#')) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);

  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) return null;

  // A slash anywhere (other than a trailing one, already stripped) anchors the
  // pattern to the base directory.
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);

  const body = translateGlob(line);
  const prefix = anchored ? '' : '(?:.*/)?';
  return {
    negated,
    dirOnly,
    self: new RegExp(`^${prefix}${body}$`),
    under: new RegExp(`^${prefix}${body}/`),
  };
}

// Translate a gitignore glob (with the leading/trailing markers already
// stripped) into a regex body.
//
// Per the gitignore spec, `**` is only special when it is a COMPLETE path
// component — `**/`, `/**`, `/**/`, or the whole pattern. Any other run of
// asterisks ("***", or "**" not bounded by slashes like `a**b`) is a regular
// single-segment `*`. Honouring that rule has a useful side effect: a run of
// asterisks collapses to a single `[^/]*` quantifier, so we never emit adjacent
// unbounded quantifiers — which is what made a crafted `.gitignore` a ReDoS
// vector (catastrophic backtracking against repo-supplied pattern content).
function translateGlob(glob: string): string {
  let re = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === '*') {
      const start = i;
      while (i < n && glob[i] === '*') i++;
      const runLen = i - start;
      const boundedLeft = start === 0 || glob[start - 1] === '/';
      const boundedRight = i === n || glob[i] === '/';
      if (runLen === 2 && boundedLeft && boundedRight) {
        if (i < n) {
          i++; // consume the trailing '/'
          re += '(?:[^/]*/)*'; // '**/' — zero or more directory segments
        } else {
          re += '.*'; // trailing '/**' (or the whole pattern '**') — span all
        }
      } else {
        // Regular asterisk(s): one bounded, single-segment quantifier. Any run
        // length collapses to one — no adjacent-quantifier backtracking.
        re += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '/') {
      re += '/';
      i++;
      continue;
    }
    re += (c ?? '').replace(/[.+^${}()|[\]\\]/, '\\$&');
    i++;
  }
  return re;
}

// An ordered (shallow → deep) stack of compiled .gitignore layers. Immutable:
// descending into a directory with its own .gitignore produces a NEW stack, so
// sibling subtrees never see each other's rules.
export class GitignoreStack {
  private constructor(private readonly layers: readonly Layer[]) {}

  static empty(): GitignoreStack {
    return new GitignoreStack([]);
  }

  withFile(baseRel: string, content: string): GitignoreStack {
    const rules = parseGitignore(content);
    if (rules.length === 0) return this;
    return new GitignoreStack([...this.layers, { baseRel, rules }]);
  }

  isEmpty(): boolean {
    return this.layers.length === 0;
  }

  // Decide whether `relPath` (POSIX, relative to the walk root) is ignored.
  // Last matching rule wins, deeper layers overriding shallower ones.
  //
  // Invariant: the walk (index.ts) prunes an excluded DIRECTORY before
  // descending, so this is never asked about a file whose ancestor directory
  // was excluded. That matters because git forbids re-including a file under an
  // excluded directory — a guarantee provided here by the pruning, not by this
  // method. A future caller that asks `isIgnored` about arbitrary paths must not
  // rely on a `!negation` re-including children of an already-excluded dir.
  isIgnored(relPath: string, isDir: boolean): boolean {
    let decision = false;
    for (const layer of this.layers) {
      const sub = relativeTo(layer.baseRel, relPath);
      if (sub === null) continue;
      for (const rule of layer.rules) {
        if (matchesRule(rule, sub, isDir)) decision = !rule.negated;
      }
    }
    return decision;
  }
}

function matchesRule(rule: GitignoreRule, sub: string, isDir: boolean): boolean {
  // A descendant of a matched path is always ignored (the parent directory
  // matched), regardless of dirOnly.
  if (rule.under.test(sub)) return true;
  if (rule.self.test(sub)) return rule.dirOnly ? isDir : true;
  return false;
}

// `relPath` expressed relative to `baseRel`, or null when not under it.
function relativeTo(baseRel: string, relPath: string): string | null {
  if (baseRel === '') return relPath;
  if (relPath === baseRel) return '';
  if (relPath.startsWith(`${baseRel}/`)) return relPath.slice(baseRel.length + 1);
  return null;
}
