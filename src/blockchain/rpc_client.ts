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
}
