# @muninhq/mcp — local MCP server over your Munin memory

A stdio [MCP](https://modelcontextprotocol.io) server that lets your own LLM
client (Claude Desktop, Cursor, anything MCP-capable) retrieve **cited,
permission-filtered context** from a Munin memory. **Your machine, your keys,
your choice of provider** — the server runs as a child process of your client,
opens no network listener, and adds no auth of its own (the OS process
boundary is the trust boundary).

## One-command setup

The server reads its configuration from a per-user **`MUNIN_HOME`** (default
`~/.munin`) — one `munin.env` file plus its `pgdata/` and encrypted `blobs/`.
Nothing is hand-edited in the common case.

```sh
# 0. one-time prerequisites: install Ollama (https://ollama.com), then pull the
#    local models the default config uses:
ollama pull bge-m3
ollama pull qwen2.5:7b

# 1. bootstrap a portable home (~/.munin): munin.env (mode 0600), data dirs, tenant
pnpm --filter munin-mcp munin init

# 2. put documents in, then build the local knowledge graph (both run in-process)
pnpm --filter munin-mcp munin ingest /path/to/your/docs
pnpm --filter munin-mcp munin extract

# 3. wire your AI client — prints the block by default; --write merges it safely
pnpm --filter munin-mcp munin mcp connect --client claude-desktop --write
#    (Cursor: --client cursor; project-local: add --project <dir>)

# 4. confirm it is wired, then restart your client
pnpm --filter munin-mcp munin mcp doctor
```

`munin ingest` / `munin extract` default `--tenant` to the home's tenant and
`--tags` to `personal`, so the common case needs no extra flags. Stop the MCP
server before ingest/extract — the local store is a single-process database.

### Better extraction with a cloud key (optional)

The default config extracts with a small local model, whose graph quality is
model-dependent. For **good extraction** (and, with OpenAI, **fast cloud
embeddings**), point the home at your own provider key in one command:

```sh
# Claude for extraction + answers; embeddings stay local (Ollama bge-m3):
ANTHROPIC_API_KEY=sk-ant-… pnpm --filter munin-mcp munin set-key anthropic
# OpenAI for extraction + answers AND cloud embeddings (re-ingest to re-embed):
OPENAI_API_KEY=sk-… pnpm --filter munin-mcp munin set-key openai
```

`set-key` writes the key to `munin.env` at mode `0600` (never printed), picks
sensible models, and flips the posture from fully-local to
`MUNIN_ALLOW_CLOUD_PROVIDERS=true` (**local store + cloud AI; egress
acknowledged**). Prefer the provider env var over `--key <value>` so the key
stays out of your shell history. Run `munin mcp doctor` afterwards to confirm
the new posture.

### Seeing and managing what's in the memory

```sh
pnpm --filter munin-mcp munin docs            # list documents (newest first)
```

`munin docs` lists the documents in the memory with the ids you can read via
`munin_get_document`. The `munin_status` tool also surfaces the most-recent few
from inside your AI client. To remove a document and everything derived from it
(paragraphs, embeddings, extracted entities/edges, the raw blob), run the CLI:

```sh
pnpm --filter munin-mcp munin forget <documentId> --commit --confirm-title "<title>"
```

`munin forget` is a dry run by default; `--commit --confirm-title` performs the
hard delete in a single transaction and removes the blob, leaving no orphans.

Like ingest/extract, `munin docs` opens the single-process local store, so stop
the MCP server first (or it will report it can't open the database).

### `munin mcp connect`

Prints the `mcpServers` block (and the target path) by **default** — paste it
yourself, or re-run with `--write`. `--write` is safe: it **refuses symlinks
and unparseable configs**, **backs up** the existing file, writes **atomically**,
and **merges** — it sets only `mcpServers.munin` and never touches your other
servers or top-level keys. Re-running is a no-op. The emitted block carries
**no secrets** — only a `MUNIN_HOME` pointer and a hardened `PATH`; the settings
(including the blob key) stay in `munin.env`.

For an **installed** Munin, the emitted block runs the published `munin-mcp` bin
directly (no `pnpm`, no `--dir`, no checkout path):

```json
{
  "mcpServers": {
    "munin": {
      "command": "/Users/you/.nvm/versions/node/v22.22.0/bin/node",
      "args": [
        "/Users/you/project/node_modules/@muninhq/mcp/dist/main.js"
      ],
      "env": {
        "MUNIN_HOME": "/Users/you/.munin",
        "PATH": "/Users/you/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin"
      }
    }
  }
}
```

(From a dev repository checkout the block instead runs `pnpm --dir
<checkout>/packages/mcp --silent start` — same shape, repo launch target.)

**Node-version pinning (the nvm fix).** `connect` pins the **exact Node it is
running under** (Node 22, by construction) and leads `PATH` with that Node's bin
dir. A bare `command: "pnpm"`/`"node"` would let your client resolve the binary —
and under nvm pick up an **old Node (v18)**: the launcher then crashes (`File is
not defined`, undici) and the client just shows "Server disconnected". So **run
`connect` under Node 22** (the repo's pinned version) and the emitted block can't
grab a broken Node. (In the checkout form `--silent` matters too: pnpm's script
banner would otherwise corrupt the stdio JSON-RPC channel.)

## Honest v1 boundaries

- **`connect` emits the installed-bin launcher.** `munin-mcp` ships as a
  **compiled Node bin** (`dist/main.js`, `#!/usr/bin/env node` — no `tsx`, no
  checkout needed to _run_ the server), and the package carries its own engine +
  migrations + WASM-backed PGlite as real dependencies, so an installed
  `munin-mcp` runs standalone. When run from an install, `munin mcp connect`
  resolves that installed bin and emits a `<node> <…>/@muninhq/mcp/dist/main.js`
  launcher (the clean-install acceptance test asserts exactly this — no `--dir`,
  no repo path); from a dev checkout it emits the `pnpm --dir <repo>/packages/mcp`
  form. What remains is the actual npm publish (and then a one-line `npx
  munin-mcp`).
- **Blob encryption is mandatory only under the local/prod posture, and the AES
  key is co-located with the data.** Raw original bytes are encrypted at rest with
  AES-256-GCM, and under `MUNIN_LOCAL_MODE` (and in production) plaintext blob
  storage is **refused** — but a non-local configuration can store plaintext by
  design, so the encryption guarantee is the local/prod posture's, not an
  unconditional one. The AES key lives in the **same `0600 munin.env`** as the
  store, so at-rest encryption protects a **stolen disk** only if that key file is
  separately protected, and is **weakened on a synced/cloud-backed folder**
  (Dropbox / iCloud) where the key travels with the data. Keep `MUNIN_HOME` on
  local disk for the encryption to mean what it says.
- **MCP reads are blob-free, so your memory relocates to _any_ path.** All five
  tools read paragraph text from the database (`pgdata/`), never from blobs — so
  copying/pointing `MUNIN_HOME` keeps reading and chatting at any path. Raw
  **blobs** (original bytes, used only by ingest/erase) still store absolute
  `file://` URIs, so **full blob fidelity — erase / original-byte re-read —
  survives only a same-path move or a re-ingest** until tenant-relative blob
  keys land (a deferred engine change). `munin mcp doctor` and the launcher
  surface this posture.
- **Don't point two engines at one home.** PGlite is single-process: a synced
  home or two clients opening the same `pgdata` risks corruption. Sync/share for
  transport only.

## The five tools

| tool | what it does |
| --- | --- |
| `munin_retrieve_context` | ranked, cited context for a question — the calling LLM synthesises (one embedding call, no server-side answer model) |
| `munin_ask` | full grounded answer with `[n]` citations, or an honest `no_evidence` |
| `munin_gather_entity` | everything about one subject by identity; same-name collisions return candidates + `pick` tokens |
| `munin_get_document` | the full source behind a citation (title + ordered paragraphs) |
| `munin_status` | document/paragraph/entity counts, pending extraction, active tenant + configuration, and a sample of the most-recent documents |

**Verifiable citations.** Every source the retrieval tools return carries a
`sourceId` (e.g. `P11`), and each result includes a short, stable
`citationGuidance` field instructing the calling model to **cite the `sourceId`
inline after each claim** (e.g. "…rooted in doughnut economics [P11].") and to
say so when the sources don't support something. `munin_ask` returns `[n]`
markers mapped to a `citations[]` array (each with `documentId`, `paragraphId`
and the quoted text) and guidance to **preserve those markers** when relaying
the answer. The grounding shows up **in the answer**, not by reading the logs.

## Advanced / dev

- **Hosted-Postgres store (instead of the local PGlite home):** point the server
  at a Postgres connection string and supply the config/tenant directly — set
  `MUNIN_CONFIG_PACKAGE=@muninhq/config-generic-baseline` (or
  `@muninhq/config-personal`) + `MUNIN_TENANT_ID=<id>` + `DATABASE_URL=<conn>` in the
  client `env` block (no `MUNIN_HOME` needed for a hosted store).
- **Inspector:** `npx @modelcontextprotocol/inspector pnpm --filter @muninhq/mcp
  --silent start` (set `MUNIN_HOME` or the config/tenant env first).
- **Without a home:** the launcher fails fast and friendly ("run `munin init`")
  unless you supply `MUNIN_CONFIG_PACKAGE` (and the rest) another way — e.g. the
  hosted demo above.

## Troubleshooting

- **Logs are on stderr** (stdout belongs to JSON-RPC). Claude Desktop:
  `~/Library/Logs/Claude/mcp-server-munin.log`. Verbosity:
  `MUNIN_MCP_LOG_LEVEL=debug`.
- **"No Munin home … run `munin init`"** — the launcher found no `munin.env` at
  `MUNIN_HOME` and no `MUNIN_CONFIG_PACKAGE` in its env. Run `munin init`, then
  `munin mcp connect`.
- **"Multiple tenants exist"** — set `MUNIN_TENANT_ID` (or let `munin init`
  pin one). `munin mcp doctor` shows what resolved.
- **Empty results** — check `munin_status` (pending extraction?) and that the
  embedding provider matches the one the corpus was embedded with.
- **`munin.env` is authoritative** — it is loaded with override-on, so a value
  set only in the client `env` block is intentionally overridden by the home
  file.

## Open core

Part of the **Munin open-core local product**, released under **AGPL-3.0-only**
(see [LICENSE](./LICENSE) and the repository [NOTICE](../../NOTICE)). The hosted /
managed product, team and device-sync features, brokered LLM access, and the
vertical configurations (e.g. MAT / HR) are a **separate, closed** commercial
product and are **not** licensed under the AGPL.
