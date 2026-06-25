// Per-read audit writes (F10/F26) — the batched, fail-open writer behind
// AuditedGraphStore.
//
// THE INVERSE OF PERMISSION FAIL-CLOSED, deliberately: reads are already
// permission-filtered before they reach this writer, so the audit row is
// ACCOUNTABILITY, not enforcement. An audit write must therefore never block,
// slow-path, or fail the read it describes — on writer error or buffer
// overflow we DROP the event, count the drop visibly (`dropped`), and emit one
// rate-limited warning. Buffer loss on a hard crash (kill -9 mid-window) is
// accepted and documented: the DPIA cares about access
// patterns, not crash-window perfection.
//
// Batched + async: events buffer in memory (bounded), flushed on an interval,
// on a size threshold, and on close(). Flushes are SERIALISED on one promise
// chain — required on PGlite (a single in-process connection) and keeps the
// trail append-ordered on a pool. Rows are CONTENT-FREE by construction: the
// event shape carries identifiers, tags, and a result count — never paragraph/
// entity values, never query text or vectors.
//
// Enablement is the caller's wiring decision via MUNIN_READ_AUDIT (default ON
// — see readAuditEnabled). Local/free-tier users may turn it off (their
// machine, their call); managed/BYO pilot deployments run with it on.

import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { auditEvents } from '../db/schema';
import type { ActorId, TenantId } from './types';

// Either supported Drizzle driver — same widening as PostgresGraphStore. The
// PGlite import is TYPE-only, so the WASM bundle never enters a static import
// graph through this module.
export type ReadAuditDb = PostgresJsDatabase | PgliteDatabase;

// One content-free read event. `resultCount` is the ONLY detail recorded; its
// meaning is per-method (rows returned for list reads, 0/1 for single gets,
// the count value for count reads, entities+edges for getNeighbours) — always
// a magnitude, never content.
export interface ReadAuditEvent {
  readonly tenantId: TenantId;
  readonly actor: ActorId;
  // 'read.<GraphStoreReader method name>'.
  readonly action: string;
  readonly targetKind: string;
  // The method's natural single target (a uuid), where one exists; else null.
  readonly targetId: string | null;
  readonly accessTagsUsed: readonly string[];
  readonly resultCount: number;
  readonly occurredAt: Date;
}

// What AuditedGraphStore depends on — narrow so tests can substitute a
// recording sink without a database.
export interface ReadAuditSink {
  record(event: ReadAuditEvent): void;
}

export interface BatchedReadAuditWriterOptions {
  // Hard cap on buffered events; events beyond it are dropped (counted).
  readonly maxBuffer?: number;
  // Buffer size that triggers an immediate (still async) flush.
  readonly flushAtCount?: number;
  // Interval flush period.
  readonly flushIntervalMs?: number;
  // Minimum gap between drop warnings.
  readonly warnIntervalMs?: number;
}

const DEFAULT_MAX_BUFFER = 500;
const DEFAULT_FLUSH_AT_COUNT = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_WARN_INTERVAL_MS = 60_000;

export class BatchedReadAuditWriter implements ReadAuditSink {
  // Typed against one concrete driver shape, same convention (and rationale) as
  // PostgresGraphStore: both drivers expose the identical Drizzle insert API.
  private readonly db: PostgresJsDatabase;
  private readonly maxBuffer: number;
  private readonly flushAtCount: number;
  private readonly warnIntervalMs: number;
  private readonly timer: NodeJS.Timeout;
  private buffer: ReadAuditEvent[] = [];
  // Serialises flushes: one in flight at a time, in order.
  private chain: Promise<void> = Promise.resolve();
  private droppedTotal = 0;
  private lastWarnAt = 0;
  private closed = false;

