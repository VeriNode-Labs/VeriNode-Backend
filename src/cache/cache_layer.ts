import { metrics } from '@opentelemetry/api';

export interface CacheLayerOptions {
  redisUrl?: string;
  defaultTtlSeconds?: number;
  namespace?: string;
  maxEntries?: number;
  clock?: () => number;
}

export interface CacheSetOptions {
  ttlSeconds?: number;
}

interface MemoryEntry {
  value: string;
  expiresAtMs: number;
}

type RedisClient = {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_NAMESPACE = 'verinode';
const DEFAULT_MAX_ENTRIES = 10_000;

const meter = metrics.getMeter('cache_layer', '1.0.0');
const cacheRequestsTotal = meter.createCounter('cache.requests_total', {
  description: 'Total cache get requests by result and backend',
});
const cacheWritesTotal = meter.createCounter('cache.writes_total', {
  description: 'Total cache writes by backend',
});
const cacheErrorsTotal = meter.createCounter('cache.errors_total', {
  description: 'Total cache backend errors by operation and backend',
});
const cacheOperationDurationMs = meter.createHistogram('cache.operation_duration_ms', {
  description: 'Cache operation latency in milliseconds (target P99 < 100ms)',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 250] },
});

function normalizeTtlSeconds(ttlSeconds: number | undefined, fallback: number): number {
  const ttl = ttlSeconds ?? fallback;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error('Cache TTL must be a positive finite number of seconds');
  }
  return Math.ceil(ttl);
}

function safeNamespace(namespace: string): string {
  return namespace.replace(/[^a-zA-Z0-9:_-]/g, '_');
}

export class CacheLayer {
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly redisUrl?: string;
  private readonly defaultTtlSeconds: number;
  private readonly namespace: string;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private redisClient: RedisClient | null = null;
  private redisUnavailable = false;

  constructor(options: CacheLayerOptions = {}) {
    this.redisUrl = options.redisUrl;
    this.defaultTtlSeconds = normalizeTtlSeconds(options.defaultTtlSeconds, DEFAULT_TTL_SECONDS);
    this.namespace = safeNamespace(options.namespace ?? DEFAULT_NAMESPACE);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.clock = options.clock ?? (() => Date.now());
  }

  async get<T>(key: string): Promise<T | null> {
    const started = this.clock();
    const backend = this.redisUrl && !this.redisUnavailable ? 'redis' : 'memory';
    try {
      const encoded =
        this.redisUrl && !this.redisUnavailable ? await this.redisGet(key) : this.memoryGet(key);
      const result = encoded === null ? null : (JSON.parse(encoded) as T);
      cacheRequestsTotal.add(1, { backend, result: result === null ? 'miss' : 'hit' });
      return result;
    } catch (err) {
      cacheErrorsTotal.add(1, { backend, operation: 'get' });
      if (this.redisUrl && !this.redisUnavailable) {
        this.redisUnavailable = true;
        return this.get<T>(key);
      }
      throw err;
    } finally {
      cacheOperationDurationMs.record(Math.max(0, this.clock() - started), {
        backend,
        operation: 'get',
      });
    }
  }

  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    const started = this.clock();
    const ttlSeconds = normalizeTtlSeconds(options.ttlSeconds, this.defaultTtlSeconds);
    const encoded = JSON.stringify(value);
    const backend = this.redisUrl && !this.redisUnavailable ? 'redis' : 'memory';
    try {
      if (this.redisUrl && !this.redisUnavailable) {
        await this.redisSet(key, encoded, ttlSeconds);
      } else {
        this.memorySet(key, encoded, ttlSeconds);
      }
      cacheWritesTotal.add(1, { backend });
    } catch (err) {
      cacheErrorsTotal.add(1, { backend, operation: 'set' });
      if (this.redisUrl && !this.redisUnavailable) {
        this.redisUnavailable = true;
        this.memorySet(key, encoded, ttlSeconds);
        cacheWritesTotal.add(1, { backend: 'memory' });
        return;
      }
      throw err;
    } finally {
      cacheOperationDurationMs.record(Math.max(0, this.clock() - started), {
        backend,
        operation: 'set',
      });
    }
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(this.cacheKey(key));
    if (this.redisUrl && !this.redisUnavailable) {
      try {
        const client = await this.getRedisClient();
        await client.del(this.cacheKey(key));
      } catch {
        this.redisUnavailable = true;
        cacheErrorsTotal.add(1, { backend: 'redis', operation: 'delete' });
      }
    }
  }

  async getOrSet<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: CacheSetOptions = {},
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await loader();
    await this.set(key, value, options);
    return value;
  }

  prometheusMetrics(): string {
    return (
      [
        '# HELP verinode_cache_entries Number of in-memory cache entries on this node.',
        '# TYPE verinode_cache_entries gauge',
        `verinode_cache_entries{namespace="${this.namespace}"} ${this.memory.size}`,
        '# HELP verinode_cache_redis_available Redis cache availability flag (1 available, 0 unavailable or disabled).',
        '# TYPE verinode_cache_redis_available gauge',
        `verinode_cache_redis_available{namespace="${this.namespace}"} ${this.redisUrl && !this.redisUnavailable ? 1 : 0}`,
      ].join('\n') + '\n'
    );
  }

  private cacheKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private memoryGet(key: string): string | null {
    const namespaced = this.cacheKey(key);
    const entry = this.memory.get(namespaced);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.clock()) {
      this.memory.delete(namespaced);
      return null;
    }
    return entry.value;
  }

  private memorySet(key: string, value: string, ttlSeconds: number): void {
    if (this.memory.size >= this.maxEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest) this.memory.delete(oldest);
    }
    this.memory.set(this.cacheKey(key), { value, expiresAtMs: this.clock() + ttlSeconds * 1000 });
  }

  private async redisGet(key: string): Promise<string | null> {
    const client = await this.getRedisClient();
    return client.get(this.cacheKey(key));
  }

  private async redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    const client = await this.getRedisClient();
    await client.set(this.cacheKey(key), value, { EX: ttlSeconds });
  }

  private async getRedisClient(): Promise<RedisClient> {
    if (this.redisClient) return this.redisClient;
    let redis;
    try {
      redis = require('redis');
    } catch {
      throw new Error('Redis cache requested but `redis` package is not installed');
    }
    const client = redis.createClient({ url: this.redisUrl }) as RedisClient;
    client.on('error', () => {
      this.redisUnavailable = true;
    });
    await client.connect();
    this.redisClient = client;
    this.redisUnavailable = false;
    return client;
  }
}

export function createCacheLayerFromEnv(env: NodeJS.ProcessEnv = process.env): CacheLayer {
  return new CacheLayer({
    redisUrl: env.CACHE_REDIS_URL || env.REDIS_URL,
    defaultTtlSeconds: env.CACHE_DEFAULT_TTL_SECONDS
      ? Number(env.CACHE_DEFAULT_TTL_SECONDS)
      : undefined,
    namespace: env.CACHE_NAMESPACE,
    maxEntries: env.CACHE_MAX_ENTRIES ? Number(env.CACHE_MAX_ENTRIES) : undefined,
  });
}
