// `munin forget <documentId>` — the FIRST model-free CLI erasure (Stage B).
//
// DRY-RUN BY DEFAULT, AND THE DRY RUN IS THE SAFETY. The engine's eraseDocument
// is HARD-COMMIT-FIRST: it has no soft-delete, no undo and no dry-run of its own
// (INVARIANT 2 — the DB transaction commits before the blob is even touched). So
// the default path here DELIBERATELY does NOT call it. Instead it READ-ONLY
// previews what an erase would remove — the document identity (so the user can
// confirm it is the RIGHT document) plus the derived rows we can count through
// the FROZEN reader surface — and prints exactly what would go.
//
// Only an explicit `--commit` AND a typed-title confirmation (`--confirm-title
// "<exact title>"`) reach eraseDocument. When they do, the erase is hard, atomic
// and IRREVERSIBLE — we never weaken INVARIANT 2; the dry run is the only safety.
//
// Reads go through the FROZEN GraphStore reader under a normal, fail-closed
// RegularReadContext (the single-user union of role baseTags, mirroring
// `munin docs` / the MCP server) — never raw SQL, never a bypass. The whole
// operation is attributed to the `cli:forget` actor so the per-read audit and
// the in-tx erasure audit name it honestly.

import {
  type BlobStorage,
  type DocumentId,
  type ErasureReceipt,
  type GraphStore,
  type GraphStoreReader,
  type ParagraphId,
  type RegularReadContext,
  type TenantId,
  type WriteContext,
  asActorId,
  asDocumentId,
  asTenantId,
  eraseDocument,
  loadBlobStorageFromEnv,
  loadConfigurationWithResolver,
} from '@muninhq/engine';
import { loadGraphStore } from '@muninhq/engine/graph-store';
import type { Configuration } from '@muninhq/shared';

import { preflightLocalStoreLock } from './local-store-errors';
import { singleUserBaseTags } from './munin-docs';

// Every read and the erase write are attributed to this actor (not the broader
// `cli:local-user` the listing uses) so a "forget" stands out in the audit trail.
export const FORGET_ACTOR = 'cli:forget';

/** Build the single-user RegularReadContext used for the preview reads AND as
 * the base for the erase WriteContext: union of role baseTags expanded through
 * the configuration's tagExpansion, actor pinned to `cli:forget`. Mirrors
 * munin-docs.ts's buildLocalReadContext (kept separate only for the actor). */
export async function buildForgetReadContext(
  configuration: Configuration,
  tenantId: TenantId,
): Promise<RegularReadContext> {
  const baseTags = singleUserBaseTags(configuration);
  const accessTags = await Promise.resolve(
    configuration.tagExpansion(baseTags, { tenantId, orgUnits: [] }),
  );
  return {
    kind: 'regular',
    tenantId,
    accessTags: [...new Set(accessTags)],
    actor: asActorId(FORGET_ACTOR),
  };
}

/** A content-free preview of what an erase would remove. Identity + the rows we
 * can count through the frozen readers — NO document content. */
export interface ForgetPreview {
  readonly documentId: string;
  readonly title: string;
  /** The source path / externalId, when the document came from a connector. */
  readonly path: string | null;
  readonly blobUri: string;
  readonly accessTags: readonly string[];
  /** A superseded (older) version — flagged so the user does not erase the wrong one. */
  readonly superseded: boolean;
  readonly ingestedAt: Date;
  /** Exact — read through findParagraphsByDocument. */
  readonly paragraphCount: number;
  /**
   * Best-effort — the entities whose provenance points at THIS document's
   * paragraphs (findEntitiesByParagraphIds). The cascade also removes the
   * paragraph + entity embeddings, the edges between those entities, citation
   * events and duplicate links derived from the document, but those are not
   * directly countable through the reader surface without the erase transaction
   * — formatForgetPreview says so honestly.
   */
  readonly entityCount: number;
}

/**
 * READ-ONLY preview of an erase: resolve the document and count the derived
 * rows we can see through the frozen readers. Returns null when the document
 * does not exist or the caller cannot see it (nothing to erase). Pure over the
 * reader — unit-tested.
 */
