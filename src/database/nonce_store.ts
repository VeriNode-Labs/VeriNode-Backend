import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface WalEntry {
  nonce: string;
  txHash: string;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
}

export class NonceStore {
  private walPath: string;
  private waterMarkPath: string;
  private buffer: WalEntry[] = [];
  private flushThreshold: number;

  constructor(dataDir: string, flushThreshold = 64) {
    this.walPath = join(dataDir, 'slashing_nonce_wal.jsonl');
    this.waterMarkPath = join(dataDir, 'nonce_water_mark.json');
    this.flushThreshold = flushThreshold;

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  append(entry: WalEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.flushThreshold) {
      this.flush();
    }
  }

  flush(): void {
    for (const entry of this.buffer) {
      appendFileSync(this.walPath, JSON.stringify(entry) + '\n', 'utf-8');
    }
    this.buffer = [];
  }

  advanceWaterMark(nonce: string): void {
    writeFileSync(this.waterMarkPath, JSON.stringify({ nonce }), 'utf-8');
  }

  getWaterMark(): string {
    try {
      const data = readFileSync(this.waterMarkPath, 'utf-8');
      const parsed = JSON.parse(data);
      return parsed.nonce as string;
    } catch {
      return '0';
    }
  }

  replayUnconfirmed(): WalEntry[] {
    if (!existsSync(this.walPath)) return [];
    const content = readFileSync(this.walPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .map((line) => JSON.parse(line) as WalEntry)
      .filter((e) => e.status === 'pending');
  }

  purgeConfirmed(upToNonce: string): void {
    if (!existsSync(this.walPath)) return;
    const content = readFileSync(this.walPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const upTo = BigInt(upToNonce);
    const remaining = lines
      .map((line) => JSON.parse(line) as WalEntry)
      .filter((e) => e.status !== 'confirmed' && BigInt(e.nonce) > upTo);
    writeFileSync(this.walPath, remaining.map((e) => JSON.stringify(e)).join('\n'), 'utf-8');
  }
}
