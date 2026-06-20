import { RpcClient, TransactionResult } from '../blockchain/rpc_client';
import { NonceStore, WalEntry } from '../database/nonce_store';
import { SlashingTx, SlashingResult, SlashingAgent, SlashingMetrics } from './slashing_agent';
import { trace, context, SpanStatusCode, type Span } from '@opentelemetry/api';

const NONCE_WINDOW_SIZE = 1024;
const WAL_FLUSH_INTERVAL = 64;

const tracer = trace.getTracer('verinode-backend.slashing-sequencer', '1.0.0');

/**
 * Lightweight handle kept for backwards compatibility with the existing
 * call sites in this file. The .span field carries the real OpenTelemetry
 * Span and is what gets ended on endSpan().
 */
export interface SpanContext {
  traceId: string;
  spanId: string;
  span: Span;
}

function startSpan(name: string, parent?: SpanContext): SpanContext {
  let ctx = context.active();
  if (parent?.span) {
    ctx = trace.setSpan(ctx, parent.span);
  }
  const span = tracer.startSpan(name, { attributes: { 'slashing.stage': name } }, ctx);
  const sc = span.spanContext();
  return { traceId: sc.traceId, spanId: sc.spanId, span };
}

function endSpan(handle: SpanContext | undefined, error?: Error): void {
  if (!handle?.span) return;
  if (!handle.span.isRecording()) return;
  if (error) {
    handle.span.recordException(error);
    handle.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else {
    handle.span.setStatus({ code: SpanStatusCode.OK });
  }
  handle.span.end();
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
    let nonce: bigint;
    try {
      nonce = this.reserveNonce();
      reserveSpan.span.setAttribute('slashing.nonce', nonce.toString());
    } catch (err) {
      endSpan(reserveSpan, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    endSpan(reserveSpan);

    const walEntry: WalEntry = {
      nonce: nonce.toString(),
      txHash: '',
      timestamp: Date.now(),
      status: 'pending',
    };
    this.nonceStore.append(walEntry);

    const submitSpan = startSpan('tx_submit', reserveSpan);
    let result: TransactionResult;
    try {
      const txPayload = this.buildTx(tx, nonce);
      submitSpan.span.setAttribute('slashing.validator_id', tx.validatorId);
      // Propagate the submit-span context across the await so any child
      // spans created by HttpInstrumentation inside sendTransaction are
      // parented to submitSpan in the trace tree.
      result = await context.with(
        trace.setSpan(context.active(), submitSpan.span),
        () => this.rpcClient.sendTransaction(txPayload),
      );
      submitSpan.span.setAttribute('slashing.tx_success', result.success);
    } catch (err) {
      endSpan(submitSpan, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    endSpan(submitSpan);

    const confirmSpan = startSpan('tx_confirm', submitSpan);
    this.totalSubmitted++;

    if (result.success) {
      walEntry.txHash = result.hash;
      walEntry.status = 'confirmed';
      this.totalConfirmed++;
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.advanceWaterMark();
      confirmSpan.span.setAttribute('slashing.tx_hash', result.hash);
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
    const errMsg = result.error?.message ?? 'Unknown error';
    endSpan(confirmSpan, new Error(errMsg));

    return {
      validatorId: tx.validatorId,
      nonce,
      txHash: '',
      success: false,
      error: errMsg,
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
    const span = startSpan('tx_resubmit');
    this.totalSubmitted++;
    this.pendingCount++;
    try {
      // Propagate the resubmit-span context across the await boundary.
      const result = await context.with(
        trace.setSpan(context.active(), span.span),
        () => this.rpcClient.sendTransaction(entry.txHash),
      );
      if (result.success) {
        entry.status = 'confirmed';
        this.totalConfirmed++;
        this.pendingCount = Math.max(0, this.pendingCount - 1);
        span.span.setAttribute('slashing.tx_hash', result.hash);
      } else {
        entry.status = 'failed';
        this.totalFailed++;
        this.pendingCount = Math.max(0, this.pendingCount - 1);
        endSpan(span, new Error(result.error?.message ?? 'sub-resubmit failed'));
        return;
      }
    } catch (err) {
      endSpan(span, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    endSpan(span);
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
