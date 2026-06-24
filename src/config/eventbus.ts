import { EventEmitter } from 'events';

/**
 * Configuration event types
 */
export type ConfigEvent = 
  | 'loaded'
  | 'updated'
  | 'reload_initiated'
  | 'reload_complete'
  | 'error';

/**
 * Configuration event payload
 */
export interface ConfigEventPayload {
  timestamp: number;
  event: ConfigEvent;
  data?: any;
  error?: Error;
}

/**
 * Event bus for configuration changes
 */
export class ConfigEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Emit configuration event
   */
  emitEvent(event: ConfigEvent, data?: any, error?: Error): void {
    const payload: ConfigEventPayload = {
      timestamp: Date.now(),
      event,
      data,
      error,
    };
    this.emit(event, payload);
    this.emit('all', payload);
  }

  /**
   * Subscribe to all events
   */
  onAll(callback: (payload: ConfigEventPayload) => void): void {
    this.on('all', callback);
  }

  /**
   * Subscribe to configuration updates
   */
  onUpdate(callback: (data: any) => void): this {
    this.on('updated', (payload) => callback(payload.data));
    return this;
  }

  /**
   * Subscribe to configuration errors
   */
  onError(callback: (error: Error) => void): this {
    this.on('error', (payload) => payload.error && callback(payload.error));
    return this;
  }

  /**
   * Subscribe to reload events
   */
  onReload(callback: () => void): this {
    this.on('reload_initiated', () => callback());
    return this;
  }

  /**
   * Subscribe to reload completion
   */
  onReloadComplete(callback: (data: any) => void): this {
    this.on('reload_complete', (payload) => callback(payload.data));
    return this;
  }
}

/**
 * Default event bus instance
 */
export const configEventBus = new ConfigEventBus();
