/**
 * Tests for the Distributed Job Scheduler with Lease-based Worker Claiming.
 *
 * Compatible with the project's ts-node test runner.
 * Covers: job scheduling, SKIP LOCKED claiming, completion, failure,
 * lease renewal, concurrent claiming, metrics, and worker lifecycle.
 */

// ── Simple test runner ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`  ✗ ${name}: ${msg}`);
    process.stdout.write(`  ✗ ${name}\n    ${msg}\n`);
  }
}

// ── Mock Database ────────────────────────────────────────────────────────────

interface StoredJob {
  id: string;
  job_type: string;
  payload: unknown;
  status: string;
  run_at: string;
  locked_until: string | null;
  locked_by: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function createMockDb() {
  const jobs = new Map<string, StoredJob>();
  let seq = 0;

  return {
    jobs,
    query: (async (text: string, params?: unknown[]) => {
      // INSERT
      if (text.includes('INSERT INTO distributed_jobs')) {
        const id = `job-${++seq}`;
        const job: StoredJob = {
          id,
          job_type: params?.[0] as string,
          payload: JSON.parse(params?.[1] as string),
          status: 'pending',
          run_at: (params?.[2] as string) ?? new Date().toISOString(),
          locked_until: null,
          locked_by: null,
          retry_count: 0,
          max_retries: (params?.[3] as number) ?? 3,
          error_message: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        jobs.set(id, job);
        return { rows: [{ id }], rowCount: 1 };
      }
      // SELECT by id
      if (
        text.includes('SELECT * FROM distributed_jobs WHERE id = $1') &&
        !text.includes('FOR UPDATE')
      ) {
        const jobId = params?.[0] as string;
        const job = jobs.get(jobId);
        return { rows: job ? [toRow(job)] : [], rowCount: job ? 1 : 0 };
      }
      // SELECT COUNT (queue depth)
      if (text.includes('COUNT(*)')) {
        const jobType = params?.[0] as string | undefined;
        let count = 0;
        for (const [, job] of jobs) {
          if (
            (job.status === 'pending' || job.status === 'running') &&
            (!job.locked_until || new Date(job.locked_until) <= new Date()) &&
            (!jobType || job.job_type === jobType) &&
            new Date(job.run_at) <= new Date()
          ) {
            count++;
          }
        }
        return { rows: [{ count: String(count) }], rowCount: 1 };
      }
      // UPDATE claim (FOR UPDATE SKIP LOCKED)
      if (text.includes('FOR UPDATE SKIP LOCKED')) {
        const workerId = params?.[0] as string;
        const jobType = params?.[1] as string;
        let claimedJob: StoredJob | null = null;
        for (const [, job] of jobs) {
          if (
            job.job_type === jobType &&
            (job.status === 'pending' || job.status === 'running') &&
            (!job.locked_until || new Date(job.locked_until) <= new Date()) &&
            new Date(job.run_at) <= new Date()
          ) {
            claimedJob = job;
            break;
          }
        }
        if (claimedJob) {
          claimedJob.status = 'running';
          claimedJob.locked_until = new Date(Date.now() + 30000).toISOString();
          claimedJob.locked_by = workerId;
          claimedJob.updated_at = new Date().toISOString();
          return { rows: [toRow(claimedJob)], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      // UPDATE complete
      if (text.includes("status = 'completed'")) {
        const jobId = params?.[0] as string;
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'completed';
          job.locked_until = null;
          job.locked_by = null;
          job.updated_at = new Date().toISOString();
        }
        return { rows: [], rowCount: 1 };
      }
      // UPDATE fail
      if (text.includes("status = 'failed'") && text.includes('retry_count = retry_count + 1')) {
        const jobId = params?.[0] as string;
        const errorMsg = params?.[1] as string;
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.error_message = errorMsg;
          job.locked_until = null;
          job.locked_by = null;
          job.retry_count++;
          job.updated_at = new Date().toISOString();
        }
        return { rows: [], rowCount: 1 };
      }
      // UPDATE lease renewal
      if (
        text.includes('UPDATE distributed_jobs') &&
        text.includes('locked_until') &&
        text.includes('locked_by')
      ) {
        const jobId = params?.[0] as string;
        const worker = params?.[1] as string;
        const job = jobs.get(jobId);
        if (job && job.locked_by === worker && job.status === 'running') {
          job.locked_until = new Date(Date.now() + 30000).toISOString();
          job.updated_at = new Date().toISOString();
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      // DELETE purge
      if (text.includes('DELETE FROM distributed_jobs')) {
        let purged = 0;
        for (const [id, job] of jobs) {
          if (job.status === 'completed' || job.status === 'failed') {
            jobs.delete(id);
            purged++;
          }
        }
        return { rows: [], rowCount: purged };
      }
      return { rows: [], rowCount: 0 };
    }) as any,
  };
}

function toRow(job: StoredJob) {
  return {
    id: job.id,
    job_type: job.job_type,
    payload: job.payload,
    status: job.status,
    run_at: job.run_at,
    locked_until: job.locked_until,
    locked_by: job.locked_by,
    retry_count: job.retry_count,
    max_retries: job.max_retries,
    error_message: job.error_message,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n  PostgresJobStore');
  const { PostgresJobStore } = await import('../../src/scheduler/job_store');
  const { JobSchedulerMetrics } = await import('../../src/scheduler/metrics');
  const { JobScheduler } = await import('../../src/scheduler/scheduler');

  // ── JobStore tests ──
  await test('should schedule a job and return its ID', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobId = await store.scheduleJob('test_job', { data: 42 });
    assert(typeof jobId === 'string', 'jobId should be a string');
    assert(db.jobs.get(jobId)!.job_type === 'test_job', 'job type should match');
    assert(db.jobs.get(jobId)!.status === 'pending', 'status should be pending');
  });

  await test('should schedule with custom maxRetries', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobId = await store.scheduleJob('test_job', { data: 1 }, { maxRetries: 5 });
    assert(db.jobs.get(jobId)!.max_retries === 5, 'maxRetries should be 5');
  });

  await test('should claim a pending job', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    await store.scheduleJob('email_send', { to: 'a@b.com' });
    const job = await store.claimJob('email_send', 'worker-1', 30000);
    assert(job !== null, 'should claim a job');
    assert(job!.status === 'running', 'status should be running');
    assert(job!.lockedBy === 'worker-1', 'lockedBy should be worker-1');
  });

  await test('should return null when no jobs available', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const job = await store.claimJob('nonexistent', 'worker-1', 30000);
    assert(job === null, 'should return null');
  });

  await test('should not claim a locked job', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    await store.scheduleJob('email_send', { to: 'a@b.com' });
    for (const [, job] of db.jobs) {
      job.locked_until = new Date(Date.now() + 30000).toISOString();
      job.locked_by = 'worker-99';
    }
    const job = await store.claimJob('email_send', 'worker-1', 30000);
    assert(job === null, 'should not claim locked job');
  });

  await test('should claim a job with expired lease', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    await store.scheduleJob('email_send', { to: 'a@b.com' });
    for (const [, job] of db.jobs) {
      job.locked_until = new Date(Date.now() - 1000).toISOString();
    }
    const job = await store.claimJob('email_send', 'worker-2', 30000);
    assert(job !== null, 'should reclaim expired lease');
    assert(job!.lockedBy === 'worker-2', 'should be claimed by worker-2');
  });

