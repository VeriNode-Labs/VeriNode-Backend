/**
 * VeriNode Backend — Performance Baseline Store
 *
 * Persists benchmark baselines as JSON files on disk, keyed by
 * `{branch}_{scenario}.json`.  In a production setup the storage
 * directory can be an S3-mounted path or a local .benchmarks/ folder.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import type { PerformanceBaseline } from './types';

export class BaselineStore {
  private readonly storageDir: string;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    // Ensure the directory exists synchronously on construction.
    if (!fsSync.existsSync(storageDir)) {
      fsSync.mkdirSync(storageDir, { recursive: true });
    }
  }

  // ── Key helpers ───────────────────────────────────────────────────────

  private key(branch: string, scenario: string): string {
    // Sanitise branch name: replace slashes and special chars.
    const safeBranch = branch.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeScenario = scenario.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `${safeBranch}_${safeScenario}.json`;
  }

  private filePath(branch: string, scenario: string): string {
    return path.join(this.storageDir, this.key(branch, scenario));
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Persist a baseline.  Overwrites any existing baseline for the
   * same branch/scenario combination.
   */
  async save(baseline: PerformanceBaseline): Promise<void> {
    const file = this.filePath(baseline.branch, baseline.scenario);
    const data = JSON.stringify(baseline, null, 2);
    await fs.writeFile(file, data, 'utf8');
  }

  /**
   * Load a baseline.  Returns `null` if no baseline exists for the
   * given branch/scenario combination.
   */
  async load(
    branch: string,
    scenario: string,
  ): Promise<PerformanceBaseline | null> {
    const file = this.filePath(branch, scenario);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as PerformanceBaseline;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null;
      }
      throw err;
    }
  }

  /** Return true if a baseline file exists for the given branch/scenario. */
  exists(branch: string, scenario: string): boolean {
    return fsSync.existsSync(this.filePath(branch, scenario));
  }

  /**
   * List all stored baselines (branch_scenario pairs).
   * Useful for maintenance and reporting.
   */
  async list(): Promise<Array<{ branch: string; scenario: string }>> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.storageDir);
    } catch {
      return [];
    }

    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => {
        const name = e.slice(0, -5); // strip .json
        const sep = name.indexOf('_');
        if (sep === -1) return null;
        return { branch: name.slice(0, sep), scenario: name.slice(sep + 1) };
      })
      .filter((e): e is { branch: string; scenario: string } => e !== null);
  }

  /**
   * Delete a stored baseline.  No-op if it does not exist.
   */
  async delete(branch: string, scenario: string): Promise<void> {
    const file = this.filePath(branch, scenario);
    try {
      await fs.unlink(file);
    } catch (err: unknown) {
      if (
        (err as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw err;
      }
    }
  }
}
