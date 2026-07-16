/**
 * VeriNode Backend — Runtime Config Audit: AuditLogger
 *
 * Persists tamper-evident, HMAC-signed audit entries to config_audit_log.
 * Provides HMAC integrity verification and chain-scan capabilities.
 *
 * Fault-tolerance contract:
 *   - DB unavailable → entries enqueued in bounded FIFO (max 1000)
 *   - Queue at capacity → oldest evicted, counter incremented
 *   - Queue drained when DB recovers (30s probe interval)
 *   - Write retried up to 3× with 50/100/200ms back-off before giving up
 */

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import {
  AuditEntry,
  AuditEntryInput,
  AuditQueryFilters,
  AuditQueryResult,
  ChainVerificationResult,
  ChangeSource,
  NotFoundError,
} from './types';
import { computeHmac } from './hmac';
import { instruments } from './metrics';
import { ConfigEventBus } from '../config/eventbus';
import { StructuredLogger } from '../diagnostics/logger';

const QUEUE_CAPACITY = 1000;
const PROBE_INTERVAL_MS = 30_000;
const WRITE_DEADLINE_MS = 500;
const RETRY_DELAYS_MS = [50, 100, 200] as const;

// ── Row shape returned from the DB ────────────────────────────────────────────

interface AuditRow {
  entry_id: string;
  config_path: string;
  previous_value: unknown;
  new_value: unknown;
  actor: string;
  source_ip: string | null;
  changed_at: Date;
  change_source: string;
  hmac_digest: string;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    entryId: row.entry_id,
    configPath: row.config_path,
    previousValue: row.previous_value,
    newValue: row.new_value,
    actor: row.actor,
    sourceIp: row.source_ip,
    changedAt: new Date(row.changed_at),
    changeSource: row.change_source as ChangeSource,
    hmacDigest: row.hmac_digest,
  };
}

// ── AuditLogger ───────────────────────────────────────────────────────────────

