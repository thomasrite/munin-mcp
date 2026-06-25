import { describe, expect, it } from 'vitest';

import { GitignoreStack, parseGitignore } from './gitignore';

function root(content: string): GitignoreStack {
  return GitignoreStack.empty().withFile('', content);
}

describe('parseGitignore', () => {
  it('skips blank lines and comments', () => {
    expect(parseGitignore('\n# a comment\n\n   \n')).toHaveLength(0);
    expect(parseGitignore('*.log\n# c\nbuild/')).toHaveLength(2);
  });
});

describe('GitignoreStack — basic patterns', () => {
  it('ignores a directory pattern and everything under it', () => {
    const gi = root('node_modules/\n');
    expect(gi.isIgnored('node_modules', true)).toBe(true);
    expect(gi.isIgnored('node_modules/dep/index.js', false)).toBe(true);
    expect(gi.isIgnored('src/index.ts', false)).toBe(false);
  });

  it('matches a non-anchored glob at any depth', () => {
    const gi = root('*.log\n');
    expect(gi.isIgnored('app.log', false)).toBe(true);
    expect(gi.isIgnored('logs/server.log', false)).toBe(true);
    expect(gi.isIgnored('app.ts', false)).toBe(false);
  });

  it('anchors a leading-slash pattern to the root', () => {
    const gi = root('/build\n');
    expect(gi.isIgnored('build', true)).toBe(true);
    expect(gi.isIgnored('build/out.js', false)).toBe(true);
    expect(gi.isIgnored('src/build', true)).toBe(false);
  });

  it('limits a single * to one path segment', () => {
    const gi = root('docs/*.md\n');
    expect(gi.isIgnored('docs/readme.md', false)).toBe(true);
    expect(gi.isIgnored('docs/sub/readme.md', false)).toBe(false);
    expect(gi.isIgnored('readme.md', false)).toBe(false);
  });

  it('matches ** across segments', () => {
    const gi = root('**/temp\n');
    expect(gi.isIgnored('temp', true)).toBe(true);
    expect(gi.isIgnored('a/temp', true)).toBe(true);
    expect(gi.isIgnored('a/b/temp', true)).toBe(true);
  });

  it('treats a non-component ** as a regular single-segment * (ReDoS-safe)', () => {
    // `a**b` is NOT a `**` component (not bounded by slashes) -> single segment.
    const gi = root('a**b\n');
    expect(gi.isIgnored('axyzb', false)).toBe(true);
    expect(gi.isIgnored('a/b', false)).toBe(false); // does not cross a separator
  });

  it('does not hang on a pathological asterisk pattern', () => {
    // Pre-fix, this shape caused catastrophic backtracking. It must now resolve
    // effectively instantly because runs of '*' collapse to one quantifier.
    const gi = root('**a**a**a**a**a**a**a**a\n');
    const start = performance.now();
    expect(gi.isIgnored('x'.repeat(2000), false)).toBe(false);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('skips absurdly long patterns rather than compiling them', () => {
    expect(parseGitignore(`${'a'.repeat(5000)}\n`)).toHaveLength(0);
  });

  it('treats a directory-only pattern as not matching a like-named file', () => {
    const gi = root('cache/\n');
    expect(gi.isIgnored('cache', true)).toBe(true); // a directory
    expect(gi.isIgnored('cache/data.bin', false)).toBe(true); // under it
    expect(gi.isIgnored('cache', false)).toBe(false); // a FILE named "cache"
  });
});

describe('GitignoreStack — negation and nesting', () => {
  it('re-includes a file via a later negation (last match wins)', () => {
    const gi = root('*.log\n!keep.log\n');
    expect(gi.isIgnored('debug.log', false)).toBe(true);
    expect(gi.isIgnored('keep.log', false)).toBe(false);
  });

  it('lets a deeper .gitignore override a shallower one', () => {
    const gi = GitignoreStack.empty().withFile('', '*.tmp\n').withFile('pkg', '!important.tmp\n');
    expect(gi.isIgnored('a.tmp', false)).toBe(true); // shallow rule applies
    expect(gi.isIgnored('pkg/important.tmp', false)).toBe(false); // deeper negation wins
    expect(gi.isIgnored('pkg/other.tmp', false)).toBe(true); // still ignored
  });

  it('does not apply a nested file to paths outside its directory', () => {
    const gi = GitignoreStack.empty().withFile('pkg', 'secret.key\n');
    expect(gi.isIgnored('pkg/secret.key', false)).toBe(true);
    expect(gi.isIgnored('secret.key', false)).toBe(false);
    expect(gi.isIgnored('other/secret.key', false)).toBe(false);
  });
});
