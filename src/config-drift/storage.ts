import * as fs from 'fs';
import * as path from 'path';
import { DriftReport } from './types';

export interface DriftSnapshotRecord {
  snapshotId: string;
  capturedAt: number;
  driftReport: DriftReport;
}

export interface DriftStorageOptions {
  maxInMemory?: number;
  jsonlPath?: string;
}

export class DriftStorage {
  private readonly maxInMemory: number;
  private readonly jsonlPath?: string;
  private readonly inMemory: DriftSnapshotRecord[] = [];

  constructor(options: DriftStorageOptions = {}) {
    this.maxInMemory = options.maxInMemory ?? 240; // 20 hours at 5 min interval
    this.jsonlPath = options.jsonlPath;
    if (this.jsonlPath) {
      const dir = path.dirname(this.jsonlPath);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.jsonlPath)) {
        const content = fs.readFileSync(this.jsonlPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as DriftSnapshotRecord;
            if (record && typeof record.snapshotId === 'string') {
              this.inMemory.push(record);
            }
          } catch {
            continue;
          }
        }
        while (this.inMemory.length > this.maxInMemory) {
          this.inMemory.shift();
        }
      }
    }
  }

  add(record: DriftSnapshotRecord): void {
    this.inMemory.push(record);
    while (this.inMemory.length > this.maxInMemory) {
      this.inMemory.shift();
    }

    if (this.jsonlPath) {
      fs.appendFileSync(this.jsonlPath, JSON.stringify(record) + '\n', 'utf8');
    }
  }

  history(limit = 100): DriftSnapshotRecord[] {
    const slice = this.inMemory.slice(-limit);
    return slice;
  }

  latest(): DriftSnapshotRecord | null {
    return this.inMemory.length ? this.inMemory[this.inMemory.length - 1] : null;
  }
}

