# @muninhq/config-personal — the personal-knowledge configuration

The prosumer default configuration (`local:init` → ingest → extract → MCP):
a conservative entity/relationship schema tuned for **personal prose** —
meeting notes, journal entries, reading notes, project logs — with one
all-access `owner` role and a single `private` sensitivity class.

## Shape

| piece | choice | why |
| --- | --- | --- |
| Entity types | `Person` / `Project` / `Topic` / `Source` | precision over coverage; four types cover what personal notes actually contain |
| Relationships | `worksOn` (Person→Project) · `about` (Source\|Project→Topic) · `authoredBy` (Source→Person) | `fromTypes`/`toTypes` make wrong edges unrepresentable |
| Roles | one `owner` with `baseTags: ['personal']` + both capabilities | a personal memory has exactly one human |
| Sensitivity | one `private` class, tag `personal`, default | nothing to widen access to |
| Tag expansion | flat identity | no hierarchy |

**Alignment invariant:** the owner role's base tags include `personal` — the
exact tag `local:init` prints in its suggested ingest command — so the MCP
server's union-of-baseTags read context sees everything that command writes.
A cross-check test in `munin-mcp` (`local-init-config-alignment.test.ts`)
asserts this, so the two can never drift.

## Few-shot discipline

Few-shots are the quality lever. They are authored from fictional personal
prose **disjoint from the eval corpus**, and each over-extraction-prone type
carries an "extract nothing" example on realistic chatty prose — restraint is
taught, not hoped for. Two personal-prose facts the examples encode:

1. People appear as **first names only**; the name as written is the identity.
2. The writer narrates in first person — "I", "my sister", "the plumber"
   are never entities.

Relationship examples live **inside entity few-shots**: the extraction prompt
renders entity few-shots only, so an example on a relationship type would
never reach the model.

## Eval

`src/eval/` ships a 9-document synthetic corpus (entirely invented content),
a hand-authored ground-truth manifest, and a pure scorer. The live runs are
providers-gated suites in `munin-mcp` (`personal-eval.providers.test.ts`):
a cloud leg (Haiku) and a local leg (Ollama, qwen2.5:7b). Numbers and known
limits: [EVAL-FINDINGS.md](./EVAL-FINDINGS.md).

## Connector seam (future work — deliberately not here)

Markdown knowledge-base tools have quirks this configuration does **not**
handle: `[[wikilinks]]`, YAML frontmatter, embedded queries, tag syntax.
Those belong to a future **connector** that normalises such files before
ingestion (the connector tier — `packages/connectors/*`), not to this
configuration package. This package assumes plain prose paragraphs, which is
what the engine's ingestion pipeline produces today.

## Open core

Part of the **Munin open-core local product**, released under **AGPL-3.0-only** (see
[LICENSE](./LICENSE) and the repository [NOTICE](../../../NOTICE)). The hosted / managed
product and the vertical configurations are a **separate, closed** commercial product
and are **not** licensed under the AGPL.
