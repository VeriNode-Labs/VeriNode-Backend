/**
 * Config version history + rollback support.
 *
 * Every applied configuration change (initial load, reload, hot update) is
 * recorded as an immutable version. Rollback re-validates the historical
 * config against the *current* schema before reapplying, since the schema
 * may have evolved between versions.
 */

import { deepClone } from './utils';

export interface ConfigVersion {
  /** Monotonically increasing version number, starting at 1. */
  version: number;
  /** Epoch ms when this version became active. */
  timestamp: number;
  /** What triggered this version: 'initial' | 'reload' | 'update' | 'delete' | 'rollback'. */
  source: 'initial' | 'reload' | 'update' | 'delete' | 'rollback';
  /** Optional human-readable note (e.g. change description). */
  note?: string;
  /** The full validated config snapshot for this version. */
  config: any;
}

export class ConfigVersionHistory {
  private versions: ConfigVersion[] = [];
  private maxVersions: number;

  constructor(maxVersions = 50) {
    this.maxVersions = Math.max(1, maxVersions);
  }

  /**
   * Record a new version. Returns the version number assigned.
   * Version numbers are monotonically increasing even after trimming old
   * entries, so they can be used as stable identifiers.
   */
  record(config: any, source: ConfigVersion['source'], note?: string): number {
    const lastVersion = this.versions.length
      ? this.versions[this.versions.length - 1].version
      : 0;
    const version: ConfigVersion = {
      version: lastVersion + 1,
      timestamp: Date.now(),
      source,
      note,
      config: deepClone(config),
    };
    this.versions.push(version);

    // Trim oldest versions beyond the retention window, but always keep at
    // least the current one.
    if (this.versions.length > this.maxVersions) {
      this.versions.splice(0, this.versions.length - this.maxVersions);
    }

    return version.version;
  }

  /**
   * The current (latest) version number, or 0 if nothing recorded yet.
   */
  currentVersion(): number {
    return this.versions.length ? this.versions[this.versions.length - 1].version : 0;
  }

  /**
   * Look up a specific version snapshot.
   */
  getVersion(version: number): ConfigVersion | undefined {
    return this.versions.find((v) => v.version === version);
  }

  /**
   * All versions, oldest first. Config snapshots are cloned to prevent
   * callers from mutating history.
   */
  list(): ConfigVersion[] {
    return this.versions.map((v) => ({ ...v, config: deepClone(v.config) }));
  }

  /**
   * Number of retained versions.
   */
  size(): number {
    return this.versions.length;
  }

  /**
   * Clear all history (used in tests and re-initialization).
   */
  clear(): void {
    this.versions = [];
  }
}
