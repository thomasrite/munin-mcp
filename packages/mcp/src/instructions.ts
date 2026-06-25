// The server-level MCP `instructions` string — assembled as a PURE function of
// the loaded configuration (built like buildToolDescriptions), so it is
// unit-testable and contributes no vertical or persona words of its own: the only
// domain colour is the terminology nouns (records / subjects) the configuration
// supplies.
//
// Why this is the single highest-leverage hook: the SDK sends `instructions` in
// the `initialize` response, so a connected client sees it ONCE at session start,
// before it has chosen any tool. It is the place to bias the client to reach for
// this private memory at all, and to honour the same grounding contract every tool
// relies on — even when the user never names Munin.

import type { Configuration } from '@muninhq/shared';

import { recordsNoun, subjectNouns } from './terminology';

function sentences(...parts: readonly string[]): string {
  return parts.join(' ');
}

export function buildServerInstructions(configuration: Configuration): string {
  const records = recordsNoun(configuration);
  const nouns = subjectNouns(configuration);
  const subjects = nouns.length > 0 ? nouns.join(', ') : 'named subjects';

  return sentences(
    `This server is the user's own private, permissioned Munin memory of ${records} — the documents and notes they have ingested, held under their access and answered with citations back to the source.`,
    `Prefer it for anything about the user's own ${records}, notes, ${subjects}, or anything this memory might hold — even when the user never names Munin, and even when you believe you already know the answer from your own training.`,
    'Reach for munin_ask by default: it returns a server-grounded answer with [n] citations or an honest no_evidence, and is the strongest, hardest-to-bypass grounding path. Use munin_retrieve_context (or munin_gather_entity for one subject) when the material is genuinely private and you will assemble and cite the returned sources yourself.',
    'Honour the grounding contract on every path: answer ONLY from this memory, cite every claim against the source it rests on, NEVER fabricate or supplement from your own training or general knowledge, and surface [not in memory] or no_evidence honestly rather than filling the gap. An uncited or invented claim defeats the entire purpose of this memory.',
  );
}
