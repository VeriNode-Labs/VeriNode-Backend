import { flattenConfig, computeHashFromFlattened, keyMatchesPrefix } from './flatten';
import { DriftFinding, DriftReport } from './types';

export interface DriftDiffInput {
  runtimeConfig: unknown;
  runtimeFlattened?: Record<string, string>;
  baselineFlattened: Record<string, string>;
  baselineHash: string;
  snapshotId: string;
}

export function diffFlattenedConfigs(params: {
  runtimeFlattened: Record<string, string>;
  baselineFlattened: Record<string, string>;
}): { findings: DriftFinding[] } {
  const { runtimeFlattened, baselineFlattened } = params;

  const baselineKeys = new Set(Object.keys(baselineFlattened));
  const runtimeKeys = new Set(Object.keys(runtimeFlattened));

  const findings: DriftFinding[] = [];

  // Added keys
  for (const k of runtimeKeys) {
    if (!baselineKeys.has(k)) {
      findings.push({
        category: 'key_added',
        key: k,
        runtimeValue: runtimeFlattened[k],
      });
    }
  }

  // Removed keys
  for (const k of baselineKeys) {
    if (!runtimeKeys.has(k)) {
      findings.push({
        category: 'key_removed',
        key: k,
        baselineValue: baselineFlattened[k],
      });
    }
  }

  // Value changes
  for (const k of runtimeKeys) {
    if (!baselineKeys.has(k)) continue;
    const b = baselineFlattened[k];
    const r = runtimeFlattened[k];
    if (b !== r) {
      findings.push({
        category: 'value_change',
        key: k,
        baselineValue: b,
        runtimeValue: r,
      });
    }
  }

  return { findings };
}

export function computeDriftReport(input: DriftDiffInput): DriftReport {
  const startedAt = Date.now();
  const runtimeFlattened = input.runtimeFlattened ?? flattenConfig(input.runtimeConfig);
  const runtimeHash = computeHashFromFlattened(runtimeFlattened);

  const { findings } = diffFlattenedConfigs({
    runtimeFlattened,
    baselineFlattened: input.baselineFlattened,
  });

  const endedAt = Date.now();

  const summary = {
    total: findings.length,
    valueChanges: findings.filter((f) => f.category === 'value_change').length,
    keyAdded: findings.filter((f) => f.category === 'key_added').length,
    keyRemoved: findings.filter((f) => f.category === 'key_removed').length,
  };

  return {
    snapshotId: input.snapshotId,
    startedAt,
    endedAt,
    runtimeHash,
    baselineHash: input.baselineHash,
    findings: findings.sort((a, b) => {
      // deterministic ordering
      const ord: Record<string, number> = {
        value_change: 1,
        key_added: 2,
        key_removed: 3,
      };
      const oa = ord[a.category] ?? 99;
      const ob = ord[b.category] ?? 99;
      if (oa !== ob) return oa - ob;
      return a.key.localeCompare(b.key);
    }),
    summary,
  };
}

export function pickCriticalPrefix(policyPrefixes: string[], findings: DriftFinding[]): string | undefined {
  for (const f of findings) {
    for (const prefix of policyPrefixes) {
      if (keyMatchesPrefix(f.key, prefix)) return prefix;
    }
  }
  return undefined;
}

