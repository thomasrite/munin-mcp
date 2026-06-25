// Post-`tsc` ESM extension fixer (build-only; NO source change).
//
// `tsc` copies relative import/export specifiers verbatim — it never appends a
// file extension. Node's native ESM loader (these packages are `"type":
// "module"`) REQUIRES explicit extensions, so the emitted `dist/*.js` fail with
// `ERR_MODULE_NOT_FOUND` when run by plain `node` (they only resolved under
// `tsx`, whose loader is CJS-style and extension-tolerant). This walks the
// emitted `dist` and rewrites every RELATIVE specifier so it resolves under
// Node ESM:
//
//   './x'  -> './x.js'         (a sibling file)
//   './x'  -> './x/index.js'   (a directory barrel)
//   '..'   -> '../index.js'    (a parent-directory barrel)
//
// File-vs-directory is decided by probing the emitted tree on disk, so barrels
// and deep re-exports resolve correctly. Bare specifiers (`node:*`, `@muninhq/*`,
// third-party) and already-extensioned specifiers are left untouched. This is
// the dependency-free equivalent of `tsc-alias --resolve-full-paths`; it runs
// as the build step immediately after `tsc`, against the build output only —
// the engine (and every other package's) TypeScript SOURCE is never touched.
//
// Usage: `node <repo>/scripts/esm-fix.mjs [distDir]`  (distDir defaults to ./dist)
// Exits non-zero — naming the offenders — if any relative specifier cannot be
// resolved to a `.js` or `/index.js`, so a packaging gap can never ship silently.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.argv[2] ?? 'dist');
if (!existsSync(distDir)) {
  console.error(`esm-fix: dist directory not found at ${distDir} (run \`tsc\` first)`);
  process.exit(1);
}

/** All emitted JS + declaration files under dist. */
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && (full.endsWith('.js') || full.endsWith('.d.ts'))) {
      files.push(full);
    }
  }
})(distDir);

const ALREADY_EXTENSIONED = /\.(js|mjs|cjs|json|node|wasm|css)$/;

// The quoted specifier in: `... from '<s>'`, side-effect `import '<s>'`, and
// dynamic / type-query `import('<s>')`. We only ever touch RELATIVE specifiers
// (those that start with `.`); the captured prefix/quote/tail are preserved.
const STATIC_FROM = /(\bfrom\s*)(['"])(\.[^'"]*)\2/g;
const SIDE_EFFECT = /(\bimport\s*)(['"])(\.[^'"]*)\2/g;
const DYNAMIC_IMPORT = /(\bimport\s*\(\s*)(['"])(\.[^'"]*)\2(\s*\))/g;

const unresolved = new Set();

/** Resolve a relative specifier to its `.js` / `/index.js` form, or null if unchanged. */
function resolveSpecifier(fromFile, spec, isDts) {
  if (ALREADY_EXTENSIONED.test(spec)) return null;
  const probeExt = isDts ? '.d.ts' : '.js';
  const abs = path.resolve(path.dirname(fromFile), spec);
  if (existsSync(abs + probeExt) && statSync(abs + probeExt).isFile()) {
    return `${spec}.js`;
  }
  const indexProbe = path.join(abs, `index${probeExt}`);
  if (existsSync(indexProbe) && statSync(indexProbe).isFile()) {
    return spec.endsWith('/') ? `${spec}index.js` : `${spec}/index.js`;
  }
  unresolved.add(`${path.relative(distDir, fromFile)} :: ${spec}`);
  return null;
}

let changedFiles = 0;
for (const file of files) {
  const isDts = file.endsWith('.d.ts');
  const original = readFileSync(file, 'utf8');
  let next = original;
  // STATIC_FROM and SIDE_EFFECT have THREE capture groups (pre, quote, spec), so
  // the 4th positional arg `String.prototype.replace` passes is `offset` (a
  // number) — never append it. DYNAMIC_IMPORT has a real 4th group (the closing
  // `)` and any whitespace), which must be preserved as `tail`.
  const rewriteNoTail = (re) =>
    next.replace(re, (match, pre, quote, spec) => {
      const resolved = resolveSpecifier(file, spec, isDts);
      return resolved === null ? match : `${pre}${quote}${resolved}${quote}`;
    });
  const rewriteWithTail = (re) =>
    next.replace(re, (match, pre, quote, spec, tail) => {
      const resolved = resolveSpecifier(file, spec, isDts);
      return resolved === null ? match : `${pre}${quote}${resolved}${quote}${tail}`;
    });
  next = rewriteNoTail(STATIC_FROM);
  next = rewriteNoTail(SIDE_EFFECT);
  next = rewriteWithTail(DYNAMIC_IMPORT);
  if (next !== original) {
    writeFileSync(file, next);
    changedFiles += 1;
  }
}

// biome-ignore lint/suspicious/noConsole: intentional build-time progress output
console.log(
  `esm-fix: rewrote relative specifiers in ${changedFiles}/${files.length} file(s) under ${path.relative(process.cwd(), distDir)}`,
);

if (unresolved.size > 0) {
  console.error(
    `esm-fix: ${unresolved.size} relative specifier(s) could not be resolved to a .js or /index.js:`,
  );
  for (const entry of [...unresolved].sort()) {
    console.error(`  - ${entry}`);
  }
  process.exit(1);
}
