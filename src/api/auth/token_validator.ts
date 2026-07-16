import { Request, Response, NextFunction } from 'express';
import type { ActorContext, AuditPermission } from '../../audit/types';
import { ForbiddenError } from '../../audit/types';

// ── Re-export audit types so callers import from one place ────────────────────
export type { ActorContext, AuditPermission };
export { ForbiddenError };

/**
 * Require that an ActorContext holds a specific AuditPermission.
 * Throws ForbiddenError immediately if the permission is absent.
 * This is a pure, synchronous function — safe to call as the first
 * line of any mutating operation before any DB or state access.
 */
export function requirePermission(
  actor: ActorContext,
  permission: AuditPermission,
): void {
  if (!actor.permissions.includes(permission)) {
    throw new ForbiddenError(`${permission} permission required`);
  }
}

/**
 * Build a system ActorContext (SIGHUP reload, file-watch, etc.)
 * with no network origin and full baseline write access.
 */
export function systemActor(): ActorContext {
  return {
    actorId: 'system',
    permissions: ['config:read', 'config:baseline:write', 'config:rollback:write'],
    sourceIp: null,
  };
}

/**
 * Build an anonymous ActorContext for requests with missing/invalid tokens.
 */
export function anonymousActor(sourceIp: string | null = null): ActorContext {
  return { actorId: 'anonymous', permissions: [], sourceIp };
}

export function validateNodeToken(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    const nodeIdHeader = req.headers['x-node-id'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    if (!nodeIdHeader || typeof nodeIdHeader !== 'string') {
        return res.status(403).json({ error: 'Missing hardware node identity header from gateway' });
    }

    const token = authHeader.split(' ')[1];

    try {
        // Example mock verification logic (would normally use jsonwebtoken and a shared secret or public key)
        // const decoded = jwt.verify(token, process.env.JWT_SECRET);
        // if (decoded.nodeId !== nodeIdHeader) { ... }
        
        // For demonstration, assuming token verification logic is handled and we ensure 
        // the node identity claimed in the token matches the mTLS validated X-Node-ID.
        (req as any).user = {
            nodeId: nodeIdHeader,
            // ...other token claims
        };
        
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
