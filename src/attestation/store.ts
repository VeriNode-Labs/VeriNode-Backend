import { PoolClient } from 'pg';
import { Database } from '../config/database';

export interface PendingAttestation {
  id: string;
  node_id: string;
  validator_id: string;
  attested_at: Date;
}

export class AttestationStore {
  constructor(private db: Database) {}

  /**
   * Claim up to `limit` unprocessed attestations for a worker using
   * SELECT ... FOR UPDATE SKIP LOCKED so concurrent workers never
   * claim the same row. Must run inside a transaction (see
   * Database.transaction) — the "processing" status is only released
   * by commit/rollback of the caller's transaction.
   */
  async assignWork(client: PoolClient, limit: number): Promise<PendingAttestation[]> {
    const claimed = await client.query<PendingAttestation>(
      `SELECT id, node_id, validator_id, attested_at
       FROM attestations
       WHERE status = 'pending'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit],
    );

    if (claimed.rows.length === 0) {
      return [];
    }

    const ids = claimed.rows.map((row) => row.id);
    await client.query(`UPDATE attestations SET status = 'processing' WHERE id = ANY($1::bigint[])`, [
      ids,
    ]);

    return claimed.rows;
  }

  async markProcessed(client: PoolClient, attestationId: string): Promise<void> {
    await client.query(`UPDATE attestations SET status = 'processed' WHERE id = $1`, [
      attestationId,
    ]);
  }

  /**
   * Atomically advance last_attestation_time to the max of its current
   * value and `attestedAt`. GREATEST() ignores NULL arguments (only
   * returns NULL if every argument is NULL), so this is also safe on a
   * node's very first attestation. This is what makes the update order-
   * independent: whichever worker writes T1/T2/T3 last, the column can
   * only move forward, never backward.
   */
  async advanceLastAttestationTime(
    client: PoolClient,
    nodeId: string,
    attestedAt: Date,
  ): Promise<Date> {
    const result = await client.query<{ last_attestation_time: Date }>(
      `UPDATE nodes
       SET last_attestation_time = GREATEST(last_attestation_time, $2)
       WHERE id = $1
       RETURNING last_attestation_time`,
      [nodeId, attestedAt],
    );

    if (result.rows.length === 0) {
      throw new Error(`Node ${nodeId} not found in nodes table`);
    }

    return result.rows[0].last_attestation_time;
  }

  async ensureNode(client: PoolClient, nodeId: string): Promise<void> {
    await client.query(`INSERT INTO nodes (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [nodeId]);
  }

  async getLastAttestationTime(nodeId: string): Promise<Date | null> {
    const result = await this.db.query<{ last_attestation_time: Date | null }>(
      `SELECT last_attestation_time FROM nodes WHERE id = $1`,
      [nodeId],
    );
    return result.rows[0]?.last_attestation_time ?? null;
  }
}
