import { flattenConfig, computeHashFromFlattened, keyMatchesPrefix } from './flatten';
import { DriftCategory, DriftFinding, DriftReport, DriftSeverity } from './types';

// ── Default prefix sets ───────────────────────────────────────────────────────

/** Keys under these prefixes are CRITICAL (security-relevant). */
export const DEFAULT_CRITICAL_PREFIXES: string[] = ['db', 'mtls', 'tls', 'auth', 'staking'];

/** Keys under these prefixes are WARNING (performance-relevant). */
export const DEFAULT_WARNING_PREFIXES: string[] = [
  'capacity_shedding',
  'performance',
  'telemetry',
];

// ── Severity classification ───────────────────────────────────────────────────

/**
 * Classify a flattened key path into a DriftSeverity.
 *
 * @param key          - dot-separated flattened key, e.g. "db.host"
 * @param criticalPfx  - prefixes that map to 'critical'
 * @param warningPfx   - prefixes that map to 'warning'
 */
export function classifyKey(
  key: string,
  criticalPfx: string[] = DEFAULT_CRITICAL_PREFIXES,
  warningPfx: string[] = DEFAULT_WARNING_PREFIXES,
): DriftSeverity {
  for (const pfx of criticalPfx) {
    if (keyMatchesPrefix(key, pfx)) return 'critical';
  }
  for (const pfx of warningPfx) {
    if (keyMatchesPrefix(key, pfx)) return 'warning';
  }
  return 'info';
}

// ── Raw-value type extraction (works on unflattened objects) ──────────────────

/**
 * Dig a raw value out of the original (unflattened) config object using a
 * dot-separated key path. Returns `undefined` when the path does not exist.
 */
function getRawValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ── Diff computation ──────────────────────────────────────────────────────────

export interface DriftDiffInput {
  runtimeConfig: unknown;
  runtimeFlattened?: Record<string, string>;
  baselineFlattened: Record<string, string>;
  baselineHash: string;
  snapshotId: string;
  /** Optional: original (un-flattened) baseline config for raw value extraction. */
  baselineConfig?: unknown;
  criticalKeyPrefixes?: string[];
  warningKeyPrefixes?: string[];
}

export function diffFlattenedConfigs(params: {
  runtimeFlattened: Record<string, string>;
  baselineFlattened: Record<string, string>;
  runtimeConfig?: unknown;
  baselineConfig?: unknown;
  criticalKeyPrefixes?: string[];
  warningKeyPrefixes?: string[];
}): { findings: DriftFinding[] } {
  const {
    runtimeFlattened,
    baselineFlattened,
    runtimeConfig,
    baselineConfig,
    criticalKeyPrefixes = DEFAULT_CRITICAL_PREFIXES,
    warningKeyPrefixes = DEFAULT_WARNING_PREFIXES,
  } = params;

  const baselineKeys = new Set(Object.keys(baselineFlattened));
  const runtimeKeys = new Set(Object.keys(runtimeFlattened));

  const findings: DriftFinding[] = [];

  // ── Added keys ──────────────────────────────────────────────────────────────
  for (const k of runtimeKeys) {
    if (!baselineKeys.has(k)) {
      const severity = classifyKey(k, criticalKeyPrefixes, warningKeyPrefixes);
      findings.push({
        category: 'key_added',
        severity,
        key: k,
        runtimeValue: getRawValue(runtimeConfig, k) ?? runtimeFlattened[k],
      });
    }
  }

  // ── Removed keys ────────────────────────────────────────────────────────────
  for (const k of baselineKeys) {
    if (!runtimeKeys.has(k)) {
      const severity = classifyKey(k, criticalKeyPrefixes, warningKeyPrefixes);
      findings.push({
        category: 'key_removed',
        severity,
        key: k,
        baselineValue: getRawValue(baselineConfig, k) ?? baselineFlattened[k],
      });
    }
  }

  // ── Changed keys (value_change + type_change) ──────────────────────────────
  for (const k of runtimeKeys) {
    if (!baselineKeys.has(k)) continue;

    const bStr = baselineFlattened[k];
    const rStr = runtimeFlattened[k];

    const bRaw = getRawValue(baselineConfig, k);
    const rRaw = getRawValue(runtimeConfig, k);

    // Determine types from raw values when available, else from flattened strings.
    const bType = bRaw !== undefined ? typeof bRaw : 'string';
    const rType = rRaw !== undefined ? typeof rRaw : 'string';

    // Use raw values for comparison when available; fall back to flattened strings.
    const bEffective = bRaw !== undefined ? bRaw : bStr;
    const rEffective = rRaw !== undefined ? rRaw : rStr;

    const typesChanged = bType !== rType && bType !== 'undefined' && rType !== 'undefined';

    // Detect if anything actually changed:
    //   - Flattened strings differ, OR
    //   - Raw values differ (catches number 3000 vs string "3000" when flatten is same), OR
    //   - Types differ even if stringified representation is equal.
    const valuesChanged = bStr !== rStr || bEffective !== rEffective || typesChanged;
    if (!valuesChanged) continue;

    const severity = classifyKey(k, criticalKeyPrefixes, warningKeyPrefixes);

    if (typesChanged) {
      // Type changed — report as type_change (supersedes value_change)
      findings.push({
        category: 'type_change',
        severity,
        key: k,
        baselineValue: bEffective,
        runtimeValue: rEffective,
        baselineType: bType,
        runtimeType: rType,
      });
    } else {
      findings.push({
        category: 'value_change',
        severity,
        key: k,
        baselineValue: bEffective,
        runtimeValue: rEffective,
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
    runtimeConfig: input.runtimeConfig,
    baselineConfig: input.baselineConfig,
    criticalKeyPrefixes: input.criticalKeyPrefixes,
    warningKeyPrefixes: input.warningKeyPrefixes,
  });

  const endedAt = Date.now();

  const categoryOrder: Record<DriftCategory, number> = {
    type_change: 0,
    value_change: 1,
    key_added: 2,
    key_removed: 3,
  };

  const sortedFindings = [...findings].sort((a, b) => {
    const oa = categoryOrder[a.category] ?? 99;
    const ob = categoryOrder[b.category] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.key.localeCompare(b.key);
  });

  const summary = {
    total: sortedFindings.length,
    valueChanges: sortedFindings.filter((f) => f.category === 'value_change').length,
    keyAdded: sortedFindings.filter((f) => f.category === 'key_added').length,
    keyRemoved: sortedFindings.filter((f) => f.category === 'key_removed').length,
    typeChanges: sortedFindings.filter((f) => f.category === 'type_change').length,
    criticalCount: sortedFindings.filter((f) => f.severity === 'critical').length,
    warningCount: sortedFindings.filter((f) => f.severity === 'warning').length,
  };

  return {
    snapshotId: input.snapshotId,
    startedAt,
    endedAt,
    runtimeHash,
    baselineHash: input.baselineHash,
    findings: sortedFindings,
    summary,
  };
}

/**
 * Return the first critical prefix that matches any finding, or undefined.
 */
export function pickCriticalPrefix(
  policyPrefixes: string[],
  findings: DriftFinding[],
): string | undefined {
  for (const f of findings) {
    for (const prefix of policyPrefixes) {
      if (keyMatchesPrefix(f.key, prefix)) return prefix;
    }
  }
  return undefined;
}

/**
 * Return the first warning prefix that matches any finding, or undefined.
 */
export function pickWarningPrefix(
  policyPrefixes: string[],
  findings: DriftFinding[],
): string | undefined {
  return pickCriticalPrefix(policyPrefixes, findings);
}
