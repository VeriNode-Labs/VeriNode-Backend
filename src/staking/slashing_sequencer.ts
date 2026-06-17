import { RpcClient, TransactionResult } from '../blockchain/rpc_client';
import { NonceStore, WalEntry } from '../database/nonce_store';
import { SlashingTx, SlashingResult, SlashingAgent, SlashingMetrics } from './slashing_agent';

const NONCE_WINDOW_SIZE = 1024;
const WAL_FLUSH_INTERVAL = 64;

interface SpanContext {
  traceId: string;
  spanId: string;
}

function startSpan(name: string, parent?: SpanContext): SpanContext {
  return { traceId: parent?.traceId ?? crypto.randomUUID(), spanId: crypto.randomUUID() };
}

function endSpan(span: SpanContext): void {
}

export class NonceSequencer implements SlashingAgent {
  private rpcClient: RpcClient;
  private nonceStore: NonceStore;
  private headPointer: bigint = 0n;
  private waterMark: bigint = 0n;
  private walFlushCounter = 0;
  private totalSubmitted = 0;
  private totalConfirmed = 0;
  private totalFailed = 0;
  private pendingCount = 0;

  constructor(rpcClient: RpcClient, nonceStore: NonceStore) {
    this.rpcClient = rpcClient;
    this.nonceStore = nonceStore;
    this.waterMark = BigInt(nonceStore.getWaterMark());
    this.headPointer = this.waterMark;

    const unconfirmed = nonceStore.replayUnconfirmed();
    for (const entry of unconfirmed) {
      this.resubmitEntry(entry);
    }
  }

  async onSlashingRequest(tx: SlashingTx): Promise<SlashingResult> {
    const reserveSpan = startSpan('nonce_reserve');
    const nonce = this.reserveNonce();
    endSpan(reserveSpan);

    const walEntry: WalEntry = {
      nonce: nonce.toString(),
      txHash: '',
      timestamp: Date.now(),
      status: 'pending',
    };
    this.nonceStore.append(walEntry);

    const submitSpan = startSpan('tx_submit', reserveSpan);
    const txPayload = this.buildTx(tx, nonce);
    const result = await this.rpcClient.sendTransaction(txPayload);
    endSpan(submitSpan);

    const confirmSpan = startSpan('tx_confirm', submitSpan);
    this.totalSubmitted++;

    if (result.success) {
      walEntry.txHash = result.hash;
      walEntry.status = 'confirmed';
      this.totalConfirmed++;
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.advanceWaterMark();
      endSpan(confirmSpan);

      return {
        validatorId: tx.validatorId,
        nonce,
        txHash: result.hash,
        success: true,
      };
    }

    walEntry.status = 'failed';
    this.totalFailed++;
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    endSpan(confirmSpan);

    return {
      validatorId: tx.validatorId,
      nonce,
      txHash: '',
      success: false,
      error: result.error?.message ?? 'Unknown error',
    };
  }

  private reserveNonce(): bigint {
    const nonce = this.headPointer;
    this.headPointer = this.headPointer + 1n;

    this.walFlushCounter++;
    if (this.walFlushCounter % WAL_FLUSH_INTERVAL === 0) {
      this.nonceStore.flush();
    }

    return nonce;
  }

  private advanceWaterMark(): void {
    this.waterMark = this.waterMark + 1n;
    if (this.walFlushCounter % WAL_FLUSH_INTERVAL === 0) {
      this.nonceStore.advanceWaterMark(this.waterMark.toString());
      this.nonceStore.purgeConfirmed(this.waterMark.toString());
    }
  }

  private buildTx(tx: SlashingTx, nonce: bigint): string {
    return JSON.stringify({
      nonce: nonce.toString(),
      validatorId: tx.validatorId,
      misbehaviorType: tx.misbehaviorType,
      evidence: tx.evidence,
      signature: tx.signature,
    });
  }

  private async resubmitEntry(entry: WalEntry): Promise<void> {
    this.totalSubmitted++;
    this.pendingCount++;
    const result = await this.rpcClient.sendTransaction(entry.txHash);
    if (result.success) {
      entry.status = 'confirmed';
      this.totalConfirmed++;
      this.pendingCount = Math.max(0, this.pendingCount - 1);
    } else {
      entry.status = 'failed';
      this.totalFailed++;
      this.pendingCount = Math.max(0, this.pendingCount - 1);
    }
  }

  getMetrics(): SlashingMetrics {
    return {
      totalSubmitted: this.totalSubmitted,
      totalConfirmed: this.totalConfirmed,
      totalFailed: this.totalFailed,
      currentNonce: this.headPointer.toString(),
      pendingCount: this.pendingCount,
    };
  }
}

export class NonceWindow {
  private slots: (bigint | null)[];
  private head: number = 0;
  private size: number;

  constructor(size: number = NONCE_WINDOW_SIZE) {
    this.size = size;
    this.slots = new Array(size).fill(null);
  }

  claim(): bigint | null {
    for (let i = 0; i < this.size; i++) {
      const index = (this.head + i) % this.size;
      if (this.slots[index] === null) {
        const nonce = BigInt(index);
        this.slots[index] = nonce;
        this.head = (index + 1) % this.size;
        return nonce;
      }
    }
    return null;
  }

  release(nonce: bigint): void {
    const index = Number(nonce % BigInt(this.size));
    if (this.slots[index] === nonce) {
      this.slots[index] = null;
    }
  }
}
