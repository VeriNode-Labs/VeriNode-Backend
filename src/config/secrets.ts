/**
 * Secret masking utilities for configuration values.
 *
 * Values whose key path matches /secret|password|key/i are masked in logs
 * and metrics so that secrets never leak through observability surfaces.
 */

const SECRET_KEY_PATTERN = /secret|password|key/i;

/** The replacement token used for masked values. */
export const MASKED_VALUE = '****';

/**
 * Check whether a config key path segment (or full dotted path) looks secret-like.
 */
export function isSecretKey(keyPath: string): boolean {
  if (!keyPath) return false;
  // Test each dot-separated segment as well as the whole path so that
  // e.g. "remote.etcd.password" and "keys.apiKey" are both caught.
  return keyPath.split('.').some((segment) => SECRET_KEY_PATTERN.test(segment));
}

/**
 * Return a deep copy of the config with all secret-like values masked.
 * Object structure is preserved; leaf values under secret keys become MASKED_VALUE.
 */
export function maskSecrets<T>(config: T): T {
  return maskValue(config, '') as T;
}

function maskValue(value: any, path: string): any {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item, i) => maskValue(item, path));
  }

  if (typeof value === 'object') {
    const result: any = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isSecretKey(key)) {
        result[key] = maskLeaf(child);
      } else {
        result[key] = maskValue(child, childPath);
      }
    }
    return result;
  }

  // Leaf value whose own path is secret-like
  if (isSecretKey(path)) {
    return MASKED_VALUE;
  }
  return value;
}

/**
 * Mask a leaf value. Objects/arrays under a secret key are fully masked too.
 */
function maskLeaf(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map(() => MASKED_VALUE);
    }
    const result: any = {};
    for (const key of Object.keys(value)) {
      result[key] = MASKED_VALUE;
    }
    return result;
  }
  return MASKED_VALUE;
}

/**
 * Format a config object for safe logging: secrets masked, truncated JSON.
 */
export function safeConfigForLog(config: any, maxLength = 2000): string {
  try {
    const masked = JSON.stringify(maskSecrets(config));
    if (masked.length <= maxLength) return masked;
    return masked.slice(0, maxLength) + '…(truncated)';
  } catch {
    return '[unserializable config]';
  }
}
