import { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { deepMerge } from './utils';
import { mainSchema } from './schema';

/**
 * Configuration validation error
 */
export interface ConfigValidationError {
  path: string;
  message: string;
  schema: JSONSchema7Definition;
  value: any;
}

/**
 * Configuration validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: string[];
  data: any;
}

/**
 * Schema validator using native JavaScript validation
 */
export class ConfigValidator {
  private schema: JSONSchema7;

  constructor(schema?: any) {
    this.schema = schema || mainSchema;
  }

  /**
   * Validate configuration data against schema
   */
  validate(data: any): ValidationResult {
    const errors: ConfigValidationError[] = [];
    const warnings: string[] = [];
    
    if (!data || typeof data !== 'object') {
      errors.push({
        path: '',
        message: 'Configuration must be an object',
        schema: this.schema,
        value: data,
      });
      return { valid: false, errors, warnings, data: {} };
    }

    // Validate each property according to schema
    this.validateObject(data, this.schema, '', errors);

    // Check required fields
    this.checkRequired(data, this.schema, '', errors);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      data,
    };
  }

  /**
   * Validate object against schema properties
   */
  private validateObject(
    data: any,
    schema: JSONSchema7,
    path: string,
    errors: ConfigValidationError[]
  ): void {
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const propPath = path ? `${path}.${key}` : key;
        const value = data[key];

        if (value === undefined || value === null) {
          // Check for default values
          if ((propSchema as JSONSchema7).default !== undefined) {
            data[key] = (propSchema as JSONSchema7).default;
          }
          continue;
        }

        this.validateType(value, propSchema as JSONSchema7, propPath, errors);
        
        // Recurse into nested objects
        if (propSchema && typeof propSchema === 'object' && (propSchema as JSONSchema7).type === 'object') {
          this.validateObject(value, propSchema as JSONSchema7, propPath, errors);
        }
      }
    }
  }

  /**
   * Validate value type matches schema
   */
  private validateType(
    value: any,
    schema: JSONSchema7,
    path: string,
    errors: ConfigValidationError[]
  ): void {
    const type = schema.type as string;

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
        errors.push({
          path,
          message: `Expected array, got ${typeof value}`,
          schema,
          value,
        });
      } else if (schema.items) {
        value.forEach((item: any, index: number) => {
          this.validateType(item, schema.items as JSONSchema7, `${path}[${index}]`, errors);
        });
      }
    } else if (type === 'string') {
      if (typeof value !== 'string') {
        errors.push({
          path,
          message: `Expected string, got ${typeof value}`,
          schema,
          value,
        });
      }
      // Validate pattern if present
      if (schema.pattern && typeof value === 'string') {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(value)) {
          errors.push({
            path,
            message: `Value "${value}" does not match pattern ${schema.pattern}`,
            schema,
            value,
          });
        }
      }
    } else if (type === 'integer' || type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({
          path,
          message: `Expected ${type}, got ${typeof value}`,
          schema,
          value,
        });
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
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push({
          path,
          message: `Expected boolean, got ${typeof value}`,
          schema,
          value,
        });
      }
    } else if (type === 'enum') {
      if (!schema.enum?.includes(value)) {
        errors.push({
          path,
          message: `Value "${value}" not in enum [${schema.enum?.join(', ')}]`,
          schema,
          value,
        });
      }
    }
  }

  /**
   * Check for required fields
   */
  private checkRequired(
    data: any,
    schema: JSONSchema7,
    path: string,
    errors: ConfigValidationError[]
  ): void {
    if (schema.required && Array.isArray(schema.required)) {
      for (const requiredField of schema.required) {
        const fieldPath = path ? `${path}.${requiredField}` : requiredField;
        if (data[requiredField] === undefined) {
          errors.push({
            path: fieldPath,
            message: `Missing required field`,
            schema: {},
            value: undefined,
          });
        }
      }
    }
  }
}

/**
 * Deep merge configuration objects
 * Later sources override earlier ones
 */
export function mergeConfigs(...configs: any[]): any {
  return deepMerge(...configs);
}

/**
 * Normalize environment variable names to config keys
 */
export function normalizeEnvKey(key: string): string {
  // Convert VERINODE_DB_HOST to db.host
  const match = key.match(/^VERINODE_([A-Z_]+)$/);
  if (!match) return key.toLowerCase();
  
  const parts = match[1].split('_');
  
  // Join the parts matching the key suffix
  const nestedKey = parts.join('.');
  return nestedKey.toLowerCase();
}

/**
 * Flatten config object to env var format
 */
export function flattenToEnv(config: any, prefix = 'VERINODE'): Record<string, string> {
  const result: Record<string, string> = {};
  
  function flatten(obj: any, currentPrefix: string): void {
    if (obj === null || typeof obj !== 'object') {
      result[currentPrefix] = String(obj);
      return;
    }
    
    for (const [key, value] of Object.entries(obj)) {
      const newPrefix = `${currentPrefix}_${key.toUpperCase()}`;
      if (value === null || typeof value !== 'object') {
        result[newPrefix] = String(value);
      } else {
        flatten(value, newPrefix);
      }
    }
  }
  
  flatten(config, prefix);
  return result;
}
