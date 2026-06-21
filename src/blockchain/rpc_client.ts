export interface RpcError {
  code: number;
  message: string;
}

export interface TransactionResult {
  hash: string;
  success: boolean;
  error?: RpcError;
}

export interface RpcClientConfig {
  endpoint: string;
  timeoutMs: number;
}

export interface LedgerEntryData {
  /** Remaining TTL in ledgers before the entry is archived. */
  ttl: number;
  /** Raw XDR-encoded entry value (base64), passed through untouched. */
  xdr: string;
  /** Ledger sequence the entry currently lives at. */
  lastModifiedLedgerSeq: number;
}

export class RpcClient {
  private config: RpcClientConfig;

  constructor(config: RpcClientConfig) {
    this.config = config;
  }

  async sendTransaction(tx: string): Promise<TransactionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method: 'sendTransaction',
          params: { transaction: tx },
        }),
        signal: controller.signal,
      });

      const data: any = await response.json();
      if (data.error) {
        return { hash: '', success: false, error: data.error as RpcError };
      }
      return { hash: (data.result?.hash as string) ?? '', success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown RPC error';
      return { hash: '', success: false, error: { code: -32000, message } };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Queries the current ledger entry for a contract/data-key pair and
   * returns its remaining TTL plus raw entry data. Used by
   * StateArchivalListener to decide whether a renewal is due.
   */
  async getLedgerEntry(contractId: string, dataKey: string): Promise<LedgerEntryData | RpcError> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method: 'getLedgerEntries',
          params: { contractId, key: dataKey },
        }),
        signal: controller.signal,
      });

      const data: any = await response.json();
      if (data.error) {
        return data.error as RpcError;
      }
      const entry = data.result?.entries?.[0];
      if (!entry) {
        return { code: -32001, message: `no ledger entry found for ${contractId}:${dataKey}` };
      }
      return {
        ttl: Number(entry.liveUntilLedgerSeq ?? 0) - Number(data.result?.latestLedger ?? 0),
        xdr: (entry.xdr as string) ?? '',
        lastModifiedLedgerSeq: Number(entry.lastModifiedLedgerSeq ?? 0),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown RPC error';
      return { code: -32000, message };
    } finally {
      clearTimeout(timeout);
    }
  }
}
