export interface SlashingTx {
  validatorId: string;
  misbehaviorType: string;
  evidence: string;
  signature: string;
}

export interface SlashingResult {
  validatorId: string;
  nonce: bigint;
  txHash: string;
  success: boolean;
  error?: string;
}

export interface SlashingAgentConfig {
  maxConcurrentWorkers: number;
  nonceRangeLimit: bigint;
}

export interface SlashingAgent {
  onSlashingRequest(tx: SlashingTx): Promise<SlashingResult>;
  getMetrics(): SlashingMetrics;
}

export interface SlashingMetrics {
  totalSubmitted: number;
  totalConfirmed: number;
  totalFailed: number;
  currentNonce: string;
  pendingCount: number;
}
