/**
 * Deep merge multiple objects
 * Later sources override earlier ones
 */
export function deepMerge(...sources: any[]): any {
  const result: any = {};

  for (const source of sources) {
    if (source === null || typeof source !== 'object') {
      continue;
    }

    for (const key of Object.keys(source)) {
      const sourceValue = source[key];
      const destValue = result[key];

      if (
        isObject(sourceValue) &&
        isObject(destValue) &&
        !Array.isArray(sourceValue) &&
        !Array.isArray(destValue)
      ) {
        result[key] = deepMerge(destValue, sourceValue);
      } else {
        result[key] = sourceValue;
      }
    }
  }

  return result;
}

/**
 * Check if value is a plain object
 */
function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse environment variable to appropriate type
 */
export function parseEnvValue(value: string | undefined, targetType: 'string' | 'number' | 'boolean' | 'array'): any {
  if (value === undefined) return undefined;

  switch (targetType) {
    case 'number':
      return Number(value);
    case 'boolean':
      return ['true', '1', 'yes'].includes(value.toLowerCase());
    case 'array':
      return value.split(',').map((v) => v.trim()).filter(Boolean);
    default:
      return value;
  }
}

/**
 * Read nested property from object safely
 */
export function getIn(obj: any, path: string | string[], defaultValue?: any): any {
  const keys = Array.isArray(path) ? path : path.split('.');
  let current: any = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return defaultValue;
    }
    current = current[key];
  }

  return current !== undefined ? current : defaultValue;
}

/**
 * Set nested property in object
 */
export function setIn(obj: any, path: string | string[], value: any): any {
  const keys = Array.isArray(path) ? path : path.split('.');
  let current: any = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null) {
      current[key] = {};
    }
    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * Delete nested property from object
 */
export function deleteIn(obj: any, path: string | string[]): boolean {
  const keys = Array.isArray(path) ? path : path.split('.');
  if (keys.length === 0) return false;

  const lastKey = keys.pop();
  if (!lastKey) return false;

  const parent = getIn(obj, keys);
  if (parent === undefined || parent === null) return false;

  if (Array.isArray(parent)) {
    const index = Number(lastKey);
    if (isNaN(index) || index < 0 || index >= parent.length) return false;
    parent.splice(index, 1);
    return true;
  }

  if (typeof parent === 'object' && parent !== null) {
    delete parent[lastKey];
    return true;
  }

  return false;
}

/**
 * Clone object deeply
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item)) as any;
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = deepClone(value);
  }
  return result;
}

/**
 * Format error path for display
 */
export function formatErrorPath(path: string): string {
  if (!path) return '(root)';
  return path.replace(/\./g, ' → ');
}
