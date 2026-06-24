import { Database } from '../config/database';
import { RpcClient } from './rpc_client';
import { TransactionBuilder, BatchRenewalResult } from './transaction_builder';
import { createLogger } from '../diagnostics/logger';
import {
  ContractDataPointer,
  CriticalDataKey,
  RENEWAL_THRESHOLD_LEDGERS,
  DEFAULT_TTL_LEDGERS,
  buildWatchedPointers,
} from '../contracts/verification_contract';

export interface WatchlistRow {
  contractId: string;
  dataKey: CriticalDataKey;
  currentTtlLedgers: number;
  lastRenewedAt: Date | null;
}

export interface StateArchivalListenerOptions {
  pollIntervalMs?: number;
  /** Minimum time between renewal attempts for the same pointer, regardless of TTL. */
  minRenewalGapMs?: number;
  onMetric?: (contractId: string, dataKey: string, ttlRemaining: number) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MIN_RENEWAL_GAP_MS = 5 * 60_000; // 5 minutes

/**
 * Watches the critical Soroban contract data keys for every registered
 * verification node and renews their TTL before they archive. See
 * issue #20 for the full spec — this loop is the resolution for the
 * "missed TTL extension causes permanent data loss" problem.
 */
export class StateArchivalListener {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly minRenewalGapMs: number;
  private readonly onMetric?: StateArchivalListenerOptions['onMetric'];
  private log = createLogger('state_archival');

  constructor(
    private db: Database,
    private rpcClient: RpcClient,
    private txBuilder: TransactionBuilder = new TransactionBuilder(rpcClient),
    options: StateArchivalListenerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.minRenewalGapMs = options.minRenewalGapMs ?? DEFAULT_MIN_RENEWAL_GAP_MS;
    this.onMetric = options.onMetric;
  }

  /** Starts the recurring poll loop. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error('tick failed', {
          'error.message': err instanceof Error ? err.message : String(err),
        });
      });
    }, this.pollIntervalMs);
    // Run an immediate tick on start rather than waiting a full interval,
    // so a process restart near TTL expiry doesn't lose extra time.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Reads the persisted watchlist from state_archival_watchlist. */
  async loadWatchlist(): Promise<WatchlistRow[]> {
    const result = await this.db.query<{
      contract_id: string;
      data_key: CriticalDataKey;
      current_ttl_ledgers: number;
      last_renewed_at: Date | null;
    }>(
      `SELECT contract_id, data_key, current_ttl_ledgers, last_renewed_at
       FROM state_archival_watchlist`,
    );
    return result.rows.map((r: {
      contract_id: string;
      data_key: CriticalDataKey;
      current_ttl_ledgers: number;
      last_renewed_at: Date | null;
    }) => ({
      contractId: r.contract_id,
      dataKey: r.data_key,
      currentTtlLedgers: r.current_ttl_ledgers,
      lastRenewedAt: r.last_renewed_at,
    }));
  }

  /** Registers all 5 critical keys for a verification node into the watchlist. */
  async registerNode(contractId: string): Promise<void> {
    const pointers = buildWatchedPointers(contractId);
    await this.db.transaction(async (client) => {
      for (const p of pointers) {
        await client.query(
          `INSERT INTO state_archival_watchlist (contract_id, data_key, current_ttl_ledgers, last_renewed_at)
           VALUES ($1, $2, $3, NULL)
           ON CONFLICT (contract_id, data_key) DO NOTHING`,
          [p.contractId, p.dataKey, DEFAULT_TTL_LEDGERS],
        );
      }
    });
  }

  /** Single poll iteration: query live TTLs, renew anything due, persist updates. */
  async tick(): Promise<void> {
    const watchlist = await this.loadWatchlist();
    if (watchlist.length === 0) return;

    const due: { row: WatchlistRow; liveTtl: number }[] = [];
    const now = Date.now();

    for (const row of watchlist) {
      const entry = await this.rpcClient.getLedgerEntry(row.contractId, row.dataKey);
      if ('code' in entry) {
        this.log.warn('getLedgerEntry failed', {
          'contract.id': row.contractId,
          'data.key': row.dataKey,
          'error.message': entry.message,
        });
        continue;
      }

      this.onMetric?.(row.contractId, row.dataKey, entry.ttl);

      const lastRenewedMs = row.lastRenewedAt ? row.lastRenewedAt.getTime() : 0;
      const pastMinGap = now - lastRenewedMs > this.minRenewalGapMs;

      if (entry.ttl < RENEWAL_THRESHOLD_LEDGERS && pastMinGap) {
        due.push({ row, liveTtl: entry.ttl });
      }
    }

    if (due.length === 0) return;

    // Group by contract so each batched tx renews all critical keys for
    // one node together (gas efficiency), respecting the 20-entry cap.
    const byContract = new Map<string, WatchlistRow[]>();
    for (const { row } of due) {
      const list = byContract.get(row.contractId) ?? [];
      list.push(row);
      byContract.set(row.contractId, list);
    }

    for (const [contractId, rows] of byContract) {
      const pointers: ContractDataPointer[] = rows.map((r) => ({
        contractId: r.contractId,
        dataKey: r.dataKey,
      }));

      for (const chunk of TransactionBuilder.chunk(pointers)) {
        const result = await this.txBuilder.submitBatchRenewal({
          pointers: chunk,
          extendToLedgers: DEFAULT_TTL_LEDGERS,
        });
        await this.applyRenewalResult(contractId, result);
      }
    }
  }

  /** Persists successful renewals back to the watchlist table. */
  private async applyRenewalResult(contractId: string, result: BatchRenewalResult): Promise<void> {
    if (!result.txResult.success || result.renewedPointers.length === 0) {
      this.log.error('renewal failed', {
        'contract.id': contractId,
        attempts: result.attempts,
      });
      return;
    }

    await this.db.transaction(async (client) => {
      for (const p of result.renewedPointers) {
        await client.query(
          `UPDATE state_archival_watchlist
           SET current_ttl_ledgers = $1, last_renewed_at = NOW()
           WHERE contract_id = $2 AND data_key = $3`,
          [DEFAULT_TTL_LEDGERS, p.contractId, p.dataKey],
        );
      }
    });
  }

  /** Manual override: immediately renews every critical key for a contract. */
  async renewNow(contractId: string): Promise<{ ttl: number; txHash: string }> {
    const pointers = buildWatchedPointers(contractId);
    const result = await this.txBuilder.submitBatchRenewal({
      pointers,
      extendToLedgers: DEFAULT_TTL_LEDGERS,
    });
    await this.applyRenewalResult(contractId, result);
    if (!result.txResult.success) {
      throw new Error(`manual renewal failed for ${contractId} after ${result.attempts} attempt(s)`);
    }
    return { ttl: DEFAULT_TTL_LEDGERS, txHash: result.txResult.hash };
  }
}