  constructor(db: ReadAuditDb, options: BatchedReadAuditWriterOptions = {}) {
    this.db = db as PostgresJsDatabase;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    // Clamped to maxBuffer: a threshold above the cap would never size-flush
    // and silently drop everything past the cap between interval ticks.
    this.flushAtCount = Math.min(options.flushAtCount ?? DEFAULT_FLUSH_AT_COUNT, this.maxBuffer);
    this.warnIntervalMs = options.warnIntervalMs ?? DEFAULT_WARN_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.flush();
    }, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    // Never hold the process open for the audit timer (CLI runs must exit).
    this.timer.unref?.();
  }

  // Visible drop counter — the honesty mechanism for fail-open.
  get dropped(): number {
    return this.droppedTotal;
  }

  record(event: ReadAuditEvent): void {
    if (this.closed || this.buffer.length >= this.maxBuffer) {
      this.drop(1, this.closed ? 'writer closed' : 'buffer overflow');
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.flushAtCount) void this.flush();
  }

  // Queue a flush of everything buffered so far. Never rejects — the trailing
  // catch makes that true by construction (a rejection would poison the chain
  // permanently and turn record()'s fire-and-forget flush into an unhandled
  // rejection), not by discipline inside flushNow alone.
  flush(): Promise<void> {
    this.chain = this.chain
      .then(() => this.flushNow())
      .catch(() => {
        this.drop(0, 'flush chain error');
      });
    return this.chain;
  }

  // Final flush + stop the timer. Safe to call more than once.
  async close(): Promise<void> {
    clearInterval(this.timer);
    const finalFlush = this.flush();
    this.closed = true;
    await finalFlush;
  }

  private async flushNow(): Promise<void> {
    const batch = this.buffer;
    if (batch.length === 0) return;
    this.buffer = [];
    try {
      await this.db.insert(auditEvents).values(
        batch.map((e) => ({
          id: crypto.randomUUID(),
          tenantId: e.tenantId,
          actor: e.actor,
          action: e.action,
          targetKind: e.targetKind,
          targetId: e.targetId,
          accessTagsUsed: [...e.accessTagsUsed],
          details: { resultCount: e.resultCount },
          occurredAt: e.occurredAt,
        })),
      );
    } catch {
      // Fail-open: the reads these rows describe already succeeded — drop the
      // batch with a visible counter rather than failing or retrying into a
      // wedged database.
      this.drop(batch.length, 'write failed');
    }
  }

  private drop(count: number, why: string): void {
    this.droppedTotal += count;
    const now = Date.now();
    if (now - this.lastWarnAt >= this.warnIntervalMs) {
      this.lastWarnAt = now;
      // reason: this rate-limited warning IS the visibility mechanism for
      // fail-open drops; no structured logger exists in the engine yet
      // — migrate when one lands.
      console.warn(
        `[read-audit] dropped ${count} audit event(s) (${why}); ${this.droppedTotal} dropped since start`,
      );
    }
  }
}

// MUNIN_READ_AUDIT: default ON. Only an explicit 'false' (any case) disables —
// a typo must never silently turn the access trail off. Local/free-tier users
// may disable it (their machine, their call); managed/BYO pilots run with it on.
//
// PRODUCTION GUARD (same fail-fast pattern as the devkey blob refusal and the
// sandbox-mode production rejection): per-read audit is part of the cross-mode
// compliance set gating real customer data, so under NODE_ENV=production an
// explicit 'false' THROWS unless MUNIN_READ_AUDIT_ALLOW_PROD_OFF=true is also
// set — one env var must not silently void the access trail in a deployment.
// The override exists for a BYO customer's own documented decision.
export function readAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const off = (env.MUNIN_READ_AUDIT ?? '').toLowerCase() === 'false';
  if (
    off &&
    env.NODE_ENV === 'production' &&
    (env.MUNIN_READ_AUDIT_ALLOW_PROD_OFF ?? '').toLowerCase() !== 'true'
  ) {
    throw new Error(
      'MUNIN_READ_AUDIT=false is refused under NODE_ENV=production: the per-read access ' +
        'trail (F10/F26) is a compliance control. Set MUNIN_READ_AUDIT_ALLOW_PROD_OFF=true ' +
        'only as an explicit, documented deployment decision.',
    );
  }
  return !off;
}
