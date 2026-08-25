import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import { DriftReport, DriftFinding, DriftEvent } from './types';

// ── In-memory record (used by both storage backends) ─────────────────────────

export interface DriftSnapshotRecord {
  snapshotId: string;
  capturedAt: number;
  driftReport: DriftReport;
}

// ── Storage options ───────────────────────────────────────────────────────────

export interface DriftStorageOptions {
  /** Maximum number of snapshots to keep in the in-memory ring buffer. */
  maxInMemory?: number;
  /** Optional JSONL on-disk path for durability across restarts. */
  jsonlPath?: string;
  /** Optional PostgreSQL pool — enables persistence to config_drift_events table. */
  pool?: Pool;
}

// ── DriftStorage ──────────────────────────────────────────────────────────────

export class DriftStorage {
  private readonly maxInMemory: number;
  private readonly jsonlPath?: string;
  private readonly pool?: Pool;
  private readonly inMemory: DriftSnapshotRecord[] = [];

  constructor(options: DriftStorageOptions = {}) {
    this.maxInMemory = options.maxInMemory ?? 240; // ~20 hours at 5-min interval
    this.jsonlPath = options.jsonlPath;
    this.pool = options.pool;

    if (this.jsonlPath) {
      const dir = path.dirname(this.jsonlPath);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.jsonlPath)) {
        const content = fs.readFileSync(this.jsonlPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as DriftSnapshotRecord;
            if (record && typeof record.snapshotId === 'string') {
              this.inMemory.push(record);
            }
          } catch {
            // skip malformed lines
          }
        }
        while (this.inMemory.length > this.maxInMemory) {
          this.inMemory.shift();
        }
      }
    }
  }

  // ── In-memory / JSONL operations ───────────────────────────────────────────

  add(record: DriftSnapshotRecord): void {
    this.inMemory.push(record);
    while (this.inMemory.length > this.maxInMemory) {
      this.inMemory.shift();
    }

    if (this.jsonlPath) {
      try {
        fs.appendFileSync(this.jsonlPath, JSON.stringify(record) + '\n', 'utf8');
      } catch {
        // best-effort; errors should not crash the auditor
      }
    }
  }

  history(limit = 100): DriftSnapshotRecord[] {
    return this.inMemory.slice(-Math.min(limit, this.inMemory.length));
  }

  latest(): DriftSnapshotRecord | null {
    return this.inMemory.length ? this.inMemory[this.inMemory.length - 1] : null;
  }

  // ── PostgreSQL persistence ─────────────────────────────────────────────────

  /**
   * Persist all findings from a DriftReport into the config_drift_events table.
   * Each DriftFinding becomes one row so the table stays granular.
   * Safe to call without a pool — silently returns when pool is not configured.
   */
  async persistDriftEvents(report: DriftReport, snapshotCapturedAt?: Date): Promise<void> {
    if (!this.pool) return;
    if (!report.findings || report.findings.length === 0) return;

    const capturedAt = snapshotCapturedAt ?? new Date(report.startedAt);

    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');

      for (const finding of report.findings) {
        await client.query(
          `INSERT INTO config_drift_events
             (snapshot_id, captured_at, severity, category, key,
              baseline_value, runtime_value, auto_remediated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            report.snapshotId,
            capturedAt,
            finding.severity,
            finding.category,
            finding.key,
            JSON.stringify(finding.baselineValue ?? null),
            JSON.stringify(finding.runtimeValue ?? null),
            false,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
      }
      // Log but don't propagate — storage failures must not crash the auditor
      console.error('[DriftStorage] Failed to persist drift events to PostgreSQL:', err);
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Mark a specific drift event row as auto-remediated.
   * No-op when pool is not configured.
   */
  async markRemediated(eventId: string, note: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `UPDATE config_drift_events
            SET auto_remediated = true, remediation_note = $1
          WHERE event_id = $2`,
        [note, eventId],
      );
    } catch (err) {
      console.error('[DriftStorage] Failed to mark drift event as remediated:', err);
    }
  }

  /**
   * Query recent drift events from PostgreSQL.
   * Falls back to empty array when pool is not configured.
   */
  async queryEvents(opts: {
    limit?: number;
    severity?: string;
    since?: Date;
  } = {}): Promise<DriftEvent[]> {
    if (!this.pool) return [];

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (opts.severity) {
      conditions.push(`severity = $${idx++}`);
      values.push(opts.severity);
    }
    if (opts.since) {
      conditions.push(`captured_at > $${idx++}`);
      values.push(opts.since);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(opts.limit ?? 100, 1000);

    try {
      const result = await this.pool.query<{
        event_id: string;
        snapshot_id: string;
        captured_at: Date;
        severity: string;
        category: string;
        key: string;
        baseline_value: string;
        runtime_value: string;
        auto_remediated: boolean;
        remediation_note: string | null;
      }>(
        `SELECT event_id, snapshot_id, captured_at, severity, category, key,
                baseline_value, runtime_value, auto_remediated, remediation_note
           FROM config_drift_events
           ${where}
           ORDER BY captured_at DESC
           LIMIT $${idx}`,
        [...values, limit],
      );

      return result.rows.map((r) => ({
        eventId: r.event_id,
        snapshotId: r.snapshot_id,
        capturedAt: r.captured_at,
        severity: r.severity as DriftEvent['severity'],
        category: r.category as DriftEvent['category'],
        key: r.key,
        baselineValue: tryParseJson(r.baseline_value),
        runtimeValue: tryParseJson(r.runtime_value),
        autoRemediated: r.auto_remediated,
        remediationNote: r.remediation_note ?? undefined,
      }));
    } catch (err) {
      console.error('[DriftStorage] Failed to query drift events:', err);
      return [];
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
