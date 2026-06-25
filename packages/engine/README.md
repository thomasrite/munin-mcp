# @muninhq/engine

The **vertical-agnostic** core of Munin.

This package must never reference any vertical/domain-specific concept. All such concepts live in a configuration package under `packages/configurations/<name>`.

If you find yourself wanting to add a vertical/domain concept here, the abstraction is wrong. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Modules

- `src/graph/` — `GraphStore` interface and Postgres adapter. All engine data access goes through this interface.
- `src/ingest/` — document ingestion: chunking, extraction orchestration, provenance recording.
- `src/query/` — semantic search, graph expansion, AI grounding.
- `src/permissions/` — access-tag enforcement primitives. The interface enforces `accessTags` on every read; this module provides the primitives that backends use.
- `src/connectors/` — plugin interface for data source connectors. No implementations live here.
- `src/provenance/` — citation primitives.
- `src/db/` — Drizzle schema and migrations.

## Open core

Part of the **Munin open-core local product**, released under **AGPL-3.0-only** (see
[LICENSE](./LICENSE) and the repository [NOTICE](../../NOTICE)). The hosted / managed
product and the vertical configurations are a **separate, closed** commercial product
and are **not** licensed under the AGPL.
