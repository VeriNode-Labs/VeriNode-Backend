import { Pool, PoolConfig, QueryResult, QueryResultRow, PoolClient } from 'pg';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export interface QueryMetrics {
  durationMs: number;
  rowCount: number;
  query: string;
  success: boolean;
}

export type QueryHandler = (metrics: QueryMetrics) => void;

export class Database {
  private pool: Pool;
  private config: DatabaseConfig;
  private onQueryComplete: QueryHandler | null = null;
  private totalQueries = 0;
  private totalErrors = 0;

  constructor(config: DatabaseConfig) {
    this.config = config;

    const poolConfig: PoolConfig = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: config.maxConnections ?? 20,
      idleTimeoutMillis: config.idleTimeoutMs ?? 30000,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 10000,
      application_name: 'verinode_backend',
    };

    this.pool = new Pool(poolConfig);

    this.pool.on('error', (err: Error) => {
      console.error('[Database] Unexpected pool error:', err.message);
    });

    this.pool.on('connect', () => {
      // Connection established
    });
  }

  setQueryHandler(handler: QueryHandler): void {
    this.onQueryComplete = handler;
  }

  async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    const startTime = performance.now();
    let success = true;
    let rowCount = 0;

    try {
      const result = await this.pool.query<T>(text, params);
      rowCount = result.rowCount ?? 0;
      return result;
    } catch (err) {
      success = false;
      this.totalErrors++;
      throw err;
    } finally {
      this.totalQueries++;
      const durationMs = performance.now() - startTime;
      if (this.onQueryComplete) {
        this.onQueryComplete({
          durationMs,
          rowCount,
          query: text.slice(0, 200),
          success,
        });
      }
    }
  }

  async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1');
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  getMetrics(): { totalQueries: number; totalErrors: number; idleCount: number; totalCount: number; waitingCount: number } {
    return {
      totalQueries: this.totalQueries,
      totalErrors: this.totalErrors,
      idleCount: this.pool.idleCount,
      totalCount: this.pool.totalCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /** Ensure required extensions are installed on the database.
   *  TimescaleDB is critical — failure propagates as an error.
   *  pg_cron is optional and tolerated when unavailable. */
  async ensureExtensions(): Promise<void> {
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE');
    // pg_cron requires superuser and shared_preload_libraries at server level;
    // we attempt creation but tolerate failure in non-privileged environments.
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS pg_cron CASCADE');
    } catch {
      console.warn('[Database] pg_cron extension not available — cron jobs will not be scheduled');
    }
  }
}
