import { PoolClient } from 'pg';
import { AttestationStore, PendingAttestation } from './store';
import { ReputationStore } from '../reputation/store';
import { createLogger } from '../diagnostics/logger';

const log = createLogger('attestation-worker');

export const ATTESTATION_REWARD_DELTA = 10;

export interface ProcessOneResult {
  attestationId: string;
  nodeId: string;
  newScore: number;
  lastAttestationTime: Date;
}

/**
 * Process a single claimed attestation within an already-open transaction
 * (the same one assignWork() claimed it in). Applies the reputation
 * reward and advances last_attestation_time atomically via GREATEST(),
 * so this is safe to call from multiple workers on rows for the same
 * node without producing a stale/out-of-order timestamp.
 */
export async function processOne(
  client: PoolClient,
  attestationStore: AttestationStore,
  reputationStore: ReputationStore,
  attestation: PendingAttestation,
): Promise<ProcessOneResult> {
  const newScore = await reputationStore.applyRewardWithLock(
    client,
    attestation.node_id,
    ATTESTATION_REWARD_DELTA,
  );

  const lastAttestationTime = await attestationStore.advanceLastAttestationTime(
    client,
    attestation.node_id,
    attestation.attested_at,
  );

  await attestationStore.markProcessed(client, attestation.id);

  log.info('Attestation processed', {
    attestation_id: attestation.id,
    node_id: attestation.node_id,
    validator_id: attestation.validator_id,
    new_score: newScore,
  });

  return {
    attestationId: attestation.id,
    nodeId: attestation.node_id,
    newScore,
    lastAttestationTime,
  };
}
