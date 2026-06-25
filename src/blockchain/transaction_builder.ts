import { RpcClient, TransactionResult, PreflightReport } from './rpc_client';
import { ContractDataPointer, MAX_BATCH_TTL_ENTRIES } from '../contracts/verification_contract';
import { createLogger } from '../diagnostics/logger';

export interface ExtendFootprintTTLParams {
  pointers: ContractDataPointer[];
  /** New minimum TTL, in ledgers, applied to every entry in the batch. */
  extendToLedgers: number;
  preflight?: PreflightReport;
}

export interface BatchRenewalResult {
  txResult: TransactionResult;
  renewedPointers: ContractDataPointer[];
  attempts: number;
}

/** Backoff schedule (ms) per spec: 1st retry 10s, 2nd 30s, 3rd (final) 90s. */
const DEFAULT_RETRY_DELAYS_MS = [10_000, 30_000, 90_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds and submits a single batched ExtendFootprintTTLOp-style
 * transaction covering up to MAX_BATCH_TTL_ENTRIES data-key pointers.
 * On HostError-class failures, retries with exponential backoff before
 * giving up so a transient RPC hiccup doesn't let a critical key archive.
 */
export class TransactionBuilder {
  private log = createLogger('transaction_builder');
  private retryDelays: number[];

  constructor(private rpcClient: RpcClient, retryDelays?: number[]) {
    this.retryDelays = retryDelays ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** Encodes the batch into the (placeholder) XDR transaction envelope. */
  private encodeExtendFootprintTx(params: ExtendFootprintTTLParams): string {
    const keys = params.pointers.map((p) => `${p.contractId}:${p.dataKey}`);
    const txData: any = {
      op: 'ExtendFootprintTTL',
      keys,
      extendTo: params.extendToLedgers,
    };

    if (params.preflight) {
      txData.instructions = params.preflight.estimatedGas;
      this.log.debug('Applying preflight gas estimate to transaction', {
        estimatedGas: params.preflight.estimatedGas,
      });
    }

    return Buffer.from(JSON.stringify(txData)).toString('base64');
  }

  async submitBatchRenewal(params: ExtendFootprintTTLParams): Promise<BatchRenewalResult> {
    if (params.pointers.length === 0) {
      return {
        txResult: { hash: '', success: true },
        renewedPointers: [],
        attempts: 0,
      };
    }
    if (params.pointers.length > MAX_BATCH_TTL_ENTRIES) {
      throw new Error(
        `Batch size ${params.pointers.length} exceeds maximum of ${MAX_BATCH_TTL_ENTRIES} entries per transaction`,
      );
    }

    const tx = this.encodeExtendFootprintTx(params);
    let attempts = 0;
    let lastResult: TransactionResult = { hash: '', success: false };

    for (let i = 0; i <= this.retryDelays.length; i++) {
      attempts++;
      lastResult = await this.rpcClient.sendTransaction(tx);
      if (lastResult.success) {
        return { txResult: lastResult, renewedPointers: params.pointers, attempts };
      }
      if (i < this.retryDelays.length) {
        await sleep(this.retryDelays[i]);
      }
    }

    return { txResult: lastResult, renewedPointers: [], attempts };
  }

  /** Splits a watchlist into chunks no larger than MAX_BATCH_TTL_ENTRIES. */
  static chunk(pointers: ContractDataPointer[]): ContractDataPointer[][] {
    const chunks: ContractDataPointer[][] = [];
    for (let i = 0; i < pointers.length; i += MAX_BATCH_TTL_ENTRIES) {
      chunks.push(pointers.slice(i, i + MAX_BATCH_TTL_ENTRIES));
    }
    return chunks;
  }
}
