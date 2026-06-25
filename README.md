# Munin

**A private memory for your AI.** Point Munin at your documents and your AI assistant —
Claude, Cursor, anything that speaks MCP — gives you grounded, cited answers from *your*
files. You build your memory on your own machine, with your own model.

[ AGPL-3.0 ] · [ npm: munin-mcp ] · [ Node ≥ 20 ]

<!-- demo.gif: drop a folder → ask Claude → cited answer -->

## Why Munin?

LLMs are brilliant, but they don't know *your* world — your notes, contracts, codebase,
research. Munin fixes that **without uploading your files to a service we run**:

- 🔒 **Local-first.** You build your memory on your machine. With a local model (Ollama),
  building it makes **no network calls at all** — there's a structural zero-egress mode.
- 📎 **Grounded & cited.** Answers are backed by the actual source paragraph. If your files
  don't cover something, Munin's server-grounded answer says so — it won't make it up.
- 🧠 **Your model, your choice.** A free local model, or bring your own OpenAI/Anthropic
  key. Munin never locks you to one provider.
- 🔌 **Plugs into your AI client.** Munin is an MCP server — wire it into Claude Desktop or
  Cursor and your assistant becomes the interface.
- 🛡️ **Read-only to the AI, permission-aware by design.** Your assistant can *read* your
  memory but cannot change or delete it — the foundation for safe team and company use.

## Privacy & security — the honest version

Munin is built so your files can stay on your machine. There are **two** separate places an
AI model is used, with different privacy implications — be clear about both:

**1. Building your memory (extraction + embeddings) — Munin controls this.**
- **Fully local (recommended for sensitive files):** with the Ollama models Munin defaults
  to — **`qwen2.5:7b`** (extraction) and **`bge-m3`** (embeddings) — building your memory
  makes **no network calls**. Set `MUNIN_LOCAL_MODE=true` and this is enforced structurally:
  Munin refuses any non-local provider and requires the Ollama endpoint to be loopback.
  Honest caveat: a 7B local model extracts a **modest** graph — embedding search still works
  well, but richer entity/relationship extraction is where a bigger or cloud model helps.
- **Bring-your-own cloud key (better extraction):** `munin set-key anthropic` /
  `munin set-key openai` sends your document text to **your chosen provider under your own
  key** — never to us — and switches off local-only mode and tells you so. A real trade-off,
  made explicitly by you.

**2. Answering your questions — your AI client controls this.** Your answers come from
whatever model your AI client runs. If that's cloud Claude (Claude Desktop) or a cloud model
in Cursor, then when you ask, Munin returns the **matched snippets from your files** to that
client to write the answer — so **those snippets and your question reach your client's
provider, even if you built your memory 100% locally.** This is unavoidable with a cloud
assistant. For an end-to-end private setup, point your MCP client at a local model too.

**Provider data handling.** OpenAI and Anthropic state that data sent via their **APIs is not
used to train their models by default** and is retained only briefly. Retention windows
change, so check the providers' current terms directly rather than trusting a day-count. Your
BYO-key use is governed by **your** agreement with that provider, not us.

**Storage.** Documents and the extracted graph live in a local Postgres-in-WASM store under
`MUNIN_HOME` (default `~/.munin`). Raw document bytes are encrypted at rest with
**AES-256-GCM**; local mode refuses plaintext blobs. Caveat: the encryption key lives in the
same `0600` `munin.env` as the data, so at-rest encryption protects a stolen disk only if that
key file is protected too — keep `MUNIN_HOME` on local disk, not a synced folder
(Dropbox/iCloud) where the key travels with the data. The database index itself (text,
vectors, access tags) is plaintext on disk — use full-disk encryption for stronger protection.

**No Munin server.** The free CLI and MCP server have no Munin-hosted backend — there is
nothing to phone home to.

## Install

Requires **Node 20+**. If you use nvm, run `munin` under a recent Node (the project pins
Node 22) — a stale Node 18 on your PATH can make the wired MCP server fail to start.