export async function previewErase(
  reader: GraphStoreReader,
  ctx: RegularReadContext,
  documentId: DocumentId,
): Promise<ForgetPreview | null> {
  const doc = await reader.getDocument(ctx, documentId);
  if (!doc) return null;
  const paragraphs = await reader.findParagraphsByDocument(ctx, documentId);
  const paragraphIds = paragraphs.map((p) => p.id as ParagraphId);
  const entities =
    paragraphIds.length > 0 ? await reader.findEntitiesByParagraphIds(ctx, paragraphIds) : [];
  return {
    documentId: doc.id,
    title: doc.title,
    path: doc.externalId,
    blobUri: doc.blobStorageUri,
    accessTags: doc.accessTags,
    superseded: doc.validTo !== null,
    ingestedAt: doc.createdAt,
    paragraphCount: paragraphs.length,
    entityCount: entities.length,
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Render the dry-run preview (pure — unit-tested). Honest about what is exactly
 * counted vs cascade-removed, and how to actually commit. */
export function formatForgetPreview(p: ForgetPreview): string {
  const tags = p.accessTags.length > 0 ? p.accessTags.join(', ') : '(none)';
  const flag = p.superseded ? '  [superseded version]' : '';
  const lines = [
    `would erase: "${p.title}" (${p.documentId})${flag}`,
    `  source:      ${p.path ?? '(no source path)'}`,
    `  ingested:    ${isoDay(p.ingestedAt)}    tags: ${tags}`,
    `  paragraphs:  ${p.paragraphCount} (exact)`,
    `  entities:    ${p.entityCount} (best-effort — derived from this document's paragraphs)`,
    '  + embeddings, edges, citation events and duplicate links derived from it',
    '    (their exact cascade counts are shown only on --commit; they need the erase transaction)',
    `  + the stored blob at ${p.blobUri}`,
    '',
    'This is a DRY RUN — nothing was deleted.',
    'To erase for real (HARD, atomic, IRREVERSIBLE — there is no undo), re-run with:',
    `  munin forget ${p.documentId} --commit --confirm-title "${p.title}"`,
  ];
  return lines.join('\n');
}

/** Render the post-commit erasure receipt (pure — unit-tested). The receipt is
 * content-free: counts + the blob outcome, never document text. */
export function formatForgetReceipt(receipt: ErasureReceipt, title: string): string {
  const c = receipt.deletedCounts;
  const blobLine = receipt.blobDeleted
    ? 'deleted (verified gone)'
    : `NOT confirmed gone — flagged for retry${receipt.blobError ? ` (${receipt.blobError})` : ''}`;
  const lines = [
    `Erased "${title}" (${receipt.documentId}):`,
    `  paragraphs:      ${c.paragraphs}`,
    `  embeddings:      ${c.embeddings}`,
    `  entities:        ${c.entities}`,
    `  edges:           ${c.edges}`,
    `  citation events: ${c.citationEvents}`,
    `  duplicate links: ${c.duplicates}`,
    `  review items:    ${c.reviewItems}`,
    `  blob:            ${blobLine}`,
    '',
    receipt.fullyErased
      ? 'Document fully erased — its rows and the blob are gone.'
      : 'Document rows erased, but the blob is NOT confirmed gone — flagged for retry.',
  ];
  return lines.join('\n');
}

/**
 * Parse `munin forget` arguments: the first bare token is the document id; the
 * value of value-bearing flags (`--tenant`/`-t`/`--home`/`--confirm-title`) is
 * never mistaken for it. `--commit` and `--confirm-title <title>` drive the
 * irreversible path. Pure — unit-tested.
 */
export function parseForgetArgs(argv: readonly string[]): {
  documentId?: string;
  commit: boolean;
  confirmTitle?: string;
} {
  let documentId: string | undefined;
  let commit = false;
  let confirmTitle: string | undefined;
  const valueFlags = new Set(['--tenant', '-t', '--home']);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === '--commit') {
      commit = true;
      continue;
    }
    if (tok === '--confirm-title') {
      confirmTitle = argv[++i]; // take the next token verbatim (titles may start with '-')
      continue;
    }
    if (valueFlags.has(tok)) {
      i++; // skip the flag's value too
      continue;
    }
    if (tok.startsWith('-')) continue; // any other flag — ignore
    if (documentId === undefined) documentId = tok;
  }
  return {
    commit,
    ...(documentId !== undefined ? { documentId } : {}),
    ...(confirmTitle !== undefined ? { confirmTitle } : {}),
  };
}

