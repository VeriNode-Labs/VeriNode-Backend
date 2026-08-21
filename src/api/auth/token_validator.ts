
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

