/**
 * Config management API routes.
 *
 * Endpoints (issue #204):
 *   GET    /config                     — current config with secrets masked
 *   PUT    /config                     — update a config path { path, value }
 *   POST   /config/reload              — trigger a reload from all sources
 *   POST   /config/rollback/:version   — roll back to a previous version
 *   GET    /config/versions            — list version history (masked)
 *   GET    /config/metrics             — Prometheus text metrics
 *
 * All responses pass through maskSecrets() so no secret-like value
 * (/secret|password|key/i) ever leaves the process over HTTP.
 */

import type { Request, Response } from 'express';
import { getConfigManager } from './manager';
import { maskSecrets } from './secrets';
import type { ConfigVersion } from './versions';

type JsonError = { error: string };

/**
 * Register the config management routes on an Express app.
 */
export function registerConfigRoutes(app: {
  get: (path: string, handler: (req: Request, res: Response) => void) => void;
  put: (path: string, handler: (req: Request, res: Response) => void) => void;
  post: (path: string, handler: (req: Request, res: Response) => void) => void;
}): void {
  const manager = getConfigManager();

  // ── GET /config ────────────────────────────────────────────────────────────
  app.get('/config', (_req: Request, res: Response) => {
    try {
      res.json({ config: maskSecrets(manager.get()), version: manager.currentVersion() });
    } catch (err) {
      res.status(500).json({ error: errMsg(err) } satisfies JsonError);
    }
  });

  // ── PUT /config ────────────────────────────────────────────────────────────
  // Body: { "path": "app.port", "value": 3001 }  (path as dot string or array)
  app.put('/config', (req: Request, res: Response) => {
    const { path, value } = (req.body ?? {}) as { path?: unknown; value?: unknown };
    if (typeof path !== 'string' && !Array.isArray(path)) {
      res.status(400).json({ error: 'body must include "path" (string or array)' } satisfies JsonError);
      return;
    }
    if (value === undefined) {
      res.status(400).json({ error: 'body must include "value"' } satisfies JsonError);
      return;
    }
    try {
      manager.update(path as string | string[], value);
      res.json({
        ok: true,
        version: manager.currentVersion(),
        config: maskSecrets(manager.get()),
      });
    } catch (err) {
      // Validation failures are client errors; anything else is a server fault.
      const msg = errMsg(err);
      if (msg.includes('validation failed')) {
        res.status(400).json({ error: msg } satisfies JsonError);
      } else {
        res.status(500).json({ error: msg } satisfies JsonError);
      }
    }
  });

  // ── POST /config/reload ────────────────────────────────────────────────────
  app.post('/config/reload', async (req: Request, res: Response) => {
    try {
      await manager.triggerReloadAsync();
      res.json({ ok: true, version: manager.currentVersion() });
    } catch (err) {
      res.status(500).json({ error: errMsg(err) } satisfies JsonError);
    }
  });

  // ── POST /config/rollback/:version ─────────────────────────────────────────
  app.post('/config/rollback/:version', (req: Request, res: Response) => {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({ error: 'version must be a positive integer' } satisfies JsonError);
      return;
    }
    try {
      manager.rollbackTo(version);
      res.json({
        ok: true,
        version: manager.currentVersion(),
        config: maskSecrets(manager.get()),
      });
    } catch (err) {
      const msg = errMsg(err);
      if (msg.includes('No config version') || msg.includes('validation failed')) {
        res.status(400).json({ error: msg } satisfies JsonError);
      } else {
        res.status(500).json({ error: msg } satisfies JsonError);
      }
    }
  });

  // ── GET /config/versions ───────────────────────────────────────────────────
  app.get('/config/versions', (_req: Request, res: Response) => {
    try {
      const versions = manager.getVersionHistory().list().map((v: ConfigVersion) => ({
        version: v.version,
        timestamp: v.timestamp,
        source: v.source,
        note: v.note,
        config: maskSecrets(v.config),
      }));
      res.json({ current: manager.currentVersion(), versions });
    } catch (err) {
      res.status(500).json({ error: errMsg(err) } satisfies JsonError);
    }
  });

  // ── GET /config/metrics ────────────────────────────────────────────────────
  app.get('/config/metrics', (_req: Request, res: Response) => {
    res.type('text/plain').send(manager.getMetrics().prometheusMetrics());
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
