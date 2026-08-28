import { Database } from '../config/database';
import { AttestationStore } from './store';
import { ReputationStore } from '../reputation/store';
import { processOne, ProcessOneResult } from './worker';
import { createLogger } from '../diagnostics/logger';

const log = createLogger('attestation-batch-processor');

export interface BatchProcessorOptions {
  workerCount?: number;
  maxBatchSize?: number;
}

export class AttestationBatchProcessor {
  private readonly attestationStore: AttestationStore;
  private readonly reputationStore: ReputationStore;
  private readonly workerCount: number;
  private readonly maxBatchSize: number;

  constructor(private db: Database, options: BatchProcessorOptions = {}) {
    this.attestationStore = new AttestationStore(db);
    this.reputationStore = new ReputationStore(db);
    this.workerCount = options.workerCount ?? 4;
    this.maxBatchSize = options.maxBatchSize ?? 100;
  }

  /**
   * Drains up to maxBatchSize pending attestations using a pool of
   * `workerCount` concurrent workers. Each worker claims one row at a
   * time with FOR UPDATE SKIP LOCKED so no two workers process the same
   * attestation, and stops once the shared budget is exhausted or no
   * pending rows remain.
   */
  async processBatch(): Promise<ProcessOneResult[]> {
    let remaining = this.maxBatchSize;
    const results: ProcessOneResult[] = [];

    const runWorker = async (): Promise<void> => {
      for (;;) {
        if (remaining <= 0) return;
        remaining -= 1;

        const outcome = await this.db.transaction(async (client) => {
          const [claimed] = await this.attestationStore.assignWork(client, 1);
          if (!claimed) return null;
          return processOne(client, this.attestationStore, this.reputationStore, claimed);
        });

        if (!outcome) {
          remaining = 0; // no more pending work; let other workers stop too
          return;
        }

        results.push(outcome);
      }
    };

    await Promise.all(Array.from({ length: this.workerCount }, runWorker));

    log.info('Batch processed', { processed: results.length, worker_count: this.workerCount });
    return results;
  }
}
