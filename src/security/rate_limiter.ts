import type { Request, RequestHandler, Response, NextFunction } from 'express';

export type RateLimitTier = 'free' | 'pro' | 'enterprise';

export interface RateLimiterOptions {
  endpointTiers?: Record<string, RateLimitTier>;
  defaultTier?: RateLimitTier;
  redisUrl?: string;
  keyGenerator?: (req: Request) => string;
  clock?: () => number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

interface BucketStore {
  consume(key: string, nowMs: number, refillRatePerMs: number, burstCapacity: number): Promise<ConsumeResult>;
}

interface ConsumeResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const BUCKET_WINDOW_SECONDS = 10;
const REDIS_ENTRY_TTL_SECONDS = 3600;
const DEFAULT_TIER: RateLimitTier = 'free';

const TIER_DEFINITION: Record<RateLimitTier, { perMinute: number }> = {
  free: { perMinute: 10 },
  pro: { perMinute: 100 },
  enterprise: { perMinute: 1000 },
};

const DEFAULT_KEY_GENERATOR = (req: Request): string => {
  if (req.ip) return req.ip;
  if (req.headers['x-forwarded-for']) {
    const value = req.headers['x-forwarded-for'];
    return Array.isArray(value) ? value[0] : String(value);
  }
  return req.socket?.remoteAddress ?? 'unknown';
};

function normalizePattern(pattern: string): RegExp {
  const placeholder = '__PARAM__';
  const parameterized = pattern.replace(/:[^/]+/g, placeholder);
  const escaped = parameterized.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
  const regexString = escaped.replace(new RegExp(placeholder, 'g'), '[^/]+').replace(/\\\*/g, '.*');
  return new RegExp(`^${regexString}$`);
}

function resolveTier(path: string, endpointTiers: Record<string, RateLimitTier>, defaultTier: RateLimitTier): RateLimitTier {
  const exact = endpointTiers[path];
  if (exact) return exact;
  for (const pattern of Object.keys(endpointTiers)) {
    if (pattern === path) continue;
    const matcher = normalizePattern(pattern);
    if (matcher.test(path)) {
      return endpointTiers[pattern];
    }
  }
  return defaultTier;
}

function retryAfterFromTokens(tokens: number, refillRatePerMs: number): number {
  if (tokens >= 1) return 0;
  const seconds = (1 - tokens) / (refillRatePerMs * 1000);
  return Math.max(1, Math.ceil(seconds));
}

class InMemoryBucketStore implements BucketStore {
  private buckets = new Map<string, BucketState>();

  async consume(key: string, nowMs: number, refillRatePerMs: number, burstCapacity: number): Promise<ConsumeResult> {
    const existing = this.buckets.get(key) ?? { tokens: burstCapacity, lastRefillMs: nowMs };
    const elapsed = Math.max(0, nowMs - existing.lastRefillMs);
    const tokens = Math.min(burstCapacity, existing.tokens + elapsed * refillRatePerMs);
    existing.lastRefillMs = nowMs;

    const allowed = tokens >= 1;
    const remaining = allowed ? tokens - 1 : tokens;
    existing.tokens = remaining;
    this.buckets.set(key, existing);

    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : retryAfterFromTokens(remaining, refillRatePerMs),
    };
  }
}

class RedisBucketStore implements BucketStore {
  private client: any | null = null;
  private readonly redisUrl: string;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    let redis;
    try {
      redis = require('redis');
    } catch (err) {
      throw new Error('Redis backend requested but `redis` package is not installed');
    }

    const client = redis.createClient({ url: this.redisUrl });
    client.on('error', () => {
      // Silence a noisy client error event if no one listens.
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async consume(key: string, nowMs: number, refillRatePerMs: number, burstCapacity: number): Promise<ConsumeResult> {
    const client = await this.getClient();
    const script = `
      local now = tonumber(ARGV[1])
      local refill = tonumber(ARGV[2])
      local capacity = tonumber(ARGV[3])
      local ttl = tonumber(ARGV[4])
      local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or capacity)
      local last = tonumber(redis.call('HGET', KEYS[1], 'last') or now)
      local elapsed = math.max(0, now - last)
      local current = math.min(capacity, tokens + elapsed * refill)
      local allowed = 0
      if current >= 1 then
        current = current - 1
        allowed = 1
      end
      redis.call('HSET', KEYS[1], 'tokens', tostring(current), 'last', tostring(now))
      redis.call('EXPIRE', KEYS[1], ttl)
      local retry = 0
      if allowed == 0 then
        retry = math.ceil((1 - current) / refill)
        if retry < 1 then retry = 1 end
      end
      return { allowed, retry }
    `;

    const result = await client.eval(script, {
      keys: [key],
      arguments: [String(nowMs), String(refillRatePerMs), String(burstCapacity), String(REDIS_ENTRY_TTL_SECONDS)],
    });

    return {
      allowed: Number(result[0]) === 1,
      retryAfterSeconds: Number(result[1]),
    };
  }
}

export function createRateLimitingMiddleware(options: RateLimiterOptions = {}): RequestHandler {
  const endpointTiers = options.endpointTiers ?? {};
  const defaultTier = options.defaultTier ?? DEFAULT_TIER;
  const keyGenerator = options.keyGenerator ?? DEFAULT_KEY_GENERATOR;
  const clock = options.clock ?? (() => Date.now());

  const store: BucketStore = options.redisUrl
    ? new RedisBucketStore(options.redisUrl)
    : new InMemoryBucketStore();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tier = resolveTier(req.path, endpointTiers, defaultTier);
      const tierConfig = TIER_DEFINITION[tier];
      const refillRatePerMs = tierConfig.perMinute / 60 / 1000;
      const burstCapacity = tierConfig.perMinute / 60 * BUCKET_WINDOW_SECONDS;
      const clientKey = keyGenerator(req);
      const routeKey = req.path;
      const storeKey = `rate-limit:${tier}:${routeKey}:${clientKey}`;
      const nowMs = clock();

      const result = await store.consume(storeKey, nowMs, refillRatePerMs, burstCapacity);
      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        res.status(429).json({ error: 'Rate limit exceeded' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
