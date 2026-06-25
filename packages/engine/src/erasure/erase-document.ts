// eraseDocument — the public right-to-erasure entry point (P6b).
//
// The SINGLE orchestration the web (and any future API/connector) shares, so
// honest erasure is implemented once. INVARIANT 2 (honest erasure): the DB
// transaction commits FIRST — hardDeleteDocument removes every derived row + the
// in-tx audit/bypass records, so the document is atomically unreachable — and
// ONLY THEN is the raw blob deleted and VERIFIED gone. The content-free receipt
// reports the truth: `blobDeleted`/`fullyErased` are true only when exists()
// confirms the blob is gone. If the blob delete or verify fails, the receipt
// says NOT fully erased (flagged for retry), a warning is logged, and a
// persistent incomplete-erasure audit row is written. We never claim full
// erasure while content remains.

import type { BlobStorage } from '../blob/blob-storage';
import type { GraphStore } from '../graph/graph-store';
import type { DocumentId, HardDeleteReceipt, WriteContext } from '../graph/types';

// The content-free erasure receipt — the DPO record. Extends the DB receipt
// (ids + counts + blobUri) with the verified blob outcome. No document content.
export interface ErasureReceipt extends HardDeleteReceipt {
  // True ONLY when the blob delete succeeded AND exists() confirmed it is gone.
  readonly blobDeleted: boolean;
  // True iff the document's rows were erased (always, here — the DB tx committed)
  // AND the blob is verified gone. False ⇒ incomplete erasure, flagged for retry.
  readonly fullyErased: boolean;
  // Present when the blob delete/verify did not confirm removal.
  readonly blobError?: string;
}

// The store surface eraseDocument needs (narrowed for testability + to make the
// dependency explicit). A full GraphStore satisfies it.
export type ErasureStore = Pick<GraphStore, 'hardDeleteDocument' | 'recordIncompleteErasure'>;

export interface EraseDocumentDeps {
  readonly store: ErasureStore;
  readonly blobStorage: BlobStorage;
}

export async function eraseDocument(
  deps: EraseDocumentDeps,
  ctx: WriteContext,
  documentId: DocumentId,
): Promise<ErasureReceipt> {
  // 1. DB erasure COMMITS FIRST — the document + everything derived from it is
  //    atomically unreachable, with the in-tx audit + bypass records written.
  const receipt = await deps.store.hardDeleteDocument(ctx, documentId);

  // 2. THEN delete the blob and VERIFY it is gone. We only ever claim blobDeleted
  //    when exists() confirms removal — a successful delete() call is not enough.
  let blobDeleted = false;
  let blobError: string | undefined;
  try {
    await deps.blobStorage.delete(receipt.blobUri);
    const stillThere = await deps.blobStorage.exists(receipt.blobUri);
    blobDeleted = !stillThere;
    if (stillThere) blobError = 'blob still present after delete';
  } catch (err) {
    blobError = err instanceof Error ? err.message : String(err);
  }

  // 3. Never claim full erasure while the blob remains. On failure: warn + a
  //    persistent incomplete-erasure audit row (flagged for retry). The DB
  //    erasure already committed, so a failed follow-up audit must NOT mask the
  //    receipt the caller needs — log it and return the honest receipt anyway.
  if (!blobDeleted) {
    console.warn(
      `[erasure] document ${documentId} rows erased but blob not confirmed gone (${blobError}); flagged for retry`,
    );
    try {
      await deps.store.recordIncompleteErasure(ctx, {
        documentId,
        reason: blobError ?? 'blob not confirmed gone',
      });
    } catch (auditErr) {
      console.warn(
        `[erasure] failed to record incomplete-erasure audit for ${documentId}: ${
          auditErr instanceof Error ? auditErr.message : String(auditErr)
        }`,
      );
    }
  }

  return {
    ...receipt,
    blobDeleted,
    fullyErased: blobDeleted,
    // Only set blobError when present (exactOptionalPropertyTypes).
    ...(blobError !== undefined ? { blobError } : {}),
  };
}
