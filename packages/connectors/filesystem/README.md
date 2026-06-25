# @muninhq/connector-filesystem

Universal connector — reads documents **and source code** from a local directory tree and yields
one `DocumentSource` per file. Vertical-agnostic, engine-tier. The connector decides *which* files
to emit; the ingestion pipeline does the parsing, chunking, and persistence.

Used by:
- `pnpm --filter munin-mcp ingest <dir> --tenant <uuid> --tags <…>` — the CLI ingester (and the
  `munin ingest` wrapper) for local development and the prosumer/codebase wedge
- Phase 5 onboarding flows that ingest a bulk-export folder before live connectors are wired

## Codebase ingestion

Point it at a repo and it indexes **only real source**, not the dependency/build/VCS noise:

- **Extension allowlist.** By default every format the engine can parse — documents
  (`.pdf/.docx/.md/.markdown/.txt`) plus a broad set of source/structured-text extensions
  (`.ts/.tsx/.js/.py/.go/.rs/.java/.rb/.c/.cpp/.cs/.php/.swift/.kt/.scala/.sql/.sh/.yaml/.toml/
  .json/…`, the engine's `CODE_FILE_EXTENSIONS`). Source files are read as plain UTF-8 text.
- **Ignored directories** — never descended into, so a huge tree costs nothing to walk:
  `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `vendor`, `__pycache__`, `.venv`,
  `.next`, `coverage`, `.turbo`, `.gradle`, `.idea`, `.vscode`, … (see `ignore-rules.ts`).
- **Ignored files** — lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`,
  `go.sum`, …), minified/generated bundles and sourcemaps (`*.min.js`, `*.bundle.js`, `*.map`),
  OS cruft (`.DS_Store`), and **secret/key material** (`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`,
  `*.pfx`, `*.jks`, `id_rsa`, `.npmrc`, `.netrc`, `*.tfvars`, `secrets.y*ml`, `credentials.json`,
  `service-account.json`).
- **Size cap** — files larger than 1 MiB are skipped (very likely generated/vendored/data).
- **`.gitignore`** — honoured by default, including nested `.gitignore` files (negation, anchoring,
  directory-only, `*`/`**`). Disable with `respectGitignore: false`.

Each file becomes one document whose **title and `externalId` are the file's path relative to the
scanned root** (POSIX, e.g. `src/query/context-retriever.ts`), so retrieval results and citations
identify which file a chunk came from.

> **Note.** The engine's shared chunker currently collapses internal whitespace, so stored code
> chunks are not yet newline-preserving and carry no line range. Code is fully ingested and
> retrievable; formatting/line-level citations are a flagged engine follow-up.
> Symlinks are not followed (avoids cycles). Files with no extension (e.g. `Dockerfile`,
> `Makefile`) are not yet ingested — they need mime-detection basename support (deferred).
>
> **Residual secret risk.** The default denies cover the common secret/key filenames, but a repo
> can still carry credentials inside ordinary allowlisted formats (e.g. `config.yaml`,
> `appsettings.json`, a `.properties` file). Anything ingested is embedded and — in BYO-key or
> managed mode — sent to the configured provider. For a repo known to hold secrets in config,
> scope ingestion with `allowedExtensions` / `extraIgnoredFileGlobs`, or ingest in fully-local mode.

## Configuration shape

```ts
{
  rootPath: string;                  // absolute path to the directory to scan
  allowedExtensions?: string[];      // override the default allowlist (lowercase, with dot)
  recursive?: boolean;               // default true
  respectGitignore?: boolean;        // default true — honour .gitignore files in the tree
  useDefaultIgnores?: boolean;       // default true — apply the built-in dir/file ignore defaults
  extraIgnoredDirs?: string[];       // additional directory basenames to skip
  extraIgnoredFileGlobs?: string[];  // additional filename globs to skip
  maxFileSizeBytes?: number;         // default 1_048_576 (1 MiB); 0 or negative disables the cap
}
```

The extension allowlist is the primary gate; the ignore rules prune junk that happens to have an
allowed extension (e.g. `app.min.js`). An extension passed explicitly in `allowedExtensions` is
always considered — junk filters only remove lockfiles/minified/oversized/gitignored matches.

## Open core

Part of the **Munin open-core local product**, released under **AGPL-3.0-only** (see
[LICENSE](./LICENSE) and the repository [NOTICE](../../../NOTICE)). The hosted / managed
product and the vertical configurations are a **separate, closed** commercial product
and are **not** licensed under the AGPL.
