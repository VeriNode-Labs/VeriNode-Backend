/**
 * Typed surface for the Soroban "verification" contract's persistent
 * storage keys. These are the 5 critical per-node keys that must never
 * be allowed to expire (archive) — losing any of them forces a full
 * node re-registration (see issue #20).
 */

export type CriticalDataKey =
  | 'attestation_root'
  | 'node_registry_hash'
  | 'reward_cycle_counter'
  | 'metadata_hash'
  | 'governance_weight';

export const CRITICAL_DATA_KEYS: CriticalDataKey[] = [
  'attestation_root',
  'node_registry_hash',
  'reward_cycle_counter',
  'metadata_hash',
  'governance_weight',
];

/** Default TTL assigned to a fresh ledger entry, in ledgers (~16.7h @ 6s/ledger). */
export const DEFAULT_TTL_LEDGERS = 10_000;

/** Approximate instructions consumed extending the TTL of a single data entry. */
export const TTL_EXTENSION_INSTRUCTIONS = 5_000;

/** Max number of data-key entries that can be renewed in a single batched tx. */
export const MAX_BATCH_TTL_ENTRIES = 20;

/** Renew once remaining TTL drops below this many ledgers (~3.3h @ 6s/ledger). */
export const RENEWAL_THRESHOLD_LEDGERS = 2_000;

export interface ContractDataPointer {
  contractId: string;
  dataKey: CriticalDataKey;
}

/**
 * Builds the contract/data-key pairs that must be watched for a given
 * verification node. One pointer per critical key.
 */
export function buildWatchedPointers(contractId: string): ContractDataPointer[] {
  return CRITICAL_DATA_KEYS.map((dataKey) => ({ contractId, dataKey }));
}