```bash
# installs the `munin` CLI and the MCP server it wires up:
npm install -g munin-mcp
```

## Quickstart

One guided command does everything:

```bash
munin setup
```

It walks you through the whole setup: provisioning your local store, choosing your model,
adding files, connecting your AI client, and verifying it works. If you choose the **local**
model, make sure [Ollama](https://ollama.com) is installed and you've pulled its two models
once: `ollama pull qwen2.5:7b && ollama pull bge-m3`.

Restart your AI client, then ask it something about your documents.

## Two things you do — and who does them

There's a clean split, and it matters for privacy and safety:

- **You ASK your AI client.** Once wired up, your assistant reads your memory over MCP and
  answers with citations. Munin's MCP server is **read-only by design** — your AI can search
  and quote your memory, but it **cannot add, change, or delete** anything in it.
- **You MANAGE your memory yourself, in the terminal.** Adding and removing documents is
  always an explicit command you run. The local store is single-process, so **quit your AI
  client first** or these commands will report they can't open the database.

| You run | What it does |
|---|---|
| `munin add` | Pick a folder with the native macOS picker and add it (off macOS, use `munin ingest`) |
| `munin ingest <path>` | Add a folder or file by path (cross-platform) |
| `munin extract` | Build the knowledge graph from what you've added |
| `munin status` | See what's in your memory (no AI call) |
| `munin docs` | List documents with the ids `forget` takes |
| `munin forget <id> --commit --confirm-title "<exact title>"` | Remove a document and everything derived from it. **Dry-run by default** — run without `--commit` to preview; the real delete is irreversible and needs both `--commit` and the exact title (from `munin docs`) |
| `munin mcp doctor` | Check your setup is healthy |

Adding files is two steps: `munin ingest`/`munin add` stores the passages, then
`munin extract` builds the graph your AI reads. After that, restart your AI client.

## Choosing your model

In `munin setup`, or anytime with `munin set-key`:

- **Local (Ollama)** — free, fully private. One-time setup: install Ollama, then
  `ollama pull qwen2.5:7b` (extraction) and `ollama pull bge-m3` (embeddings). Best for
  sensitive files; a 7B model extracts a modest graph (search works well; richer extraction
  wants a larger or cloud model).
- **OpenAI / Anthropic** — `munin set-key anthropic` / `munin set-key openai` for
  higher-quality extraction; sends document text to that provider under your key and switches
  off local-only mode (Munin tells you).

Your *answers* come from your AI client's model; the model picked here builds and searches
your memory.

## How it works

Munin reads your files, splits them into passages, and stores them locally (Postgres-in-WASM
+ encrypted blobs). When you ask your AI client a question, it calls Munin over MCP; Munin
returns the most relevant, permission-filtered, **cited** passages; your AI answers from
*those* — not from guesswork.

## What it's not (yet).

- It's a **CLI + MCP server** — there's no graphical app yet; your AI client is the UI. A
  visual "see your knowledge" hub is on the roadmap.
- **Managing memory needs the AI client closed.** The local store is single-process — quit
  your AI client before `munin ingest`, `munin extract`, `munin forget`, or `munin status`,
  or the command reports it can't open the database.
- **Adding files is two steps.** `munin ingest`/`munin add` stores the passages; run
  `munin extract` to build the entity/relationship graph the AI reads.
- The **folder picker** is macOS-first; on Linux/Windows use `munin ingest <path>`.
- Supported formats are PDF, DOCX, Markdown, and plain text (no OCR — scanned images won't
  extract text).

## Open-core & license

Munin's local **engine, CLI, and MCP server are open-source under AGPL-3.0** — free to use
and self-host forever. A hosted, multi-user version (teams, sync, the company shared brain)
is a separate commercial product. See [NOTICE](./NOTICE).

## Contributing

Issues and PRs welcome. By contributing you agree your work is licensed under AGPL-3.0.
