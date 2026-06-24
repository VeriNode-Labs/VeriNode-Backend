import { Router, Request, Response, NextFunction } from 'express';
import { loadAuthConfig } from './config';
import { MemoryNonceStore } from './nonce_store';
import { JwtManager } from './jwt_manager';
import { createSessionMiddleware } from './session';
import { createChallengeHandler } from './challenge';
import { createVerifyHandler } from './verify';
import { createRefreshHandler } from './refresh';

const config = loadAuthConfig();
const nonceStore = new MemoryNonceStore();
const jwtManager = new JwtManager();
const sessionMiddleware = createSessionMiddleware(jwtManager);

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

function createRateLimiter(maxPerMinute: number) {
  const store = new Map<string, RateLimitEntry>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 60_000);
  if (cleanup.unref) cleanup.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || now > entry.resetAt) {
      store.set(ip, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }

    entry.count++;
    if (entry.count > maxPerMinute) {
      res.status(429).json({ error: 'Too many requests. Please slow down.' });
      return;
    }

    next();
  };
}

const router = Router();

router.use((req, res, next) => {
  res.type('application/json');
  next();
});

router.post('/challenge', createRateLimiter(config.challengeRateLimitPerMinute), createChallengeHandler(nonceStore, config));
router.post('/verify', createRateLimiter(config.verifyRateLimitPerMinute), createVerifyHandler(nonceStore, jwtManager, config));
router.post('/refresh', createRefreshHandler(nonceStore, jwtManager, config));

export { router, sessionMiddleware, jwtManager, config };
export { createSessionMiddleware } from './session';
