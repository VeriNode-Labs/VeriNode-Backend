import * as fs from 'fs';
import * as path from 'path';
import { flattenConfig, computeHashFromFlattened } from './flatten';

// ── Baseline source contract ───────────────────────────────────────────────────

export interface BaselineConfigSource {
  name: string;
  loadBaseline(): Promise<unknown>;
}

// ── Sources ────────────────────────────────────────────────────────────────────

/**
 * Load from config.json.example (the original default source).
 */
export class ExampleConfigBaselineSource implements BaselineConfigSource {
  name = 'repo:config.json.example';

  constructor(
    private readonly examplePath: string = path.resolve(
      __dirname,
      '../../../config.json.example',
    ),
  ) {}

  async loadBaseline(): Promise<unknown> {
    const content = fs.readFileSync(this.examplePath, 'utf8');
    return JSON.parse(content);
  }
}

/**
 * Load from a `config/*.baseline.json` file as required by the issue spec.
 *
 * File naming convention:  config/<service>.baseline.json
 * Example:                 config/verinode.baseline.json
 *
 * Falls back to `config.json.example` when no baseline file exists.
 */
export class BaselineJsonFileSource implements BaselineConfigSource {
  readonly name: string;
  private readonly resolvedPath: string;
  private readonly fallback: ExampleConfigBaselineSource;

  constructor(
    /** Absolute or repo-relative path to the *.baseline.json file. */
    baselinePath: string,
    /** Root directory for resolving relative paths (defaults to process.cwd()). */
    rootDir: string = process.cwd(),
  ) {
    this.resolvedPath = path.isAbsolute(baselinePath)
      ? baselinePath
      : path.resolve(rootDir, baselinePath);
    this.name = `repo:${path.relative(rootDir, this.resolvedPath)}`;
    this.fallback = new ExampleConfigBaselineSource();
  }

  async loadBaseline(): Promise<unknown> {
    if (!fs.existsSync(this.resolvedPath)) {
      // Fall back to config.json.example when the baseline file does not exist
      console.warn(
        `[Baseline] ${this.resolvedPath} not found — falling back to config.json.example`,
      );
      return this.fallback.loadBaseline();
    }
    const content = fs.readFileSync(this.resolvedPath, 'utf8');
    return JSON.parse(content);
  }

  /**
   * Persist the given config object as the new baseline file.
   * Used by auto-remediation when updating safe drifts into the baseline.
   */
  async saveBaseline(config: unknown, annotation?: string): Promise<void> {
    const dir = path.dirname(this.resolvedPath);
    fs.mkdirSync(dir, { recursive: true });

    const payload = {
      _savedAt: new Date().toISOString(),
      _annotation: annotation ?? null,
      ...(typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {}),
    };

    const tmpPath = `${this.resolvedPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, this.resolvedPath);
  }
}

/**
 * Discover all *.baseline.json files under a directory.
 */
export function discoverBaselineFiles(
  dir: string = path.resolve(process.cwd(), 'config'),
): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.baseline.json'))
    .map((f) => path.join(dir, f));
}

// ── Snapshot type ─────────────────────────────────────────────────────────────

export interface BaselineSnapshot {
  sourceName: string;
  baselineConfig: unknown;
  flattened: Record<string, string>;
  baselineHash: string;
}

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loadBaselineSnapshot(
  sources: BaselineConfigSource[],
): Promise<BaselineSnapshot> {
  const source = sources[0];
  if (!source) throw new Error('No baseline sources configured');

  const baselineConfig = await source.loadBaseline();
  const flattened = flattenConfig(baselineConfig);
  const baselineHash = computeHashFromFlattened(flattened);

  return { sourceName: source.name, baselineConfig, flattened, baselineHash };
}

/**
 * Build the default list of baseline sources based on environment and
 * auto-discovery of config/*.baseline.json files.
 *
 * Priority:
 *   1. Files discovered under VERINODE_BASELINE_DIR (env var) or ./config/
 *   2. config.json.example as fallback
 */
export function buildDefaultBaselineSources(): BaselineConfigSource[] {
  const baselineDir = process.env.VERINODE_BASELINE_DIR ?? path.resolve(process.cwd(), 'config');
  const discovered = discoverBaselineFiles(baselineDir);

  if (discovered.length > 0) {
    return discovered.map((p) => new BaselineJsonFileSource(p));
  }

  return [new ExampleConfigBaselineSource()];
}
