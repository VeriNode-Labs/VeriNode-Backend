import type { Request, RequestHandler, Response, NextFunction } from 'express';
import {
  isEnabled,
  getStatus,
  registerFlags,
  initFeatureFlags,
  FeatureFlag,
} from './feature_flags';
import { initCapacityShedder, getCurrentLevel, onSheddingChange } from './capacity_shedder';
import type { SheddingLevel, MetricSnapshot } from './capacity_shedder';

export interface DegradationConfig {
  flags: FeatureFlag[];
  metricCollector?: () => MetricSnapshot;
  autoInit?: boolean;
}

export interface FlagCheckOptions {
  statusCode?: number;
  degradeResponse?: Record<string, unknown>;
}

const DEFAULT_DEGRADE_RESPONSE = {
  error: 'service degraded',
  message: 'This feature is temporarily unavailable due to high system load',
};

export function requireFlag(flagKey: string, options: FlagCheckOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isEnabled(flagKey)) {
      return next();
    }
    const { statusCode = 503, degradeResponse } = options;
    res
      .status(statusCode)
      .json(degradeResponse || { ...DEFAULT_DEGRADE_RESPONSE, feature: flagKey });
  };
}

export function degradeOnLevel(
  minLevel: SheddingLevel,
  options: FlagCheckOptions = {},
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const currentLevel = getCurrentLevel();
    const levels: SheddingLevel[] = ['none', 'light', 'medium', 'critical'];
    if (levels.indexOf(currentLevel) >= levels.indexOf(minLevel)) {
      const { statusCode = 503, degradeResponse } = options;
      return res
        .status(statusCode)
        .json(degradeResponse || { ...DEFAULT_DEGRADE_RESPONSE, sheddingLevel: currentLevel });
    }
    next();
  };
}

export function featureFlagMiddleware(
  flagKey: string,
  options: FlagCheckOptions = {},
): RequestHandler {
  return requireFlag(flagKey, options);
}

export function initGracefulDegradation(config: DegradationConfig): void {
  registerFlags(config.flags);
  initFeatureFlags();
  if (config.metricCollector) {
    initCapacityShedder(config.metricCollector);
  }
}

export function getSheddingLevel(): SheddingLevel {
  return getCurrentLevel();
}

export { onSheddingChange, getStatus, isEnabled };
