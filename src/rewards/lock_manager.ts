export const REWARD_LOCK_TIMEOUT_MS = 5000;

export class RewardLockTimeoutError extends Error {
  readonly code?: string;

  constructor(nodeId: string, cause?: unknown) {
    super(`Timed out acquiring reward distribution lock for node ${nodeId}`);
    this.name = 'RewardLockTimeoutError';
    this.code = typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code?: unknown }).code)
      : undefined;
  }
}

export function rewardLockName(nodeId: string): string {
  return `reward_cycle_${nodeId}`;
}

export function isLockTimeoutError(error: unknown): boolean {
  if (error instanceof RewardLockTimeoutError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown; message?: unknown };
  return err.code === '55P03' || (typeof err.message === 'string' && err.message.toLowerCase().includes('lock timeout'));
}

interface Queryable {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export async function acquireRewardNodeLock(
  client: Queryable,
  nodeId: string,
  timeoutMs = REWARD_LOCK_TIMEOUT_MS,
): Promise<void> {
  try {
    await client.query('SET LOCAL lock_timeout = $1', [`${timeoutMs}ms`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [rewardLockName(nodeId)]);
  } catch (error) {
    if (isLockTimeoutError(error)) {
      throw new RewardLockTimeoutError(nodeId, error);
    }
    throw error;
  }
}
