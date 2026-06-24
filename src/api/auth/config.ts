import { randomBytes } from 'node:crypto';

export interface AuthConfig {
  serverId: string;
  challengeTtlMs: number;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  challengeRateLimitPerMinute: number;
  verifyRateLimitPerMinute: number;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    serverId: 'VeriNode-Backend',
    challengeTtlMs: positiveInt(env.AUTH_CHALLENGE_TTL_SECONDS, 300) * 1000,
    accessTokenTtlMs: positiveInt(env.AUTH_ACCESS_TOKEN_TTL_SECONDS, 3600) * 1000,
    refreshTokenTtlMs: positiveInt(env.AUTH_REFRESH_TOKEN_TTL_SECONDS, 604800) * 1000,
    challengeRateLimitPerMinute: positiveInt(env.AUTH_CHALLENGE_RATE_LIMIT, 10),
    verifyRateLimitPerMinute: positiveInt(env.AUTH_VERIFY_RATE_LIMIT, 5),
  };
}

export function generateServerNonce(): Buffer {
  return randomBytes(32);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
