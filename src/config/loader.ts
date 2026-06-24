import * as fs from 'fs';
import * as path from 'path';
import { ConfigValidator, mergeConfigs, normalizeEnvKey } from './validator';
import { deepMerge, setIn, parseEnvValue } from './utils';
import { mainSchema } from './schema';

/**
 * Helper to find the actual case-sensitive property path in schema by case-insensitive key path matching
 */
function findActualPath(schema: any, path: string): string[] | null {
  const target = path.replace(/[\._]/g, '').toLowerCase();
  
  function search(currentSchema: any, currentPath: string[], targetStr: string): string[] | null {
    const currentStr = currentPath.join('').toLowerCase();
    if (currentStr === targetStr) {
      return currentPath;
    }
    if (!currentSchema || typeof currentSchema !== 'object' || !currentSchema.properties) {
      return null;
    }
    for (const key of Object.keys(currentSchema.properties)) {
      const result = search(currentSchema.properties[key], [...currentPath, key], targetStr);
      if (result) return result;
    }
    return null;
  }

  return search(schema, [], target);
}

/**
 * Helper to find the type of a dot-separated key path in a JSON Schema
 */
function getSchemaTypeForPath(schema: any, path: string): 'string' | 'number' | 'boolean' | 'array' | undefined {
  const keys = path.split('.');
  let current = schema;
  for (const key of keys) {
    if (!current) return undefined;
    if (current.properties && current.properties[key]) {
      current = current.properties[key];
    } else {
      return undefined;
    }
  }
  const type = current.type;
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') return 'array';
  if (type === 'string') return 'string';
  return undefined;
}

/**
 * Helper to get the end of a range for prefix-based queries in etcd
 */
function getRangeEnd(prefix: string): string {
  if (prefix.length === 0) return '\xff';
  const lastChar = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(lastChar + 1);
}

/**
 * Configuration sources with priority (lower index = higher priority)
 */
export interface ConfigSource {
  priority: number;
  load: () => Promise<Record<string, any>>;
  name: string;
}

/**
 * Configuration loader with support for multiple sources
 */
export class ConfigLoader {
  private sources: ConfigSource[] = [];
  private validator: ConfigValidator;
  private cache: Record<string, any> | null = null;

  constructor(schema?: any) {
    this.validator = new ConfigValidator(schema);
  }

  /**
   * Add a configuration source
   */
  addSource(source: ConfigSource): this {
    // Insert in priority order
    const index = this.sources.findIndex(s => s.priority > source.priority);
    if (index === -1) {
      this.sources.push(source);
    } else {
      this.sources.splice(index, 0, source);
    }
    this.cache = null;
    return this;
  }

  /**
   * Add environment source
   */
  addEnvironmentSource(prefix = 'VERINODE'): this {
    return this.addSource({
      priority: 10,
      name: 'environment',
      load: () => this.loadEnvironment(prefix),
    });
  }