export class AuditLogger {
  private readonly queue: AuditEntry[] = [];
  private dbAvailable = true;
  private lastSuccessfulWrite: Date | null = null;
  private probeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly hmacSecret: Buffer,
    private readonly eventBus: ConfigEventBus,
    private readonly logger: StructuredLogger,
  ) {
    this._startProbe();
  }

  /** Current in-memory queue depth — exposed for healthCheck(). */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Timestamp of last successful DB write — exposed for healthCheck(). */
  get lastWrite(): Date | null {
    return this.lastSuccessfulWrite;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Write an audit entry to the database.
   * If the DB is unavailable the entry is enqueued for later replay.
   */
  async write(input: AuditEntryInput): Promise<void> {
    const entryId = randomUUID();
    const entry: AuditEntry = {
      ...input,
      entryId,
      hmacDigest: computeHmac({ ...input, entryId, hmacDigest: '' }, this.hmacSecret),
    };

    if (!this.dbAvailable) {
      this._enqueue(entry);
      return;
    }

    try {
      await this._insertWithRetry(entry);
      this.lastSuccessfulWrite = new Date();
      await this._drainQueue();
    } catch (err) {
      this.logger.error('[AuditLogger] All write retries exhausted; switching to queue mode', {
        'error.message': (err as Error).message,
        config_path: entry.configPath,
      });
      this.dbAvailable = false;
      this._enqueue(entry);
      this.eventBus.emitEvent('error', null, err as Error);
    }
  }

  // ── Verify integrity of a single entry ────────────────────────────────────

  /**
   * Recompute the HMAC for the stored entry and compare.
   * Returns true if valid, false if tampered, throws NotFoundError if absent.
   */
  async verifyIntegrity(entryId: string): Promise<boolean> {
    const result = await this.pool.query<AuditRow>(
      `SELECT entry_id, config_path, previous_value, new_value,
              actor, source_ip, changed_at, change_source, hmac_digest
       FROM config_audit_log
       WHERE entry_id = $1`,
      [entryId],
    );

    if (result.rows.length === 0) {
      throw new NotFoundError(`Audit entry not found: ${entryId}`);
    }

    const entry = rowToEntry(result.rows[0]);
    const expected = computeHmac(entry, this.hmacSecret);
    return expected === entry.hmacDigest;
  }

  // ── Chain verification ─────────────────────────────────────────────────────

  /**
   * Verify HMAC integrity for all entries in a time range.
   * Emits 'integrity_violation' on the event bus if any are invalid.
   */
  async verifyChain(from: Date, to: Date): Promise<ChainVerificationResult> {
    const result = await this.pool.query<AuditRow>(
      `SELECT entry_id, config_path, previous_value, new_value,
              actor, source_ip, changed_at, change_source, hmac_digest
       FROM config_audit_log
       WHERE changed_at >= $1 AND changed_at <= $2
       ORDER BY changed_at ASC`,
      [from, to],
    );

    const invalidEntryIds: string[] = [];
    for (const row of result.rows) {
      const entry = rowToEntry(row);
      const expected = computeHmac(entry, this.hmacSecret);
      if (expected !== entry.hmacDigest) {
        invalidEntryIds.push(entry.entryId);
      }
    }

    const chainResult: ChainVerificationResult = {
      totalChecked: result.rows.length,
      validCount: result.rows.length - invalidEntryIds.length,
      invalidCount: invalidEntryIds.length,
      invalidEntryIds,
    };

    if (invalidEntryIds.length > 0) {
      this.logger.error('[AuditLogger] Integrity violation detected in audit chain', {
        invalid_count: invalidEntryIds.length,
        total_checked: result.rows.length,
      });
      this.eventBus.emitEvent('integrity_violation' as any, chainResult);
    }

    return chainResult;
  }

  // ── Paginated query ────────────────────────────────────────────────────────

  /**
   * Retrieve audit entries with optional filters, paginated.
   * pageSize is clamped to [1, 200].
   */
  async queryAuditLog(filters: AuditQueryFilters): Promise<AuditQueryResult> {
    const pageSize = Math.min(200, Math.max(1, filters.pageSize));
    const page = Math.max(1, filters.page);
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.configPath) {
      conditions.push(`config_path = $${idx++}`);
      params.push(filters.configPath);
    }
    if (filters.actor) {
      conditions.push(`actor = $${idx++}`);
      params.push(filters.actor);
    }
    if (filters.changeSource) {
      conditions.push(`change_source = $${idx++}`);
      params.push(filters.changeSource);
    }
    if (filters.fromTimestamp) {
      conditions.push(`changed_at >= $${idx++}`);
      params.push(filters.fromTimestamp);
    }
    if (filters.toTimestamp) {
      conditions.push(`changed_at <= $${idx++}`);
      params.push(filters.toTimestamp);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM config_audit_log ${where}`,
      params,
    );
    const totalCount = parseInt(countResult.rows[0]?.total ?? '0', 10);

    const dataResult = await this.pool.query<AuditRow>(
      `SELECT entry_id, config_path, previous_value, new_value,
              actor, source_ip, changed_at, change_source, hmac_digest
       FROM config_audit_log ${where}
       ORDER BY changed_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset],
    );

    return {
      entries: dataResult.rows.map(rowToEntry),
      totalCount,
      page,
      pageSize,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /** Stop the background DB probe. Call during graceful shutdown. */
  stop(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _enqueue(entry: AuditEntry): void {
    if (this.queue.length >= QUEUE_CAPACITY) {
      this.queue.shift(); // evict oldest (FIFO)
      instruments.queueDroppedTotal.add(1);
      this.logger.warn('[AuditLogger] Queue at capacity; oldest entry evicted', {
        queue_depth: this.queue.length,
      });
    }
    this.queue.push(entry);
  }

  private async _insertWithRetry(entry: AuditEntry): Promise<void> {
    let lastErr: Error | null = null;
    for (const delayMs of [0, ...RETRY_DELAYS_MS]) {
      if (delayMs > 0) await _sleep(delayMs);
      try {
        await this._insertEntry(entry);
        return;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw lastErr!;
  }

  private async _insertEntry(entry: AuditEntry): Promise<void> {
    const insertPromise = this.pool.query(
      `INSERT INTO config_audit_log
         (entry_id, config_path, previous_value, new_value,
          actor, source_ip, changed_at, change_source, hmac_digest)
       VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8, $9)`,
      [
        entry.entryId,
        entry.configPath,
        JSON.stringify(entry.previousValue ?? null),
        JSON.stringify(entry.newValue ?? null),
        entry.actor,
        entry.sourceIp,
        entry.changedAt,
        entry.changeSource,
        entry.hmacDigest,
      ],
    );

    // Race against the write deadline
    const timeoutPromise = _sleep(WRITE_DEADLINE_MS).then(() => {
      throw new Error(`Audit log write exceeded ${WRITE_DEADLINE_MS}ms deadline`);
    });

    await Promise.race([insertPromise, timeoutPromise]);

    // Record OTel counter
    const section = entry.configPath.split('.')[0] ?? 'unknown';
    instruments.changesTotal.add(1, {
      change_source: entry.changeSource,
      config_section: section,
    });
  }

  private async _drainQueue(): Promise<void> {
    while (this.queue.length > 0 && this.dbAvailable) {
      const entry = this.queue[0];
      try {
        await this._insertWithRetry(entry);
        this.queue.shift();
        this.lastSuccessfulWrite = new Date();
      } catch {
        // Stop draining if DB becomes unavailable again
        this.dbAvailable = false;
        break;
      }
    }
  }

  private _startProbe(): void {
    this.probeTimer = setInterval(async () => {
      try {
        await this.pool.query('SELECT 1');
        if (!this.dbAvailable) {
          this.dbAvailable = true;
          this.logger.info('[AuditLogger] DB connection restored; draining queue', {
            queue_depth: this.queue.length,
          });
        }
        await this._drainQueue();
      } catch {
        // DB still unavailable — stay in queue mode
      }
    }, PROBE_INTERVAL_MS);

    // Don't hold the process open just for the probe
    this.probeTimer.unref?.();
  }
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
