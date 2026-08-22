import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MigrationManager } from '../../src/database/migration_manager';

class MemoryClient {
  public readonly queries: Array<{ sql: string; params?: unknown[] }> = [];
  public readonly activeVersions = new Set<string>();

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    if (sql.startsWith('SELECT version FROM schema_migrations')) {
      return { rows: Array.from(this.activeVersions).map((version) => ({ version })) as T[] };
    }
    if (sql.includes('WHERE rolled_back_at IS NULL AND version > $1')) {
      const target = String(params?.[0]);
      return {
        rows: Array.from(this.activeVersions)
          .filter((version) => version > target)
          .sort()
          .reverse()
          .map((version) => ({
            version,
            name: `${version}_test`,
            checksum: 'hash',
            appliedAt: new Date(),
            executionMs: 1,
          })) as T[],
      };
    }
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      this.activeVersions.add(String(params?.[0]));
    }
    if (sql.startsWith('UPDATE schema_migrations SET rolled_back_at')) {
      this.activeVersions.delete(String(params?.[0]));
    }
    return { rows: [] };
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'verinode-migrations-'));
  try {
    writeFileSync(
      join(dir, '001_create_users.sql'),
      '-- @up\nCREATE TABLE users(id INT);\n-- @down\nDROP TABLE users;\n',
    );
    writeFileSync(
      join(dir, '002_add_email.sql'),
      '-- @up\nALTER TABLE users ADD COLUMN email TEXT;\n-- @down\nALTER TABLE users DROP COLUMN email;\n',
    );

    const events: string[] = [];
    const client = new MemoryClient();
    const manager = new MigrationManager(client, dir, (event) =>
      events.push(`${event.type}:${event.version}`),
    );

    const pending = await manager.pending();
    assert.deepEqual(
      pending.map((migration) => migration.version),
      ['001', '002'],
    );

    const applied = await manager.migrate('001');
    assert.equal(applied.length, 1);
    assert(client.queries.some((query) => query.sql.includes('CREATE TABLE users')));
    assert(client.activeVersions.has('001'));
    assert(events.includes('migration_completed:001'));

    const remaining = await manager.pending();
    assert.deepEqual(
      remaining.map((migration) => migration.version),
      ['002'],
    );

    await manager.migrate();
    const rolledBack = await manager.rollback('000');
    assert.deepEqual(
      rolledBack.map((migration) => migration.version),
      ['002', '001'],
    );
    assert(
      client.queries.some((query) => query.sql.includes('ALTER TABLE users DROP COLUMN email')),
    );
    assert(client.queries.some((query) => query.sql.includes('DROP TABLE users')));
    assert.equal(client.activeVersions.size, 0);
    assert(events.includes('rollback_completed:002'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
