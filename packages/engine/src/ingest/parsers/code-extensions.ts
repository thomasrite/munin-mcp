// Source-code / structured-text extension + mime sets — a ZERO-DEPENDENCY leaf.
//
// Why this is its own file (and not just consts inside `code.ts`):
//   `code.ts` pulls in the parser machinery (`parser-types`, the chunker-aware
//   block splitter). A lightweight consumer that only needs the EXTENSION LIST
//   — the filesystem connector, which builds its default ingest allowlist from
//   it — must be able to import the list WITHOUT dragging in the parser, and
//   without going through the full `@muninhq/engine` barrel (providers, query,
//   PGlite, …). Isolating the constant here, with no imports, gives that
//   consumer a tiny, side-effect-free, cycle-proof import target. It also means
//   the value can never be left empty by a re-export-ordering or bundler
//   scope-hoisting hazard on the heavy barrel — the connector imports the
//   declaration directly (see `@muninhq/engine/ingest/extensions`).
//
// Vertical-agnostic: "code" is a universal content type, exactly like plain
// text or markdown. Nothing here knows about any domain.

// The canonical set of source-code / structured-text extensions the engine can
// parse as code. This is the SINGLE SOURCE OF TRUTH: the parser (`code.ts`) and
// the filesystem connector both consume it (connector → engine is the only
// legal dependency direction). Deliberately excludes the prose formats owned by
// the other parsers (.pdf/.docx/.md/.markdown/.txt/.text) and excludes
// secret-bearing files like `.env` (the connector also hard-ignores those).
export const CODE_FILE_EXTENSIONS: readonly string[] = [
  // TypeScript / JavaScript
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Python
  '.py',
  '.pyi',
  '.pyx',
  // Go / Rust / JVM
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.sc',
  '.groovy',
  '.gradle',
  '.clj',
  '.cljs',
  '.cljc',
  '.edn',
  // C / C++ / Objective-C
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.hh',
  '.hxx',
  '.m',
  '.mm',
  // C# / .NET / F#
  '.cs',
  '.fs',
  '.fsx',
  '.fsi',
  '.vb',
  // Other compiled / functional / systems
  '.swift',
  '.dart',
  '.rb',
  '.erb',
  '.rake',
  '.gemspec',
  '.php',
  '.phtml',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.jl',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.hs',
  '.lhs',
  '.ml',
  '.mli',
  '.elm',
  '.purs',
  '.nim',
  '.zig',
  '.v',
  // Shell / scripting
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
  // Query / schema / IDL
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.thrift',
  // Config / data (text-based)
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.xml',
  '.xsd',
  '.xsl',
  '.csv',
  '.tsv',
  // Infrastructure as code (.tfvars excluded — values files routinely hold
  // secrets; the connector also denies *.tfvars by glob)
  '.tf',
  '.hcl',
  '.cmake',
  '.mk',
  '.make',
  '.bazel',
  '.bzl',
  '.sbt',
  // Web / templates / styles
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  // Typesetting source
  '.tex',
  '.bib',
];

// Representative code mime types. Extension is the real selector for the
// filesystem connector (which supplies no mime), but a future connector that
// hands us a typed attachment can still route here. None of these collide with
// the prose parsers (text/plain, text/markdown, application/pdf, the docx mime).
export const CODE_MIME_TYPES: readonly string[] = [
  'text/x-python',
  'text/x-go',
  'text/x-rust',
  'text/x-java-source',
  'text/x-csrc',
  'text/x-c++src',
  'application/x-sh',
  'application/json',
  'application/x-yaml',
  'text/yaml',
];
