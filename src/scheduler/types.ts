/**
 * VeriNode Backend — Distributed Job Scheduler: Core Types
 *
 * Defines the job lifecycle states, lease mechanisms, and worker
 * abstractions for the distributed job scheduler with lease-based
 * worker claiming.
 */

import type { Span } from '@opentelemetry/api';

// ── Job Lifecycle ────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export type JobType = string;

export interface JobDefinition<T = unknown> {
  id: string;
  jobType: JobType;
  payload: T;
  status: JobStatus;
  runAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  retryCount: number;
  maxRetries: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Scheduling ───────────────────────────────────────────────────────────────

export interface ScheduleOptions {
  /** Earliest time the job should run. Default: now. */
  runAt?: Date;
  /** Maximum retry attempts before moving to DLQ. Default: 3. */
  maxRetries?: number;
}

// ── Lease Management ─────────────────────────────────────────────────────────

export interface LeaseConfig {
  /** Duration a worker holds a lease before it expires (ms). */
  leaseDurationMs: number;
  /** How often to renew the lease while executing (ms). */
  leaseRenewIntervalMs: number;
  /** Maximum time a job can execute before being considered stuck. */
  maxExecutionTimeMs: number;
}

export const DEFAULT_LEASE_CONFIG: LeaseConfig = {
  leaseDurationMs: 30_000,
  leaseRenewIntervalMs: 10_000,
  maxExecutionTimeMs: 300_000,
};

// ── Worker ───────────────────────────────────────────────────────────────────

export interface JobExecutionContext {
  /** OTel span for distributed tracing. */
  span: Span;
  /** Renew the lease to prevent expiration during long-running jobs. */
  renewLease(): Promise<void>;
  /** Unique ID of the worker executing this job. */
  workerId: string;
}

export type JobHandler<T = unknown> = (payload: T, ctx: JobExecutionContext) => Promise<void>;

export interface WorkerConfig {
  /** How often to poll for new jobs (ms). */
  pollIntervalMs: number;
  /** Maximum concurrent jobs this worker processes. */
  maxConcurrency: number;
  /** Unique identifier for this worker instance. */
  workerId: string;
  /** Lease override. */
  lease?: Partial<LeaseConfig>;
}

export const DEFAULT_WORKER_CONFIG: Omit<WorkerConfig, 'workerId'> = {
  pollIntervalMs: 500,
  maxConcurrency: 1,
};

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface JobMetricsSnapshot {
  jobsPending: number;
  jobsRunning: number;
  jobsCompleted: number;
  jobsFailed: number;
  executionDurationsMs: number[];
  leaseTimeouts: number;
  retryCounts: number[];
}

// ── Job Store Interface ──────────────────────────────────────────────────────

export interface RowLockRecord {
  id: string;
  job_type: string;
  payload: unknown;
  status: JobStatus;
  run_at: Date | string;
  locked_until: Date | string | null;
  locked_by: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface JobStore {
  scheduleJob<T>(jobType: JobType, payload: T, options?: ScheduleOptions): Promise<string>;
  claimJob(
    jobType: JobType,
    workerId: string,
    leaseDurationMs: number,
  ): Promise<JobDefinition | null>;
  completeJob(jobId: string): Promise<void>;
  failJob(jobId: string, errorMessage: string): Promise<void>;
  renewLease(jobId: string, workerId: string, leaseDurationMs: number): Promise<boolean>;
  getJob(jobId: string): Promise<JobDefinition | null>;
  getQueueDepth(jobType?: JobType): Promise<number>;
  purgeCompleted(olderThan: Date): Promise<number>;
}