export interface ForgetOptions {
  readonly documentId: string;
  readonly commit: boolean;
  readonly confirmTitle?: string;
  readonly configPackage: string;
  readonly tenantId: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type ForgetOutcome =
  | 'previewed'
  | 'erased'
  | 'not-found'
  | 'confirm-required'
  | 'confirm-mismatch';

export interface ForgetResult {
  readonly outcome: ForgetOutcome;
  readonly exitCode: number;
}

/** Seams so runForget is unit-testable without a real store/blob/engine call. */
export interface ForgetDeps {
  readonly openStore: (
    env: NodeJS.ProcessEnv,
  ) => Promise<{ store: GraphStore; close: () => Promise<void> }>;
  readonly loadBlobStorage: (env: NodeJS.ProcessEnv) => BlobStorage;
  readonly loadConfiguration: (configPackage: string) => Promise<Configuration>;
  readonly erase: (
    deps: { store: GraphStore; blobStorage: BlobStorage },
    ctx: WriteContext,
    documentId: DocumentId,
  ) => Promise<ErasureReceipt>;
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

export const defaultForgetDeps: ForgetDeps = {
  openStore: (env) => loadGraphStore(env),
  loadBlobStorage: () => loadBlobStorageFromEnv(),
  loadConfiguration: (configPackage) =>
    loadConfigurationWithResolver(configPackage, (p) => import(p)),
  erase: eraseDocument,
  log: (line) => console.log(line),
  logError: (line) => console.error(line),
};

/**
 * Orchestrate a `munin forget`: pre-flight the local-store lock, open the store,
 * preview the erase, and — only with `--commit` + a matching `--confirm-title` —
 * call the engine's eraseDocument. The dry run is the safety; the commit is hard
 * and irreversible.
 */
export async function runForget(
  opts: ForgetOptions,
  deps: ForgetDeps = defaultForgetDeps,
): Promise<ForgetResult> {
  const env = opts.env ?? process.env;
  // Refuse up front if the user's AI client is holding the single-process PGlite
  // store (throws LocalStoreLockedError → friendly line via reportLocalStoreError).
  // No-op for the Postgres path. We must not race the MCP for a write.
  preflightLocalStoreLock(env);

  const tenantId = asTenantId(opts.tenantId);
  const documentId = asDocumentId(opts.documentId);
  const handle = await deps.openStore(env);
  try {
    const configuration = await deps.loadConfiguration(opts.configPackage);
    const ctx = await buildForgetReadContext(configuration, tenantId);

    const preview = await previewErase(handle.store, ctx, documentId);
    if (!preview) {
      deps.logError(
        `No document ${opts.documentId} in this workspace (or you cannot see it) — nothing to erase.`,
      );
      return { outcome: 'not-found', exitCode: 1 };
    }

    // Default path: dry run. Never reaches eraseDocument.
    if (!opts.commit) {
      deps.log(formatForgetPreview(preview));
      return { outcome: 'previewed', exitCode: 0 };
    }

    // Commit path: require a typed-title confirmation. Show the preview first so
    // the user sees what they are about to lose, then name the exact title to type.
    if (opts.confirmTitle === undefined) {
      deps.log(formatForgetPreview(preview));
      deps.logError(
        `Refusing to erase without confirmation. Re-run with --confirm-title "${preview.title}" to proceed.`,
      );
      return { outcome: 'confirm-required', exitCode: 1 };
    }
    if (opts.confirmTitle !== preview.title) {
      deps.logError(
        [
          'Confirmation title does not match the document title — nothing erased.',
          `  expected: "${preview.title}"`,
          `  got:      "${opts.confirmTitle}"`,
        ].join('\n'),
      );
      return { outcome: 'confirm-mismatch', exitCode: 1 };
    }

    // Confirmed. INVARIANT 2: hard, atomic, irreversible. No undo.
    const writeCtx: WriteContext = { tenantId, actor: asActorId(FORGET_ACTOR) };
    const receipt = await deps.erase(
      { store: handle.store, blobStorage: deps.loadBlobStorage(env) },
      writeCtx,
      documentId,
    );
    deps.log(formatForgetReceipt(receipt, preview.title));
    // A receipt that did not fully erase (blob not confirmed gone) exits non-zero
    // so a script can detect the flagged-for-retry case.
    return { outcome: 'erased', exitCode: receipt.fullyErased ? 0 : 1 };
  } finally {
    await handle.close();
  }
}
