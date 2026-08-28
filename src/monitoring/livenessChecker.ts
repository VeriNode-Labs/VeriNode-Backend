import { Database } from '../config/database';

export const LIVENESS_THRESHOLD_HOURS = 48;

export interface StaleNode {
  id: string;
  lastAttestationTime: Date | null;
}

/**
 * Returns nodes whose last_attestation_time is older than the liveness
 * threshold (or NULL, meaning no attestation has ever been recorded).
 * Relies on last_attestation_time being monotonic (see
 * AttestationStore.advanceLastAttestationTime) so a false "stale" alert
 * can't be triggered by an out-of-order worker write.
 */
export async function findStaleNodes(
  db: Database,
  thresholdHours: number = LIVENESS_THRESHOLD_HOURS,
): Promise<StaleNode[]> {
  const result = await db.query<{ id: string; last_attestation_time: Date | null }>(
    `SELECT id, last_attestation_time
     FROM nodes
     WHERE last_attestation_time IS NULL
        OR last_attestation_time < NOW() - ($1 || ' hours')::INTERVAL`,
    [thresholdHours],
  );

  return result.rows.map((row) => ({ id: row.id, lastAttestationTime: row.last_attestation_time }));
}

export function isStale(
  lastAttestationTime: Date | null,
  now: Date = new Date(),
  thresholdHours: number = LIVENESS_THRESHOLD_HOURS,
): boolean {
  if (!lastAttestationTime) return true;
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  return now.getTime() - lastAttestationTime.getTime() > thresholdMs;
}
