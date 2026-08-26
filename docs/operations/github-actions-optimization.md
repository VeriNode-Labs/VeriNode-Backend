# GitHub Actions optimization runbook

## Architecture

The CI workflow is split into a short path-filter stage, a shared dependency-cache
warmup, and independent build, unit-test, security, and Docker smoke-test jobs. The
unit-test suite is fanned out across **4 parallel runners** using
`scripts/shard-tests.cjs`, which partitions every test file under `tests/` with
longest-processing-time (LPT) bin packing keyed on measured durations
(`scripts/test-durations.json`). Failures map directly back to a shard, and shard
assignment is deterministic, so reruns behave identically.

A `CI timing report` job publishes per-job wall-clock durations to the Actions
step summary after every run so regressions are visible without opening the raw
job list.

## Measured baseline

Sequential suite on a local runner (`npm test`, 28 test files, cold node process
per file): **~17 s total**. Fanning the same suite out across 4 parallel runners
brings the measured wall time down to **~5 s** for the slowest shard.

| Shard | Files | Measured wall time |
|---|---|---|
| 0 | `kafka_auto_scaler`, `config_drift`, `payload_encryption`, `multi_region`, `runbook_automation`, `dependency-vulnerability-gate` | ~2.9 s |
| 1 | `tls_rotation`, `kafka_consumer_monitor`, `config_management`, `burn_rate_monitor`, `docker_cache_config`, `blueprint`, `coverage_enforce` | ~5.4 s |
| 2 | `shard_tests`, `mtls_integration`, `rotation_ceremony`, `penalty_calculator_race`, `secret_rotation`, `migration_manager`, `planner` | ~4.8 s |
| 3 | `mtls`, `two_phase_controller`, `job_scheduler`, `backup_verification`, `logger`, `cache_layer`, `pre-commit-hooks`, `pre-commit-checks` | ~4.0 s |

The packer (`scripts/shard-tests.cjs`) sorts suites by measured duration plus a
fixed per-file process-startup cost and assigns each to the least-loaded shard
(longest-processing-time bin packing), so slow suites (`tls_rotation` ~2 s,
`kafka_consumer_monitor` ~1 s) and suites with many small files spread across
different runners; estimated shard loads are within ~2% of each other. Newly
added test files default to the median measured duration and are rebalanced
automatically; refresh the table with
`node scripts/shard-tests.cjs --record-durations`.

## Performance controls

- **Path filtering** skips the expensive backend jobs for documentation-only pull
  requests (`dorny/paths-filter`), including the lint/format pre-commit hooks.
- **Concurrency** (`cancel-in-progress`) stops superseded runs on the same ref.
- **Dependency cache tiers**:
  - npm registry cache (`setup-node cache: npm`) shared across every job;
  - `node_modules` artifact cache keyed on `package-lock.json` (`actions/cache`),
    shared across all jobs and branches — the Node analog of a shared Cargo
    registry cache;
  - `dist/` build output cached per branch (`dist-${{ runner.os }}-${{ github.ref }}`
    key), restored before `tsc` and saved on success — the Node analog of a
    per-branch Cargo target-directory cache. GitHub evicts caches by least-recent
    use automatically.
- **Test sharding** executes the real test suite in parallel across 4 runners
  instead of one sequential job. A warm-cache run of the whole pipeline is
  budgeted well under 8 minutes; install time dominates the critical path, so
  cache hits on `node_modules` matter more than shard balance.
- **Docker layer cache** (`type=gha, mode=max`) reuses image layers across runs.

## Security review gates

Every backend or workflow change runs production dependency auditing and CodeQL
analysis before the aggregate `ci-complete` job can pass. Treat `ci-complete` as
the required branch-protection check so skipped jobs are handled consistently for
docs-only changes. The workflow contract is machine-checked by
`npm run ci:validate-workflow`, which asserts the cache tiers, the 4-shard matrix,
and the required security gates stay in place.

## Monitoring and alerting

Use GitHub's workflow notifications and branch protection to page maintainers when
`ci-complete` fails. Review the per-shard duration trend weekly from the Actions
run summary (see also the `CI timing report` job); split a shard when it exceeds
twice the median shard duration for three consecutive runs. If `tsc` or install
time creeps up, refresh `scripts/test-durations.json` with
`node scripts/shard-tests.cjs --record-durations` and recommit.

## Blue-green and canary deployment guidance

Deployment workflows should depend on `ci-complete`, publish immutable image
digests, and promote in two phases:

1. Green environment deploy with smoke checks against `/health` and representative
   critical-path requests.
2. Canary promotion starting at 5%, then 25%, then 50%, then 100% only if P99
   latency remains below 100 ms and error budget burn remains within the 99.99%
   availability target.

Rollback immediately to the previous digest if canary analysis shows elevated P99
latency, health-check failures, or security-gate regressions.
