import { randomBytes, createHash } from 'node:crypto';

export interface ChallengeRecord {
  nonceHex: string;
  ip: string;
  userAgent: string;
  expiresAt: number;
}

export interface NonceStore {
  setChallenge(nonceHex: string, record: ChallengeRecord, ttlMs: number): Promise<void>;
  getChallenge(nonceHex: string): Promise<ChallengeRecord | null>;
  deleteChallenge(nonceHex: string): Promise<void>;
  setRefreshTokenHash(tokenHash: string, ttlMs: number): Promise<void>;
  hasRefreshTokenHash(tokenHash: string): Promise<boolean>;
  deleteRefreshTokenHash(tokenHash: string): Promise<void>;
}

export class MemoryNonceStore implements NonceStore {
  private challenges = new Map<string, ChallengeRecord>();
  private refreshHashes = new Map<string, number>();

  async setChallenge(nonceHex: string, record: ChallengeRecord, _ttlMs: number): Promise<void> {
    this.challenges.set(nonceHex, record);
  }

  async getChallenge(nonceHex: string): Promise<ChallengeRecord | null> {
    const record = this.challenges.get(nonceHex);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      this.challenges.delete(nonceHex);
      return null;
    }
    return record;
  }

  async deleteChallenge(nonceHex: string): Promise<void> {
    this.challenges.delete(nonceHex);
  }

  async setRefreshTokenHash(tokenHash: string, _ttlMs: number): Promise<void> {
    this.refreshHashes.set(tokenHash, Date.now() + _ttlMs);
  }

  async hasRefreshTokenHash(tokenHash: string): Promise<boolean> {
    const exp = this.refreshHashes.get(tokenHash);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.refreshHashes.delete(tokenHash);
      return false;
    }
    return true;
  }

  async deleteRefreshTokenHash(tokenHash: string): Promise<void> {
    this.refreshHashes.delete(tokenHash);
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(48).toString('base64url');
}
