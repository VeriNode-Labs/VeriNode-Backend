import { getConfigValue, onChangePath } from '../../config';

export type FeatureFlagStatus = 'enabled' | 'disabled' | 'degraded';

export interface FeatureFlag {
  key: string;
  description: string;
  defaultStatus: FeatureFlagStatus;
  dependencies?: string[];
  owner?: string;
}

export type FeatureFlagChangeCallback = (
  key: string,
  status: FeatureFlagStatus,
  oldStatus: FeatureFlagStatus,
) => void;

const FLAG_REGISTRY = new Map<string, FeatureFlag>();
const FLAG_CACHE = new Map<string, FeatureFlagStatus>();
const CHANGE_LISTENERS = new Map<string, Set<FeatureFlagChangeCallback>>();
let initialized = false;

function getFlagFromConfig(key: string): FeatureFlagStatus | null {
  const flagConfig = getConfigValue(`feature_flags.overrides.${key}`);
  if (flagConfig === 'enabled') return 'enabled';
  if (flagConfig === 'disabled') return 'disabled';
  if (flagConfig === 'degraded') return 'degraded';
  return null;
}

export function registerFlag(flag: FeatureFlag): void {
  FLAG_REGISTRY.set(flag.key, flag);
}

export function registerFlags(flags: FeatureFlag[]): void {
  for (const flag of flags) {
    registerFlag(flag);
  }
}

export function initFeatureFlags(): void {
  if (initialized) return;
  const flagOverrides = getConfigValue('feature_flags.overrides');
  if (flagOverrides && typeof flagOverrides === 'object') {
    for (const key of Object.keys(flagOverrides)) {
      const flag = FLAG_REGISTRY.get(key);
      if (flag) {
        const status = getFlagFromConfig(key);
        if (status) {
          FLAG_CACHE.set(key, status);
        }
      }
    }
  }
  for (const [key, flag] of FLAG_REGISTRY) {
    if (!FLAG_CACHE.has(key)) {
      FLAG_CACHE.set(key, flag.defaultStatus);
    }
  }
  onChangePath('feature_flags', () => {
    for (const [key, flag] of FLAG_REGISTRY) {
      const oldStatus = getStatus(key);
      const newStatus = getFlagFromConfig(key) || flag.defaultStatus;
      if (oldStatus !== newStatus) {
        FLAG_CACHE.set(key, newStatus);
        notifyListeners(key, newStatus, oldStatus);
      }
    }
  });
  initialized = true;
}

export function getStatus(key: string): FeatureFlagStatus {
  const cached = FLAG_CACHE.get(key);
  if (cached) return cached;
  const flag = FLAG_REGISTRY.get(key);
  if (!flag) return 'disabled';
  const override = getFlagFromConfig(key);
  const status = override || flag.defaultStatus;
  FLAG_CACHE.set(key, status);
  return status;
}

export function isEnabled(key: string): boolean {
  const status = getStatus(key);
  if (status === 'enabled') return true;
  if (status === 'degraded') {
    const flag = FLAG_REGISTRY.get(key);
    if (flag && flag.dependencies) {
      for (const dep of flag.dependencies) {
        if (!isEnabled(dep)) return false;
      }
    }
    return true;
  }
  return false;
}

export function setOverride(key: string, status: FeatureFlagStatus): boolean {
  const flag = FLAG_REGISTRY.get(key);
  if (!flag) return false;
  const oldStatus = getStatus(key);
  FLAG_CACHE.set(key, status);
  if (oldStatus !== status) {
    notifyListeners(key, status, oldStatus);
  }
  return true;
}

export function resetOverride(key: string): boolean {
  const flag = FLAG_REGISTRY.get(key);
  if (!flag) return false;
  const oldStatus = getStatus(key);
  FLAG_CACHE.delete(key);
  const newStatus = getStatus(key);
  if (oldStatus !== newStatus) {
    notifyListeners(key, newStatus, oldStatus);
  }
  return true;
}

export function onFeatureFlagChange(key: string, callback: FeatureFlagChangeCallback): () => void {
  if (!CHANGE_LISTENERS.has(key)) {
    CHANGE_LISTENERS.set(key, new Set());
  }
  CHANGE_LISTENERS.get(key)!.add(callback);
  return () => {
    CHANGE_LISTENERS.get(key)?.delete(callback);
  };
}

function notifyListeners(
  key: string,
  newStatus: FeatureFlagStatus,
  oldStatus: FeatureFlagStatus,
): void {
  const listeners = CHANGE_LISTENERS.get(key);
  if (listeners) {
    for (const cb of listeners) {
      try {
        cb(key, newStatus, oldStatus);
      } catch {
        // isolate listener failures
      }
    }
  }
}

export function getRegisteredFlags(): FeatureFlag[] {
  return Array.from(FLAG_REGISTRY.values());
}

export function resetForTest(): void {
  FLAG_REGISTRY.clear();
  FLAG_CACHE.clear();
  CHANGE_LISTENERS.clear();
  initialized = false;
}
