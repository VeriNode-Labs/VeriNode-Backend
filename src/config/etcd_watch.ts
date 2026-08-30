/**
 * Etcd config watcher.
 *
 * Polls the etcd v3 HTTP gateway for changes under a key prefix
 * (e.g. /config/{service_name}/) and invokes a callback whenever any
 * key/value in that prefix changes. Uses the KV range + a monotonic
 * mod_revision cursor so only *new* changes are delivered.
 *
 * The watcher is deliberately implemented against the HTTP /v3/kv/range
 * endpoint (matching ConfigLoader.loadRemoteEtcd) so no native etcd client
 * dependency is required and the same endpoint list / failover behavior applies.
 */

import { createLogger } from '../diagnostics/logger';

const log = createLogger('config_etcd_watch');

export interface EtcdWatchOptions {
  endpoints: string[];
  keyPrefix: string;
  /** Poll interval in ms (default 10_000). */
  pollIntervalMs?: number;
  /** Optional basic auth. */
  username?: string;
  password?: string;
  /** Called with the full decoded prefix state on every detected change. */
  onChange: (state: Record<string, any>) => void;
  /** Called when all endpoints fail; watcher keeps retrying. */
  onError?: (err: Error) => void;
}

export interface EtcdKv {
  key: string;
  value: string;
  modRevision: number;
}

function getRangeEnd(prefix: string): string {
  if (prefix.length === 0) return '\xff';
  const lastChar = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(lastChar + 1);
}

export class EtcdConfigWatcher {
  private options: EtcdWatchOptions;
  private timer: NodeJS.Timeout | null = null;
  private lastModRevision = 0;
  private running = false;
  private inFlight = false;

  constructor(options: EtcdWatchOptions) {
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.options.pollIntervalMs ?? 10_000;
    this.timer = setInterval(() => {
      void this.poll();
    }, interval);
    this.timer.unref?.();
    // Prime the revision cursor without emitting an initial "change".
    void this.poll(true);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Fetch all KVs under the prefix. Returns decoded entries.
   */
  private async fetchKvs(): Promise<EtcdKv[]> {
    const prefix = this.options.keyPrefix.endsWith('/')
      ? this.options.keyPrefix
      : `${this.options.keyPrefix}/`;
    const rangeEnd = getRangeEnd(prefix);

    const body = {
      key: Buffer.from(prefix).toString('base64'),
      range_end: Buffer.from(rangeEnd).toString('base64'),
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.username && this.options.password) {
      const token = Buffer.from(`${this.options.username}:${this.options.password}`).toString(
        'base64',
      );
      headers['Authorization'] = `Basic ${token}`;
    }

    let lastError: Error | null = null;
    for (const endpoint of this.options.endpoints) {
      try {
        const url = `${endpoint.replace(/\/$/, '')}/v3/kv/range`;
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json()) as any;
        const kvs: EtcdKv[] = [];
        if (data.kvs && Array.isArray(data.kvs)) {
          for (const kv of data.kvs) {
            kvs.push({
              key: Buffer.from(kv.key, 'base64').toString('utf8'),
              value: kv.value ? Buffer.from(kv.value, 'base64').toString('utf8') : '',
              modRevision: Number(kv.mod_revision ?? 0),
            });
          }
        }
        return kvs;
      } catch (err: any) {
        lastError = err;
        log.warn('etcd watch poll failed for endpoint', {
          'server.address': endpoint,
          'error.message': err.message,
        });
      }
    }
    throw lastError || new Error('All etcd endpoints failed');
  }

  /**
   * Decode raw KVs under the prefix into a nested config object.
   * Keys are slash-separated paths; a KV at the exact prefix is parsed as JSON.
   */
  decodeState(kvs: EtcdKv[]): Record<string, any> {
    const prefix = this.options.keyPrefix.endsWith('/')
      ? this.options.keyPrefix
      : `${this.options.keyPrefix}/`;

    const result: Record<string, any> = {};
    for (const kv of kvs) {
      let relativeKey = kv.key;
      if (relativeKey.startsWith(prefix)) relativeKey = relativeKey.substring(prefix.length);
      if (relativeKey.startsWith('/')) relativeKey = relativeKey.substring(1);

      let parsedVal: any = kv.value;
      try {
        parsedVal = JSON.parse(kv.value);
      } catch {
        // keep raw string
      }

      if (!relativeKey) {
        // Value stored directly at the prefix: merge the object if possible.
        if (parsedVal && typeof parsedVal === 'object' && !Array.isArray(parsedVal)) {
          Object.assign(result, parsedVal);
        }
        continue;
      }

      const parts = relativeKey.split('/').filter(Boolean);
      let current = result;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
          current[parts[i]] = {};
        }
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = parsedVal;
    }
    return result;
  }

  private async poll(initial = false): Promise<void> {
    if (this.inFlight || !this.running) return;
    this.inFlight = true;
    try {
      const kvs = await this.fetchKvs();
      const maxRevision = kvs.reduce((max, kv) => Math.max(max, kv.modRevision), 0);

      if (initial) {
        // Just prime the cursor.
        this.lastModRevision = maxRevision;
        return;
      }

      if (maxRevision > this.lastModRevision) {
        this.lastModRevision = maxRevision;
        const state = this.decodeState(kvs);
        log.info('etcd config change detected', { 'etcd.prefix': this.options.keyPrefix });
        this.options.onChange(state);
      }
    } catch (err: any) {
      this.options.onError?.(err);
    } finally {
      this.inFlight = false;
    }
  }
}
