import { Database } from '../config/database';
import { PoolClient } from 'pg';

// =============================================================================
// Type Definitions
// =============================================================================

export interface UpsertHeartbeatParams {
  time: Date;
  nodeId: string;
  sourceIp?: string;
  latencyMs: number;
  status: 'up' | 'degraded' | 'down';
  uptimePct: number;
  blockHeight?: number;
  extra?: Record<string, unknown>;
}

export interface HourlyAggregateRow {
  bucket: Date;
  node_id: string;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  avg_uptime_pct: number;
  heartbeat_count: number;
  up_count: number;
  degraded_count: number;
  down_count: number;
}

export interface RawHeartbeatRow {
  time: Date;
  node_id: string;
  source_ip: string | null;
  latency_ms: number;
  status: string;
  uptime_pct: number;
  block_height: number | null;
  extra: Record<string, unknown> | null;
}

export interface AggregateParams {
  nodeIds?: string[];
  startTime: Date;
  endTime: Date;
  limit?: number;
  offset?: number;
}

export interface RawQueryParams {
  nodeIds?: string[];
  startTime: Date;
  endTime: Date;
  limit?: number;
  offset?: number;
}

export interface UptimeMetrics {
  node_id: string;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  avg_uptime_pct: number;
  heartbeat_count: number;
  up_count: number;
  degraded_count: number;
  down_count: number;
}

export interface ConnectionCountRow {
  node_count: number;
  last_heartbeat: Date;
  up_rate: number;
}

const UPSERT_HEARTBEAT_SQL = `
  INSERT INTO uptime_heartbeat (time, node_id, source_ip, latency_ms, status, uptime_pct, block_height, extra)
  VALUES ($1, $2, $3::inet, $4, $5, $6, $7, $8::jsonb)
`;

const QUERY_RAW_SQL = `
  SELECT time, node_id, source_ip, latency_ms, status, uptime_pct, block_height, extra
  FROM uptime_heartbeat
  WHERE time >= $1
    AND time <= $2
`;

const QUERY_HOURLY_AGG_SQL = `
  SELECT bucket, node_id, avg_latency_ms, p50_latency_ms, p95_latency_ms, p99_latency_ms,
         avg_uptime_pct, heartbeat_count, up_count, degraded_count, down_count
  FROM uptime_hourly_agg
  WHERE bucket >= $1
    AND bucket <= $2
`;

const DASHBOARD_AGG_SQL = `
  SELECT
    node_id,
    AVG(avg_latency_ms)   AS avg_latency_ms,
    AVG(p50_latency_ms)   AS p50_latency_ms,
    AVG(p95_latency_ms)   AS p95_latency_ms,
    AVG(p99_latency_ms)   AS p99_latency_ms,
    AVG(avg_uptime_pct)   AS avg_uptime_pct,
    SUM(heartbeat_count)  AS heartbeat_count,
    SUM(up_count)         AS up_count,
    SUM(degraded_count)   AS degraded_count,
    SUM(down_count)       AS down_count
  FROM uptime_hourly_agg
  WHERE bucket >= $1
    AND bucket <= $2
`;

const NODE_CONNECTION_COUNT_SQL = `
  SELECT
    COUNT(DISTINCT node_id)::int       AS node_count,
    MAX(time)                          AS last_heartbeat,
    AVG(CASE WHEN status = 'up' THEN 1.0 ELSE 0.0 END) AS up_rate
  FROM uptime_heartbeat
  WHERE time >= $1
`;

// =============================================================================
// UptimeStore — injected with a Database instance following project DI convention
// =============================================================================

export class UptimeStore {
  private db: Database;

  constructor(database: Database) {
    this.db = database;
  }

  // -------------------------------------------------------------------------
  // Write path: single heartbeat upsert
  // -------------------------------------------------------------------------

  /**
   * Insert a single node heartbeat.
   * P99 latency target for this write: < 200ms (writes to active chunk).
   */
  async insertHeartbeat(params: UpsertHeartbeatParams): Promise<void> {
    await this.db.query(UPSERT_HEARTBEAT_SQL, [
      params.time.toISOString(),
      params.nodeId,
      params.sourceIp ?? null,
      params.latencyMs,
      params.status,
      params.uptimePct,
      params.blockHeight ?? null,
      params.extra ? JSON.stringify(params.extra) : null,
    ]);
  }

