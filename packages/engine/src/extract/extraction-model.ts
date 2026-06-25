// EXTRACTION_MODEL — the generic env knob that selects the extraction model
// independently of the answer model (which the query pipeline reads from
// ANSWER_MODEL).
//
// This is a deliberately model-agnostic string knob: the engine bakes in NO
// model id and NO vertical concept. UNSET resolves to `undefined`, which every
// extract entry point passes straight through so the Extractor falls back to
// the provider's own defaultModel — leaving the fully-local Ollama path (one
// model only) completely unaffected. Cloud/BYO deployments set it (e.g. to a
// cheap-but-accurate model for bulk extraction) via env; the split is config,
// not engine policy.
//
// Read at the composition boundary, mirroring how the cache tier
// (EXTRACTION_CACHE_TIER) and the answer model (ANSWER_MODEL) are read.

/**
 * Resolve the configured extraction model id from the environment.
 *
 * @param env - environment to read (defaults to `process.env`; injected in tests).
 * @returns the trimmed `EXTRACTION_MODEL` value, or `undefined` when it is
 *   unset, empty, or whitespace-only (→ provider default, unchanged behaviour).
 */
export function resolveExtractionModelId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.EXTRACTION_MODEL?.trim() || undefined;
}
