// Idempotency helpers — compute the SHA-256 of file bytes, look up an
// existing non-deleted document by (tenant, sha256).

import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { documents } from '../db/schema';
import { type DocumentId, type TenantId, asDocumentId } from '../graph/types';

export function sha256OfBytes(bytes: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

export async function findExistingDocumentByHash(
  db: PostgresJsDatabase | Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0],
  tenantId: TenantId,
  sha256: string,
): Promise<DocumentId | null> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.sha256, sha256),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? asDocumentId(rows[0].id) : null;
}