  /**
   * Batch insert heartbeats for high-throughput ingestion.
   * Uses a single multi-row INSERT within a transaction for atomicity.
   */
  async insertHeartbeatBatch(heartbeats: UpsertHeartbeatParams[]): Promise<void> {
    if (heartbeats.length === 0) return;

    await this.db.transaction(async (client: PoolClient) => {
      const values: any[] = [];
      const placeholders: string[] = [];
      let idx = 1;

      for (const hb of heartbeats) {
        placeholders.push(
          `($${idx}, $${idx + 1}, $${idx + 2}::inet, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}::jsonb)`,
        );
        values.push(
          hb.time.toISOString(),
          hb.nodeId,
          hb.sourceIp ?? null,
          hb.latencyMs,
          hb.status,
          hb.uptimePct,
          hb.blockHeight ?? null,
          hb.extra ? JSON.stringify(hb.extra) : null,
        );
        idx += 8;
      }

      await client.query(
        `INSERT INTO uptime_heartbeat (time, node_id, source_ip, latency_ms, status, uptime_pct, block_height, extra)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Read path: raw heartbeat queries (used for dashboard <1h window)
  // -------------------------------------------------------------------------

  /**
   * Query raw heartbeats from the hypertable.
   * Target P99 < 200ms for last-1-hour window.
   * For larger time ranges, prefer queryHourlyAggregates which
   * leverages TimescaleDB continuous aggregates for better performance.
   */
  async queryRawHeartbeats(params: RawQueryParams): Promise<RawHeartbeatRow[]> {
    const { nodeIds, startTime, endTime, limit = 500, offset = 0 } = params;

    let sql = QUERY_RAW_SQL;
    const values: any[] = [startTime.toISOString(), endTime.toISOString()];
    let paramIdx = 3;

    if (nodeIds && nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => `$${paramIdx++}`).join(', ');
      sql += ` AND node_id IN (${placeholders})`;
      values.push(...nodeIds);
    }

    sql += ` ORDER BY time DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    values.push(limit, offset);

    const result = await this.db.query<RawHeartbeatRow>(sql, values);
    return result.rows;
  }

  // -------------------------------------------------------------------------
  // Read path: hourly aggregate queries (used for historical >1h windows)
  // -------------------------------------------------------------------------

  /**
   * Query hourly aggregates via the continuous aggregate view.
   * TimescaleDB transparently combines materialized data with the latest
   * raw hypertable data (real-time aggregates), so no manual query
   * routing between raw and aggregate views is needed.
   *
   * Target P99 < 2s for last-7-day range scans.
   */
  async queryHourlyAggregates(params: AggregateParams): Promise<HourlyAggregateRow[]> {
    const { nodeIds, startTime, endTime, limit = 500, offset = 0 } = params;

    let sql = QUERY_HOURLY_AGG_SQL;
    const values: any[] = [startTime.toISOString(), endTime.toISOString()];
    let paramIdx = 3;

    if (nodeIds && nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => `$${paramIdx++}`).join(', ');
      sql += ` AND node_id IN (${placeholders})`;
      values.push(...nodeIds);
    }

    sql += ` ORDER BY bucket DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    values.push(limit, offset);

    const result = await this.db.query<HourlyAggregateRow>(sql, values);
    return result.rows;
  }

  // -------------------------------------------------------------------------
  // Dashboard: aggregated per-node metrics over a time window
  // -------------------------------------------------------------------------

  /**
   * Get aggregated per-node metrics for a dashboard view.
   * Computes AVG/P50/P95/P99 latency and uptime across the given window
   * using the continuous aggregate materialized view.
   */
  async queryDashboardMetrics(params: AggregateParams): Promise<UptimeMetrics[]> {
    const { nodeIds, startTime, endTime } = params;

    let sql = DASHBOARD_AGG_SQL;
    const values: any[] = [startTime.toISOString(), endTime.toISOString()];
    let paramIdx = 3;

    if (nodeIds && nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => `$${paramIdx++}`).join(', ');
      sql += ` AND node_id IN (${placeholders})`;
      values.push(...nodeIds);
    }

    sql += ` GROUP BY node_id ORDER BY avg_latency_ms DESC`;

    const result = await this.db.query<UptimeMetrics>(sql, values);
    return result.rows;
  }

  // -------------------------------------------------------------------------
  // Health: node connection counts
  // -------------------------------------------------------------------------

  /**
   * Get the number of unique nodes that have heartbeated in the given window
   * plus the overall up rate.
   */
  async queryNodeConnectionCount(since: Date): Promise<ConnectionCountRow | null> {
    const result = await this.db.query<ConnectionCountRow>(NODE_CONNECTION_COUNT_SQL, [
      since.toISOString(),
    ]);
    return result.rows[0] ?? null;
  }
}
