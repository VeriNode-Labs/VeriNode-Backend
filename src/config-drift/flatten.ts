import { getIn } from '../config/utils';

/**
 * Flatten config object into dot-paths with deterministic serialization.
 *
 * - Arrays are represented with numeric indices: a.0.b
 * - Objects are represented recursively.
 *
 * This is used for drift comparison (added/removed keys + value changes).
 */
export function flattenConfig(
  obj: unknown,
  options?: { maxDepth?: number; currentDepth?: number },
): Record<string, string> {
  const maxDepth = options?.maxDepth ?? 64;
  const currentDepth = options?.currentDepth ?? 0;

  const out: Record<string, string> = {};

  function normalizeValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    // Stable JSON for objects/arrays.
    try {
      return stableStringify(value);
    } catch {
      return String(value);
    }
  }

  function visit(node: unknown, prefix: string, depth: number): void {
    if (depth > maxDepth) {
      out[prefix] = normalizeValue(node);
      return;
    }

    if (node === null || node === undefined) {
      out[prefix] = normalizeValue(node);
      return;
    }

    if (Array.isArray(node)) {
      if (node.length === 0) {
        out[prefix] = '[]';
        return;
      }
      for (let i = 0; i < node.length; i++) {
        const nextPrefix = prefix ? `${prefix}.${i}` : String(i);
        visit(node[i], nextPrefix, depth + 1);
      }
      return;
    }

    if (typeof node === 'object') {
      const keys = Object.keys(node as Record<string, unknown>).sort();
      if (keys.length === 0) {
        out[prefix] = '{}';
        return;
      }
      for (const k of keys) {
        const v = (node as any)[k];
        const nextPrefix = prefix ? `${prefix}.${k}` : k;
        visit(v, nextPrefix, depth + 1);
      }
      return;
    }

    // primitives
    out[prefix] = normalizeValue(node);
  }

  // Root
  if (obj === null || obj === undefined) {
    return { '': normalizeValue(obj) };
  }

  if (typeof obj !== 'object') {
    return { '': normalizeValue(obj) };
  }

  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const k of keys) {
    visit((obj as any)[k], k, currentDepth);
  }

  return out;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`);
  return `{${entries.join(',')}}`;
}

export function computeHashFromFlattened(flat: Record<string, string>): string {
  // Simple non-crypto-ish hash is enough for drift comparison.
  // We use djb2 over deterministic string of key/value pairs.
  const keys = Object.keys(flat).sort();
  let hash = 5381;
  for (const k of keys) {
    const s = `${k}=${flat[k]};`;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash) + s.charCodeAt(i);
      hash = hash >>> 0;
    }
  }
  return hash.toString(16);
}

/**
 * Helper to decide if a flattened key is within a prefix.
 * Example: prefix 'db' matches 'db.host' and 'db'
 */
export function keyMatchesPrefix(flatKey: string, prefix: string): boolean {
  if (!prefix) return false;
  return flatKey === prefix || flatKey.startsWith(prefix + '.');
}

/**
 * Get a value from flattened structure by prefix (debug use).
 */
export function getFlattenedPrefixValues(flat: Record<string, string>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = Object.keys(flat);
  for (const k of keys) {
    if (keyMatchesPrefix(k, prefix)) out[k] = flat[k];
  }
  return out;
}

