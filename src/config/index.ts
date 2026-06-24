export { mainSchema, databaseSchema, mtlsSchema, tlsSchema, telemetrySchema, appSchema, stakingSchema, remoteSchema } from './schema';
export { ConfigValidationError, ValidationResult, ConfigValidator } from './validator';
export { ConfigEvent, ConfigEventPayload, ConfigEventBus, configEventBus } from './eventbus';
export { ConfigSource, ConfigLoader } from './loader';
export { ConfigManager, ConfigChangeCallback, getConfigManager } from './manager';
export { mergeConfigs, normalizeEnvKey, flattenToEnv } from './validator';
export { deepClone, deepMerge, getIn, setIn, deleteIn, parseEnvValue, formatErrorPath } from './utils';

import { getConfigManager } from './manager';
import { ConfigValidationError } from './validator';
import { configEventBus } from './eventbus';

/**
 * Default configuration file path
 */
export const DEFAULT_CONFIG_PATH = './config.json';

/**
 * Initialize configuration with defaults
 * This is the entry point for applications
 */
export async function initConfig(options?: {
  configFile?: string;
  watchFiles?: string[];
  loadRemote?: boolean;
}): Promise<void> {
  const manager = getConfigManager();
  await manager.initialize(options);
}

/**
 * Get the centralized config manager instance
 * This should be used by modules to access configuration
 */
export function getConfig(): any {
  const manager = getConfigManager();
  return manager.get();
}

/**
 * Get a specific configuration value
 */
export function getConfigValue(path: string | string[]): any {
  const manager = getConfigManager();
  return manager.getIn(path);
}

/**
 * Subscribe to configuration changes
 */
export function onConfigChange(callback: (oldConfig: any, newConfig: any) => void, id?: string): string {
  const manager = getConfigManager();
  return manager.onChange(callback, id);
}

/**
 * Unsubscribe from configuration changes
 */
export function offConfigChange(id: string): void {
  const manager = getConfigManager();
  manager.offChange(id);
}

/**
 * Subscribe to changes on a specific config path
 */
export function onChangePath(path: string, callback: (value: any) => void, id?: string): string {
  const manager = getConfigManager();
  return manager.onChangePath(path, callback, id);
}

/**
 * Trigger a configuration reload (e.g., from SIGHUP)
 */
export async function reloadConfig(): Promise<void> {
  const manager = getConfigManager();
  return new Promise<void>((resolve, reject) => {
    const onComplete = () => {
      configEventBus.removeListener('reload_complete', onComplete);
      configEventBus.removeListener('error', onError);
      resolve();
    };
    const onError = (payload: any) => {
      configEventBus.removeListener('reload_complete', onComplete);
      configEventBus.removeListener('error', onError);
      reject(payload.error || new Error('Reload failed'));
    };
    configEventBus.on('reload_complete', onComplete);
    configEventBus.on('error', onError);
    manager.triggerReload();
  });
}

/**
 * Validate configuration data against schema
 */
export function validateConfig(data: any): { valid: boolean; errors: ConfigValidationError[] } {
  const manager = getConfigManager();
  const result = manager.getValidator().validate(data);
  return {
    valid: result.valid,
    errors: result.errors,
  };
}
