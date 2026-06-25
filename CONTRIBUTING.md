# Contributing to Munin

Thanks for your interest in Munin's open core — the local, private memory layer
for your AI.

## Ground rules

- **License.** This repository is **AGPL-3.0-only**. By contributing you agree
  your work is licensed under AGPL-3.0.
- **Scope.** This repo is the *local* product: the engine, the CLI (`munin`), the
  MCP server, and the generic configuration packages. The hosted/managed product
  and the vertical configurations live elsewhere and are out of scope here.
- **Engine is vertical-agnostic.** The engine (`packages/engine`) and shared
  layer (`packages/shared`) must never embed a domain-specific concept. Generic
  concepts only: Entity, Edge, Document, Paragraph, access tags, provenance,
  connectors, query, tenants. Domain vocabulary belongs in a configuration
  package, never in the engine.
- **Permissions are non-negotiable.** Every `GraphStore` read takes `accessTags`;
  every write records provenance. There are no "admin override" escape hatches at
  the interface level.

## Development

```bash
pnpm install          # install the workspace
pnpm build            # build all packages
pnpm typecheck        # tsc across the workspace
pnpm test             # unit + integration tests (integration needs Docker)
pnpm lint             # Biome
```

The clean-install acceptance test proves the public packages install and run with
no checkout:

```bash
pnpm acceptance:clean-install
```

## Pull requests

- Keep commits small and focused; use [Conventional Commits](https://www.conventionalcommits.org/).
- `tsc` must be clean and the relevant tests green before you push.
- New behaviour ships with tests in the same change.

Issues and PRs welcome.
