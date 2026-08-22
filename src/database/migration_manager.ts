import { readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';

export interface MigrationRecord {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
  executionMs: number;
  rolledBackAt?: Date | null;
}

export interface MigrationClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface MigrationDefinition {
  version: string;
  name: string;
  up: string;
  down: string;
  checksum: string;
}

export interface MigrationEvent {
  type:
    | 'migration_started'
    | 'migration_completed'
    | 'migration_failed'
    | 'rollback_started'
    | 'rollback_completed'
    | 'rollback_failed';
  version: string;
  name: string;
  executionMs?: number;
  error?: string;
}

export type MigrationEventSink = (event: MigrationEvent) => void;

const HEADER_PATTERN = /^--\s*@(up|down)\s*$/im;

export class MigrationManager {
  constructor(
    private readonly client: MigrationClient,
    private readonly migrationsDir: string,
    private readonly emit: MigrationEventSink = () => undefined,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        execution_ms INTEGER NOT NULL,
        rolled_back_at TIMESTAMPTZ NULL
      )
    `);
    await this.client.query(
      'CREATE INDEX IF NOT EXISTS schema_migrations_active_idx ON schema_migrations (version) WHERE rolled_back_at IS NULL',
    );
  }

  loadMigrations(): MigrationDefinition[] {
    return readdirSync(this.migrationsDir)
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort()
      .map((file) => this.parseMigration(file));
  }

  async pending(): Promise<MigrationDefinition[]> {
    await this.ensureSchema();
    const applied = await this.appliedVersions();
    return this.loadMigrations().filter((migration) => !applied.has(migration.version));
  }

  async migrate(targetVersion?: string): Promise<MigrationRecord[]> {
    await this.ensureSchema();
    const applied = await this.appliedVersions();
    const candidates = this.loadMigrations().filter((migration) => !applied.has(migration.version));
    const selected = targetVersion
      ? candidates.filter((migration) => migration.version <= targetVersion)
      : candidates;
    const records: MigrationRecord[] = [];

    for (const migration of selected) {
      records.push(await this.applyMigration(migration));
    }

    return records;
  }

  async rollback(targetVersion: string): Promise<MigrationRecord[]> {
    await this.ensureSchema();
    const migrations = new Map(
      this.loadMigrations().map((migration) => [migration.version, migration]),
    );
    const result = await this.client.query<MigrationRecord>(
      'SELECT version, name, checksum, applied_at as "appliedAt", execution_ms as "executionMs", rolled_back_at as "rolledBackAt" FROM schema_migrations WHERE rolled_back_at IS NULL AND version > $1 ORDER BY version DESC',
      [targetVersion],
    );
    const records: MigrationRecord[] = [];

    for (const record of result.rows) {
      const migration = migrations.get(record.version);
      if (!migration) {
        throw new Error(`Cannot rollback ${record.version}; migration file is missing`);
      }
      records.push(await this.rollbackMigration(migration));
    }

    return records;
  }

  private async applyMigration(migration: MigrationDefinition): Promise<MigrationRecord> {
    const started = Date.now();
    this.emit({ type: 'migration_started', version: migration.version, name: migration.name });
    try {
      await this.client.query('BEGIN');
      await this.client.query(migration.up);
      const executionMs = Date.now() - started;
      await this.client.query(
        `INSERT INTO schema_migrations (version, name, checksum, execution_ms, rolled_back_at)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW(), execution_ms = EXCLUDED.execution_ms, rolled_back_at = NULL`,
        [migration.version, migration.name, migration.checksum, executionMs],
      );
      await this.client.query('COMMIT');
      this.emit({
        type: 'migration_completed',
        version: migration.version,
        name: migration.name,
        executionMs,
      });
      return {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        appliedAt: new Date(),
        executionMs,
      };
    } catch (error) {
      await this.client.query('ROLLBACK');
      this.emit({
        type: 'migration_failed',
        version: migration.version,
        name: migration.name,
        error: String(error),
      });
      throw error;
    }
  }

  private async rollbackMigration(migration: MigrationDefinition): Promise<MigrationRecord> {
    const started = Date.now();
    this.emit({ type: 'rollback_started', version: migration.version, name: migration.name });
    try {
      await this.client.query('BEGIN');
      await this.client.query(migration.down);
      const executionMs = Date.now() - started;
      await this.client.query(
        'UPDATE schema_migrations SET rolled_back_at = NOW(), execution_ms = $2 WHERE version = $1',
        [migration.version, executionMs],
      );
      await this.client.query('COMMIT');
      this.emit({
        type: 'rollback_completed',
        version: migration.version,
        name: migration.name,
        executionMs,
      });
      return {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        appliedAt: new Date(),
        executionMs,
        rolledBackAt: new Date(),
      };
    } catch (error) {
      await this.client.query('ROLLBACK');
      this.emit({
        type: 'rollback_failed',
        version: migration.version,
        name: migration.name,
        error: String(error),
      });
      throw error;
    }
  }

  private async appliedVersions(): Promise<Set<string>> {
    const result = await this.client.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE rolled_back_at IS NULL',
    );
    return new Set(result.rows.map((row) => row.version));
  }

  private parseMigration(file: string): MigrationDefinition {
    const content = readFileSync(join(this.migrationsDir, file), 'utf-8');
    const marker = content.match(HEADER_PATTERN);
    if (!marker) {
      return {
        version: file.split('_')[0],
        name: basename(file, '.sql'),
        up: content,
        down: `-- no-op rollback for ${file}`,
        checksum: checksum(content),
      };
    }
    const upMatch = content.match(/^--\s*@up\s*$(.*?)^--\s*@down\s*$/ims);
    const downMatch = content.match(/^--\s*@down\s*$(.*)$/ims);
    if (!upMatch || !downMatch || !downMatch[1].trim()) {
      throw new Error(`Migration ${file} must include -- @up and non-empty -- @down sections`);
    }
    return {
      version: file.split('_')[0],
      name: basename(file, '.sql'),
      up: upMatch[1].trim(),
      down: downMatch[1].trim(),
      checksum: checksum(content),
    };
  }
}

function checksum(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
