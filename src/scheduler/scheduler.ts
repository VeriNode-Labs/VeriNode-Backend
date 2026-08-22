/**
 * VeriNode Backend — Distributed Job Scheduler
 *
 * Core scheduler and worker implementation with lease-based worker claiming.
 * Workers poll for jobs using SKIP LOCKED, execute them with lease renewal,
 * and handle failures with retry and dead-letter routing.
 *
 * Performance target: < 100ms P99 lease acquisition (SKIP LOCKED).
 * Availability target: 99.99% (lease-based recovery on worker death).
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

import { createLogger } from '../diagnostics/logger';
import { PostgresJobStore } from './job_store';
import { JobSchedulerMetrics } from './metrics';
import { DeadLetterQueueManager } from '../queue/dead_letter_queue';

import type {
  JobDefinition,
  JobHandler,
  JobExecutionContext,
  JobStore,
  ScheduleOptions,
  JobType,
  WorkerConfig,
  LeaseConfig,
} from './types';
import { DEFAULT_LEASE_CONFIG, DEFAULT_WORKER_CONFIG } from './types';

// ── Tracer ───────────────────────────────────────────────────────────────────

const tracer = trace.getTracer('verinode-backend.job-scheduler', '1.0.0');

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function workerIdFromConfig(config: WorkerConfig): string {
  if (config.workerId) return config.workerId;
  return `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── JobScheduler ─────────────────────────────────────────────────────────────

export interface JobSchedulerOptions {
  db: import('../config/database').Database;
  dlqManager?: DeadLetterQueueManager;
  lease?: Partial<LeaseConfig>;
}

export class JobScheduler {
  private readonly jobStore: PostgresJobStore;
  private readonly metrics = new JobSchedulerMetrics();
  private readonly log = createLogger('job-scheduler');
  private readonly leaseConfig: LeaseConfig;
  private readonly dlqManager?: DeadLetterQueueManager;
  private readonly workers = new Map<string, JobWorker<any>>();

  constructor(options: JobSchedulerOptions) {
    this.jobStore = new PostgresJobStore(options.db);
    this.leaseConfig = { ...DEFAULT_LEASE_CONFIG, ...options.lease };
    this.dlqManager = options.dlqManager;
  }

  // ── Schedule ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a job for distributed execution.
   * Returns the job ID for tracking.
   */
  async schedule<T>(jobType: JobType, payload: T, options?: ScheduleOptions): Promise<string> {
    const jobId = await this.jobStore.scheduleJob(jobType, payload, options);
    this.log.info('Job scheduled', {
      job_id: jobId,
      job_type: jobType,
    });
    return jobId;
  }

  // ── Worker Management ────────────────────────────────────────────────────

  /**
   * Register a handler for a job type and start a worker to process it.
   */
  registerWorker<T>(
    jobType: JobType,
    handler: JobHandler<T>,
    config?: Partial<WorkerConfig>,
  ): JobWorker<T> {
    const resolvedWorkerId =
      config?.workerId ??
      workerIdFromConfig({
        ...DEFAULT_WORKER_CONFIG,
        ...(config ?? {}),
      } as WorkerConfig);
    const fullConfig: WorkerConfig = {
      ...DEFAULT_WORKER_CONFIG,
      ...(config ?? {}),
      workerId: resolvedWorkerId,
    };

    const worker = new JobWorker<T>(
      this.jobStore,
      jobType,
      handler,
      this.metrics,
      this.leaseConfig,
      fullConfig,
      this.dlqManager,
      this.log,
    );

    this.workers.set(`${jobType}:${fullConfig.workerId}`, worker);
    return worker;
  }

  /**
   * Start all registered workers.
   */
  startAll(): void {
    for (const worker of this.workers.values()) {
      worker.start();
    }
    this.log.info('All workers started', { worker_count: this.workers.size });
  }

  /**
   * Stop all workers gracefully.
   */
  async stopAll(): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const worker of this.workers.values()) {
      stops.push(worker.stop());
    }
    await Promise.all(stops);
    this.log.info('All workers stopped');
  }

  // ── Queue Info ───────────────────────────────────────────────────────────

  async queueDepth(jobType?: JobType): Promise<number> {
    return this.jobStore.getQueueDepth(jobType);
  }

  async getJob(jobId: string): Promise<JobDefinition | null> {
    return this.jobStore.getJob(jobId);
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────

  /**
   * Purge completed/failed jobs older than the specified date.
   */
  async purgeCompleted(olderThan: Date): Promise<number> {
    return this.jobStore.purgeCompleted(olderThan);
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  prometheusMetrics(): string {
    return this.metrics.renderPrometheus();
  }

  getMetrics(): ReturnType<JobSchedulerMetrics['getSnapshot']> {
    return this.metrics.getSnapshot();
  }
}

// ── JobWorker ────────────────────────────────────────────────────────────────

export class JobWorker<T = unknown> {
  private readonly handler: JobHandler<T>;
  private readonly metrics: JobSchedulerMetrics;
  private readonly leaseConfig: LeaseConfig;
  private readonly config: WorkerConfig;
  private readonly dlqManager?: DeadLetterQueueManager;
  private readonly log: ReturnType<typeof createLogger>;
  private readonly jobStore: JobStore;
  private readonly _jobType: JobType;

  private _running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeJobs = 0;

  constructor(
    jobStore: JobStore,
    jobType: JobType,
    handler: JobHandler<T>,
    metrics: JobSchedulerMetrics,
    leaseConfig: LeaseConfig,
    config: WorkerConfig,
    dlqManager: DeadLetterQueueManager | undefined,
    log: ReturnType<typeof createLogger>,
  ) {
    this.jobStore = jobStore;
    this._jobType = jobType;
    this.handler = handler;
    this.metrics = metrics;
    this.leaseConfig = leaseConfig;
    this.config = config;
    this.dlqManager = dlqManager;
    this.log = log.child(`worker:${jobType}`, {
      worker_id: config.workerId,
      job_type: jobType,
    });
  }

  get isRunning(): boolean {
    return this._running;
  }

  get jobType(): string {
    return this._jobType;
  }

  get workerId(): string {
    return this.config.workerId;
  }

  // ── Start / Stop ─────────────────────────────────────────────────────────

  start(): void {
    if (this._running) return;
    this._running = true;
    this.log.info('Worker starting');
    this.poll();
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait for active jobs to drain (with timeout)
    const drainTimeout = 15_000;
    const start = Date.now();
    while (this.activeJobs > 0 && Date.now() - start < drainTimeout) {
      await sleep(100);
    }
    this.log.info('Worker stopped', {
      active_jobs_remaining: this.activeJobs,
    });
  }

  // ── Poll Loop ────────────────────────────────────────────────────────────

  private poll(): void {
    if (!this._running) return;

    if (this.activeJobs < this.config.maxConcurrency) {
      void this.tryClaimAndExecute();
    }

    this.timer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
  }

  private async tryClaimAndExecute(): Promise<void> {
    let claimed = false;
    try {
      const job = await this.jobStore.claimJob(
        this._jobType,
        this.config.workerId,
        this.leaseConfig.leaseDurationMs,
      );

      if (!job) {
        // No jobs available; update queue depth metric
        const depth = await this.jobStore.getQueueDepth(this._jobType);
        this.metrics.setQueueDepth(depth, this._jobType);
        return;
      }

      claimed = true;
      this.activeJobs++;
      this.log.info('Job claimed', {
        job_id: job.id,
        job_type: job.jobType,
      });

      await this.executeJob(job as JobDefinition<T>);
    } catch (err) {
      this.log.error('Error claiming job', {
        'error.message': err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (claimed) {
        this.activeJobs = Math.max(0, this.activeJobs - 1);
      }
    }
  }

  // ── Execute ──────────────────────────────────────────────────────────────

  private async executeJob(job: JobDefinition<T>): Promise<void> {
    const span = tracer.startSpan('job_execute', {
      attributes: {
        'job.id': job.id,
        'job.type': job.jobType,
        'job.retry_count': job.retryCount,
        'worker.id': this.config.workerId,
      },
    });

    const startTime = performance.now();
    let leaseInterval: ReturnType<typeof setInterval> | null = null;
    let success = false;

    try {
      // Start lease renewal timer
      leaseInterval = setInterval(async () => {
        try {
          const renewed = await this.jobStore.renewLease(
            job.id,
            this.config.workerId,
            this.leaseConfig.leaseDurationMs,
          );
          if (!renewed) {
            this.log.warn('Lease renewal failed — another worker may have claimed this job', {
              job_id: job.id,
            });
            this.metrics.recordLeaseRenewalFailure();
            clearInterval(leaseInterval!);
          }
        } catch {
          this.metrics.recordLeaseRenewalFailure();
        }
      }, this.leaseConfig.leaseRenewIntervalMs);

      // Build execution context
      const ctx: JobExecutionContext = {
        span,
        workerId: this.config.workerId,
        renewLease: async () => {
          const renewed = await this.jobStore.renewLease(
            job.id,
            this.config.workerId,
            this.leaseConfig.leaseDurationMs,
          );
          if (!renewed) {
            throw new Error('Lease renewal failed — lease may have expired');
          }
        },
      };

      // Execute the job
      await this.handler(job.payload, ctx);

      // Mark complete
      await this.jobStore.completeJob(job.id);
      success = true;
      span.setStatus({ code: SpanStatusCode.OK });

      this.log.info('Job completed', {
        job_id: job.id,
        job_type: job.jobType,
        duration_ms: Math.round(performance.now() - startTime),
      });
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (job.retryCount < job.maxRetries) {
        // Requeue for retry by resetting the job to pending
        await this.jobStore.failJob(job.id, errorMessage);
        this.log.warn('Job failed, will retry', {
          job_id: job.id,
          retry_count: job.retryCount + 1,
          max_retries: job.maxRetries,
          'error.message': errorMessage,
        });
      } else {
        // Exhausted retries — route to DLQ if available
        await this.jobStore.failJob(job.id, errorMessage);
        this.log.error('Job failed permanently', {
          job_id: job.id,
          job_type: job.jobType,
          retry_count: job.retryCount,
          'error.message': errorMessage,
        });

        if (this.dlqManager) {
          try {
            await this.dlqManager.process(job.jobType, job.payload, async () => {
              throw err;
            });
          } catch {
            // DLQ insertion is best-effort
          }
        }
      }

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });
    } finally {
      if (leaseInterval) clearInterval(leaseInterval);

      const durationMs = performance.now() - startTime;
      this.metrics.recordExecution({
        jobType: job.jobType,
        durationMs: Math.round(durationMs),
        success,
        retryCount: job.retryCount,
      });

      span.end();
    }
  }
}
