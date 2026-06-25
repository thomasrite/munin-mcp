# @muninhq/config-generic-demo

A configuration for a Projects / Tasks / People domain — used as the Phase 1 acceptance dataset.

This exists for two reasons:

1. It exercises every feature of the configuration schema (entity types, relationship types with multiple from/to types, terminology, roles, tag expansion, query templates with slots and traversal, connector binding).
2. It proves the engine is vertical-agnostic. If the Phase 1 demo runs naturally against this dataset, the engine has not absorbed MAT-specific assumptions.

## Layout

- `src/entities.ts` — Project, Task, Person entity types with few-shot examples
- `src/relationships.ts` — belongsToProject, assignedTo, worksOn, managedBy
- `src/terminology.ts` — UI label map
- `src/roles.ts` — admin, member, guest with base access tags
- `src/queries.ts` — pre-built query templates
- `src/connectors.ts` — filesystem connector binding (per-tenant config schema)
- `src/tag-expansion.ts` — declarative expansion function (identity for the demo)
- `src/index.ts` — composed `Configuration` export

## Open core

Part of the **Munin open-core local product**, released under **AGPL-3.0-only** (see
[LICENSE](./LICENSE) and the repository [NOTICE](../../../NOTICE)). The hosted / managed
product and the vertical configurations are a **separate, closed** commercial product
and are **not** licensed under the AGPL.
