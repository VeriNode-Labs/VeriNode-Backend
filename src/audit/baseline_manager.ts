/**
 * VeriNode Backend — Runtime Config Audit: BaselineManager
 *
 * Captures, stores, and retrieves known-good configuration baseline snapshots.
 * Enforces single-active-baseline invariant via an atomic DB transaction.
 * All mutating operations require config:baseline:write permission.
 */

import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import {
  ActorContext,
  Baseline,
  BaselineDeserializationError,
  BaselineSerializationError,
  ForbiddenError,
} from './types';
import { requirePermission } from '../api/auth/token_validator';
import { StructuredLogger } from '../diagnostics/logger';

// ── Serialization helpers ─────────────────────────────────────────────────────

/**
 * Recursively sort all object keys lexicographically at every nesting depth
 * so that two deep-equal configurations always produce identical JSON strings.
 */
function sortedKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    sorted[key] = sortedKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

// ── BaselineManager ───────────────────────────────────────────────────────────

export class BaselineManager {
  constructor(
    private readonly pool: Pool,
    private readonly logger: StructuredLogger,
  ) {}

  // ── Serialization ──────────────────────────────────────────────────────────

  /**
   * Serialize a configuration object to a deterministic JSON string.
   * Keys are sorted lexicographically at every nesting level so the
   * resulting string — and its SHA-256 hash — are reproducible.
   */
  serializeBaseline(config: object): string {
    if (
      config === null ||
      config === undefined ||
      typeof config !== 'object' ||
      Array.isArray(config)
    ) {
      throw new BaselineSerializationError(
        `serializeBaseline expects a plain object but received: ${
          config === null ? 'null' : Array.isArray(config) ? 'array' : typeof config
        }`,
      );
    }
    return JSON.stringify(sortedKeys(config));
  }

  /**
   * Deserialize a JSON string back into a plain JavaScript object.
   * Throws BaselineDeserializationError for non-string or invalid-JSON input.
   */
  deserializeBaseline(json: unknown): object {
    if (typeof json !== 'string') {
      throw new BaselineDeserializationError(
        `deserializeBaseline expects a string but received: ${
          json === null ? 'null' : typeof json
        }`,
      );
    }
    try {
      return JSON.parse(json) as object;
    } catch (err) {
      throw new BaselineDeserializationError(
        `deserializeBaseline failed to parse JSON: ${(err as Error).message}`,
      );
    }
  }

  // ── Database operations ────────────────────────────────────────────────────

  /**
   * Capture the current config as a new active baseline.
   * Atomically supersedes any previous active baseline.
   * Requires config:baseline:write permission.
   */
  async capture(config: object, actor: ActorContext): Promise<Baseline> {
    // 1. Auth check — MUST be the first operation
    try {
      requirePermission(actor, 'config:baseline:write');
    } catch (err) {
      // Write access-denied audit entry inline (no AuditLogger to avoid circular dep)
      await this._writeAccessDenied(actor, 'baseline:capture').catch(() => {});
      throw err;
    }

    // 2. Serialize and hash
    const snapshotJson = this.serializeBaseline(config);
    const sha256Hash = createHash('sha256').update(snapshotJson, 'utf8').digest('hex');
    const id = randomUUID();
    const now = new Date();

    // 3. Atomic transaction: supersede old active, insert new active
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE config_baselines SET status = 'superseded'
         WHERE status = 'active'`,
      );

      await client.query(
        `INSERT INTO config_baselines (id, snapshot_json, sha256_hash, actor, created_at, status)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [id, snapshotJson, sha256Hash, actor.actorId, now],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    this.logger.info('[BaselineManager] Baseline captured', {
      baseline_id: id,
      actor: actor.actorId,
    });

    return { id, snapshotJson, sha256Hash, actor: actor.actorId, createdAt: now, status: 'active' };
  }

  /**
   * Return the currently active baseline, or null if none exists.
   */
  async getActive(): Promise<Baseline | null> {
    const result = await this.pool.query<{
      id: string;
      snapshot_json: string;
      sha256_hash: string;
      actor: string;
      created_at: Date;
      status: string;
    }>(
      `SELECT id, snapshot_json, sha256_hash, actor, created_at, status
       FROM config_baselines
       WHERE status = 'active'
       LIMIT 1`,
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      snapshotJson: row.snapshot_json,
      sha256Hash: row.sha256_hash,
      actor: row.actor,
      createdAt: new Date(row.created_at),
      status: row.status as 'active',
    };
  }

  /**
   * Mark superseded baselines older than 90 days as expired.
   * Returns the number of rows updated.
   */
  async expireOldBaselines(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE config_baselines
       SET status = 'expired'
       WHERE status = 'superseded'
         AND created_at < NOW() - INTERVAL '90 days'`,
    );
    return result.rowCount ?? 0;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Inline access-denied audit write that does NOT depend on AuditLogger. */
  private async _writeAccessDenied(actor: ActorContext, operation: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO config_audit_log
         (config_path, previous_value, new_value, actor, source_ip, changed_at, change_source, hmac_digest)
       VALUES
         ($1, NULL, NULL, $2, $3::inet, NOW(), 'access_denied', repeat('0', 64))`,
      [
        `baseline.${operation}`,
        actor.actorId,
        actor.sourceIp,
      ],
    ).catch((err: Error) => {
      // Best-effort: if we can't write the denial entry, log and move on.
      this.logger.warn('[BaselineManager] Could not write access-denied audit entry', {
        'error.message': err.message,
      });
    });
  }
}
