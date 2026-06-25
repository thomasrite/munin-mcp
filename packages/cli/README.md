# munin-mcp

The Munin local CLI. Ships the `munin` command — one-command bootstrap, ingest,
extract, status, and MCP-client wiring for the local product.

## Install

```sh
npm install -g munin-mcp @muninhq/mcp
```

## Quickstart

```sh
munin init                       # bootstrap ~/.munin (config + local store + tenant)
munin ingest /path/to/your/docs  # add a folder of documents
munin extract                    # build the local knowledge graph (in-process)
munin status                     # corpus health (no LLM call)
```

`munin init`, `munin status`, ingest and extract open a local **PGlite** store and
run the engine's bundled SQL migrations from the installed package — no repository
checkout and no `tsx` are needed at runtime. The default configuration written by
`munin init` is `@muninhq/config-personal`.

### Wire your AI client

The MCP server is the installed `munin-mcp` bin (from `@muninhq/mcp`). Add it to your
client's MCP config, pointing `MUNIN_HOME` at the home `munin init` created (omit
`MUNIN_HOME` to use the default `~/.munin`). For Claude Desktop —
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "munin": {
      "command": "munin-mcp",
      "env": { "MUNIN_HOME": "/Users/you/.munin" }
    }
  }
}
```

Restart the client, then ask it about your documents. If the client cannot find
`munin-mcp` on its launch PATH, replace `"command": "munin-mcp"` with the absolute
path that `which munin-mcp` prints.

> **Automated wiring.** `munin mcp connect --write` / `munin mcp doctor` write and
> check the block above for you. When Munin is **installed** (global or local),
> connect resolves the published `munin-mcp` bin and emits an installed-bin
> launcher — `<node> <node_modules>/@muninhq/mcp/dist/main.js` — with no `pnpm`, no
> `--dir`, and no checkout path, so it works for an installed user. (From a dev
> repository checkout it instead emits a `pnpm --dir <checkout>/packages/mcp`
> launcher.) The launcher is this-machine-specific, so re-run connect after moving
> the install or the home.

Run `munin --help` for the full command list.

## Open core

Part of the **Munin open-core local product**, released under **AGPL-3.0-only** (see
[LICENSE](./LICENSE) and the repository [NOTICE](../../NOTICE)). The hosted / managed
product, team features, and the vertical configurations (e.g. MAT / HR) are a
**separate, closed** commercial product and are **not** licensed under the AGPL.
