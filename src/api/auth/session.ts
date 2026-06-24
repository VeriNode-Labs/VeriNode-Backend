import type { Request, Response, NextFunction } from 'express';
import { JwtManager, AccessTokenPayload } from './jwt_manager';

declare global {
  namespace Express {
    interface Request {
      nodeId?: string;
      authPayload?: AccessTokenPayload;
    }
  }
}

export function createSessionMiddleware(jwtManager: JwtManager) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    try {
      const payload = jwtManager.verifyAccessToken(token);
      req.nodeId = payload.nodeId;
      req.authPayload = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
