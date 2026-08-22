import { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { deepClone, deepMerge } from './utils';
import { mainSchema } from './schema';

export interface ConfigValidationError {
  path: string;
  message: string;
  schema: JSONSchema7Definition;
  value: any;
}

export interface ValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: string[];
  data: any;
}

export class ConfigValidator {
  private schema: JSONSchema7;

  constructor(schema?: any) {
    this.schema = schema || mainSchema;
  }

  validate(data: any): ValidationResult {
    const errors: ConfigValidationError[] = [];
    const warnings: string[] = [];

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      errors.push({
        path: '',
        message: 'Configuration must be an object',
        schema: this.schema,
        value: data,
      });
      return { valid: false, errors, warnings, data: {} };
    }

    const normalized = deepMerge({}, data);
    this.applyDefaults(normalized, this.schema);
    this.validateValue(normalized, this.schema, '', errors, warnings);

    return { valid: errors.length === 0, errors, warnings, data: normalized };
  }

  private applyDefaults(data: any, schema: JSONSchema7): void {
    if (!schema.properties || typeof data !== 'object' || data === null || Array.isArray(data))
      return;
    for (const [key, rawSchema] of Object.entries(schema.properties)) {
      const propSchema = rawSchema as JSONSchema7;
      if (data[key] === undefined && propSchema.default !== undefined) {
        data[key] = deepClone(propSchema.default);
      }
      if (data[key] !== undefined && propSchema.type === 'object') {
        if (typeof data[key] === 'object' && data[key] !== null && !Array.isArray(data[key])) {
          this.applyDefaults(data[key], propSchema);
        }
      }
    }
  }

  private validateValue(
    value: any,
    schema: JSONSchema7,
    path: string,
    errors: ConfigValidationError[],
    warnings: string[],
  ): void {
    this.validateType(value, schema, path, errors);
    if (errors.some((e) => e.path === path)) return;

    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({
        path,
        message: `Value "${value}" not in enum [${schema.enum.join(', ')}]`,
        schema,
        value,
      });
    }

    if (
      schema.type === 'object' &&
      schema.properties &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const propPath = path ? `${path}.${key}` : key;
        if (value[key] !== undefined) {
          this.validateValue(value[key], propSchema as JSONSchema7, propPath, errors, warnings);
        }
      }

      if (schema.required) {
        for (const requiredField of schema.required) {
          if (value[requiredField] === undefined) {
            const fieldPath = path ? `${path}.${requiredField}` : requiredField;
            errors.push({
              path: fieldPath,
              message: 'Missing required field',
              schema: {},
              value: undefined,
            });
          }
        }
      }

      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) {
            warnings.push(`${path ? `${path}.` : ''}${key}: unknown configuration key`);
          }
        }
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        for (const [key, propValue] of Object.entries(value)) {
          if (!allowed.has(key)) {
            const propPath = path ? `${path}.${key}` : key;
            this.validateValue(
              propValue,
              schema.additionalProperties as JSONSchema7,
              propPath,
              errors,
              warnings,
            );
          }
        }
      }
    }
  }

  private validateType(
    value: any,
    schema: JSONSchema7,
    path: string,
    errors: ConfigValidationError[],
  ): void {
    const type = schema.type as string | undefined;
    if (!type) return;

    if (type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value) || value === null) {
        errors.push({
          path,
          message: `Expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
          schema,
          value,
        });
      }
    } else if (type === 'array') {
      if (!Array.isArray(value)) {
        errors.push({ path, message: `Expected array, got ${typeof value}`, schema, value });
      } else if (schema.items) {
        value.forEach((item: any, index: number) =>
          this.validateValue(item, schema.items as JSONSchema7, `${path}[${index}]`, errors, []),
        );
      }
    } else if (type === 'string') {
      if (typeof value !== 'string') {
        errors.push({ path, message: `Expected string, got ${typeof value}`, schema, value });
      } else if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push({
          path,
          message: `Value "${value}" does not match pattern ${schema.pattern}`,
          schema,
          value,
        });
      } else if (schema.format === 'uri' && !this.isUri(value)) {
        errors.push({ path, message: `Value "${value}" is not a valid URI`, schema, value });
      } else if (schema.format === 'hostname' && value && !this.isHostname(value)) {
        errors.push({ path, message: `Value "${value}" is not a valid hostname`, schema, value });
      }
    } else if (type === 'integer' || type === 'number') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (type === 'integer' && !Number.isInteger(value))
      ) {
        errors.push({ path, message: `Expected ${type}, got ${typeof value}`, schema, value });
      } else if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push({
          path,
          message: `Value ${value} is less than minimum ${schema.minimum}`,
          schema,
          value,
        });
      } else if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push({
          path,
          message: `Value ${value} exceeds maximum ${schema.maximum}`,
          schema,
          value,
        });
      }
    } else if (type === 'boolean' && typeof value !== 'boolean') {
      errors.push({ path, message: `Expected boolean, got ${typeof value}`, schema, value });
    }
  }

  private isUri(value: string): boolean {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }

  private isHostname(value: string): boolean {
    return /^(https?:\/\/)?[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(value);
  }
}

export function mergeConfigs(...configs: Record<string, any>[]): Record<string, any> {
  return configs.reduce((merged, config) => deepMerge(merged, config), {});
}

export function normalizeEnvKey(key: string, prefix = 'VERINODE'): string {
  return key
    .replace(new RegExp(`^${prefix}_`), '')
    .toLowerCase()
    .replace(/__/g, '.')
    .replace(/_/g, '.');
}

export function flattenToEnv(
  config: Record<string, any>,
  prefix = 'VERINODE',
): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (obj: any, parts: string[]) => {
    for (const [key, value] of Object.entries(obj)) {
      const next = [...parts, key];
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, next);
      else
        result[[prefix, ...next].join('_').toUpperCase()] = Array.isArray(value)
          ? JSON.stringify(value)
          : String(value);
    }
  };
  walk(config, []);
  return result;
}