  /**
   * Load environment variables into config format
   */
  private loadEnvironment(prefix: string): Promise<Record<string, any>> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix + '_')) {
        const configKey = normalizeEnvKey(key);
        const schema = this.validator['schema'] || mainSchema;
        
        const actualPath = findActualPath(schema, configKey);
        const targetPath = actualPath ? actualPath.join('.') : configKey;
        const targetType = getSchemaTypeForPath(schema, targetPath);
        
        let parsedValue: any = value;
        if (targetType) {
          parsedValue = parseEnvValue(value, targetType);
        } else {
          if (value === 'true' || value === 'false') {
            parsedValue = value === 'true';
          } else if (value && !isNaN(Number(value)) && Number.isFinite(Number(value))) {
            parsedValue = Number(value);
          }
        }
        
        if (actualPath) {
          setIn(result, actualPath, parsedValue);
        } else {
          setIn(result, configKey, parsedValue);
        }
      }
    }

    return Promise.resolve(result);
  }

  /**
   * Add file source
   */
  addFileSource(filePath: string): this {
    return this.addSource({
      priority: 20,
      name: `file:${filePath}`,
      load: () => this.loadFile(filePath),
    });
  }

  /**
   * Load configuration from JSON file
   */
  private async loadFile(filePath: string): Promise<Record<string, any>> {
    try {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      const content = fs.readFileSync(absolutePath, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      // File might not exist, which is OK for optional sources
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw new Error(`Failed to load config file ${filePath}: ${(err as Error).message}`);
    }
  }

  /**
   * Add remote source (placeholder for etcd/consul)
   */
  addRemoteSource(type: 'etcd' | 'consul', options?: any): this {
    return this.addSource({
      priority: 5, // High priority, overrides Env and File
      name: `remote:${type}`,
      load: () => this.loadRemote(type, options),
    });
  }

  /**
   * Load configuration from remote source
   */
  private async loadRemote(type: 'etcd' | 'consul', options?: any): Promise<Record<string, any>> {
    if (!options) return {};
    if (type === 'etcd') {
      return this.loadRemoteEtcd(options);
    } else if (type === 'consul') {
      return this.loadRemoteConsul(options);
    }
    return {};
  }

  private async loadRemoteEtcd(options: any): Promise<Record<string, any>> {
    const endpoints = options.endpoints || ['http://localhost:2379'];
    const keyPrefix = options.keyPrefix || 'verinode/config';
    
    const normalizedPrefix = keyPrefix.endsWith('/') ? keyPrefix : `${keyPrefix}/`;
    const rangeEnd = getRangeEnd(normalizedPrefix);
    
    const body = {
      key: Buffer.from(normalizedPrefix).toString('base64'),
      range_end: Buffer.from(rangeEnd).toString('base64')
    };

    let lastError: Error | null = null;
    for (const endpoint of endpoints) {
      try {
        const url = `${endpoint.replace(/\/$/, '')}/v3/kv/range`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000)
        });
        
        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }
        
        const data = (await response.json()) as any;
        const result: Record<string, any> = {};
        
        if (data.kvs && Array.isArray(data.kvs)) {
          for (const kv of data.kvs) {
            const fullKey = Buffer.from(kv.key, 'base64').toString('utf8');
            const valueStr = kv.value ? Buffer.from(kv.value, 'base64').toString('utf8') : '';
            
            let relativeKey = fullKey;
            if (fullKey.startsWith(normalizedPrefix)) {
              relativeKey = fullKey.substring(normalizedPrefix.length);
            }
            if (relativeKey.startsWith('/')) {
              relativeKey = relativeKey.substring(1);
            }
            if (!relativeKey) {
              try {
                const parsed = JSON.parse(valueStr);
                if (parsed && typeof parsed === 'object') {
                  Object.assign(result, parsed);
                }
              } catch {
                // Ignore
              }
              continue;
            }
            
            const configPath = relativeKey.replace(/\//g, '.');
            let parsedVal: any = valueStr;
            try {
              parsedVal = JSON.parse(valueStr);
            } catch {
              // Keep as raw string
            }
            setIn(result, configPath, parsedVal);
          }
        }
        return result;
      } catch (err: any) {
        lastError = err;
        console.warn(`[Config] Failed to fetch from etcd endpoint ${endpoint}: ${err.message}`);
      }
    }
    
    throw lastError || new Error('All etcd endpoints failed');
  }

  private async loadRemoteConsul(options: any): Promise<Record<string, any>> {
    const address = options.address || 'localhost:8500';
    const keyPrefix = options.keyPrefix || 'verinode/config';
    const token = options.token;
    
    const normalizedPrefix = keyPrefix.endsWith('/') ? keyPrefix : `${keyPrefix}/`;
    const baseUrl = address.startsWith('http') ? address : `http://${address}`;
    const url = `${baseUrl.replace(/\/$/, '')}/v1/kv/${normalizedPrefix}?recurse=true`;
    
    const headers: Record<string, string> = {};
    if (token) {
      headers['X-Consul-Token'] = token;
    }
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000)
      });
      
      if (response.status === 404) {
        return {};
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }
      
      const kvs = (await response.json()) as any[];
      const result: Record<string, any> = {};
      
      for (const kv of kvs) {
        const fullKey = kv.Key;
        const valueStr = kv.Value ? Buffer.from(kv.Value, 'base64').toString('utf8') : '';
        
        let relativeKey = fullKey;
        if (fullKey.startsWith(normalizedPrefix)) {
          relativeKey = fullKey.substring(normalizedPrefix.length);
        }
        if (relativeKey.startsWith('/')) {
          relativeKey = relativeKey.substring(1);
        }
        
        if (!relativeKey) {
          try {
            const parsed = JSON.parse(valueStr);
            if (parsed && typeof parsed === 'object') {
              Object.assign(result, parsed);
            }
          } catch {
            // Ignore
          }
          continue;
        }
        
        const configPath = relativeKey.replace(/\//g, '.');
        let parsedVal: any = valueStr;
        try {
          parsedVal = JSON.parse(valueStr);
        } catch {
          // Keep as raw string
        }
        setIn(result, configPath, parsedVal);
      }
      
      return result;
    } catch (err: any) {
      console.warn(`[Config] Failed to fetch from Consul address ${address}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Add default values source
   */
  addDefaultsSource(defaults: Record<string, any>): this {
    return this.addSource({
      priority: 100,
      name: 'defaults',
      load: () => Promise.resolve(defaults),
    });
  }

  /**
   * Load and merge all configuration sources
   */
  async load(): Promise<Record<string, any>> {
    if (this.cache) {
      return this.cache;
    }

    const configs: Record<string, any>[] = [];
    const errors: Error[] = [];

    // Load all sources in priority order (lowest priority first)
    for (const source of this.sources.sort((a, b) => a.priority - b.priority)) {
      try {
        const config = await source.load();
        if (Object.keys(config).length > 0) {
          configs.push(config);
          console.log(`[Config] Loaded ${source.name} source`);
        }
      } catch (err) {
        errors.push(err as Error);
        console.warn(`[Config] Failed to load ${source.name}: ${(err as Error).message}`);
      }
    }

    // Merge configs with priority (later = higher priority)
    const merged = mergeConfigs(...configs.reverse());

    // Validate
    const result = this.validator.validate(merged);

    if (!result.valid) {
      const errorMessages = result.errors.map(e => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`Configuration validation failed: ${errorMessages}`);
    }

    this.cache = result.data;
    return this.cache!;
  }

  /**
   * Get current configuration (loads if not cached)
   */
  async get(): Promise<Record<string, any>> {
    if (!this.cache) {
      await this.load();
    }
    return this.cache!;
  }

  /**
   * Clear cache to force reload
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Get sources for debugging
   */
  getSources(): ConfigSource[] {
    return [...this.sources];
  }
}