  await test('should complete a job', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobId = await store.scheduleJob('test_job', { data: 1 });
    await store.completeJob(jobId);
    assert(db.jobs.get(jobId)!.status === 'completed', 'status should be completed');
    assert(db.jobs.get(jobId)!.locked_by === null, 'lockedBy should be null');
  });

  await test('should fail a job with error message', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobId = await store.scheduleJob('test_job', { data: 1 });
    await store.failJob(jobId, 'Something went wrong');
    assert(db.jobs.get(jobId)!.status === 'failed', 'status should be failed');
    assert(db.jobs.get(jobId)!.error_message === 'Something went wrong', 'error should match');
    assert(db.jobs.get(jobId)!.retry_count === 1, 'retry count should be 1');
  });

  await test('should renew lease successfully', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobId = await store.scheduleJob('test_job', { data: 1 });
    await store.claimJob('test_job', 'worker-1', 30000);
    const renewed = await store.renewLease(jobId, 'worker-1', 30000);
    assert(renewed === true, 'lease should renew');
  });

  await test('should fail lease renewal for wrong worker', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobId = await store.scheduleJob('test_job', { data: 1 });
    await store.claimJob('test_job', 'worker-1', 30000);
    const renewed = await store.renewLease(jobId, 'worker-2', 30000);
    assert(renewed === false, 'should not renew for wrong worker');
  });

  await test('should get job by ID', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobId = await store.scheduleJob('test_job', { data: 1 });
    const job = await store.getJob(jobId);
    assert(job !== null, 'should find job');
    assert(job!.id === jobId, 'id should match');
  });

  await test('should return null for non-existent job', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const job = await store.getJob('nonexistent');
    assert(job === null, 'should return null');
  });

  await test('should get queue depth', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    await store.scheduleJob('type-a', {});
    await store.scheduleJob('type-a', {});
    await store.scheduleJob('type-b', {});
    const depth = await store.getQueueDepth();
    assert(depth === 3, `all types depth should be 3, got ${depth}`);
  });

  await test('should get queue depth by type', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    await store.scheduleJob('type-a', {});
    await store.scheduleJob('type-b', {});
    const depth = await store.getQueueDepth('type-a');
    assert(depth === 1, `type-a depth should be 1, got ${depth}`);
  });

  await test('should purge completed jobs', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobId = await store.scheduleJob('test_job', { data: 1 });
    await store.completeJob(jobId);
    const purged = await store.purgeCompleted(new Date(Date.now() + 10000));
    assert(purged === 1, `should purge 1 job, got ${purged}`);
    assert(!db.jobs.has(jobId), 'job should be deleted');
  });

  // ── Concurrent claim tests ──
  await test('should distribute jobs across workers without duplicates', async () => {
    const db = createMockDb();
    const store = new PostgresJobStore(db as any);
    const jobIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await store.scheduleJob('batch', { index: i });
      jobIds.push(id);
    }
    const claimed = new Map<string, string>();
    const claimPromises: Promise<void>[] = [];
    for (const workerId of ['w1', 'w2', 'w3']) {
      for (let i = 0; i < 5; i++) {
        claimPromises.push(
          (async () => {
            const job = await store.claimJob('batch', workerId, 30000);
            if (job) claimed.set(job.id, workerId);
          })(),
        );
      }
    }
    await Promise.all(claimPromises);
    assert(claimed.size === 10, `all 10 jobs should be claimed, got ${claimed.size}`);
  });

  // ── Metrics tests ──
  console.log('\n  JobSchedulerMetrics');
  await test('should record execution and render Prometheus', async () => {
    const metrics = new JobSchedulerMetrics();
    metrics.recordExecution({ jobType: 'test', durationMs: 50, success: true, retryCount: 0 });
    metrics.setQueueDepth(3);
    const snap = metrics.getSnapshot();
    assert(snap.jobsCompleted === 1, 'should have 1 completed');
    assert(snap.queueDepth === 3, 'depth should be 3');
    const prom = metrics.renderPrometheus();
    assert(prom.includes('verinode_job_queue_depth'), 'should include queue depth metric');
    assert(prom.includes('verinode_job_duration_seconds'), 'should include duration metric');
    assert(prom.includes('verinode_jobs_completed_total'), 'should include completed counter');
  });

  await test('should track lease timeouts', async () => {
    const metrics = new JobSchedulerMetrics();
    metrics.recordLeaseTimeout();
    metrics.recordLeaseExpired();
    const snap = metrics.getSnapshot();
    assert(snap.leaseTimeouts === 1, 'should have 1 timeout');
    assert(snap.leaseExpired === 1, 'should have 1 expired');
  });

  await test('should reset counters', async () => {
    const metrics = new JobSchedulerMetrics();
    metrics.recordExecution({ jobType: 'test', durationMs: 100, success: true, retryCount: 0 });
    metrics.setQueueDepth(10);
    metrics.reset();
    const snap = metrics.getSnapshot();
    assert(snap.jobsCompleted === 0, 'completed should reset');
    assert(snap.queueDepth === 0, 'depth should reset');
  });

  // ── Scheduler tests ──
  console.log('\n  JobScheduler');
  await test('should schedule and retrieve a job', async () => {
    const db = createMockDb();
    const scheduler = new JobScheduler({ db: db as any });
    const jobId = await scheduler.schedule('email_job', { to: 'x@y.com' });
    assert(typeof jobId === 'string', 'should return job ID');
    const job = await scheduler.getJob(jobId);
    assert(job !== null, 'should find job');
    assert(job!.jobType === 'email_job', 'type should match');
  });

  await test('should report queue depth', async () => {
    const db = createMockDb();
    const scheduler = new JobScheduler({ db: db as any });
    await scheduler.schedule('type-a', {});
    await scheduler.schedule('type-b', {});
    const total = await scheduler.queueDepth();
    assert(total === 2, `total depth should be 2, got ${total}`);
  });

  await test('should generate Prometheus metrics', async () => {
    const db = createMockDb();
    const scheduler = new JobScheduler({ db: db as any });
    const prom = scheduler.prometheusMetrics();
    assert(typeof prom === 'string', 'should return string');
    assert(prom.includes('# HELP'), 'should include HELP lines');
  });

  // ── Print results ──
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Passed: ${passed} | Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const msg of failures) {
      console.log(msg);
    }
    process.exit(1);
  }
  console.log('All tests passed!\n');
}

runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
