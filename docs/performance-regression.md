# Performance Regression Detection

Automated pre-deployment performance regression detection using statistical
change point analysis (E-Divisive with Medians, EDM) on benchmark results.

## Overview

Performance regressions are caught **before** they reach production by:

1. Running benchmark scenarios on every PR.
2. Comparing results against a stored baseline using the EDM algorithm.
3. Blocking CI if any metric degrades by more than **2 %**.
4. Posting a detailed markdown table as a PR comment.

---

## Algorithm: E-Divisive with Medians (EDM)

EDM finds statistically significant change points in a time series by
iteratively finding the split that maximises the **energy statistic** between
the two resulting sub-sequences:

```
E(x, y) = 2 * cross_dist(x, y) - within_dist(x) - within_dist(y)
```

where `cross_dist` is the mean absolute pairwise distance between the two
samples and `within_dist` is the internal dispersion of each sample.

A change point is accepted only when its energy exceeds `α × √(segment length)`.
The algorithm recurses on each sub-segment until no further significant splits
are found.

**Implementation**: `src/performance/edm.ts`

---

## Tracked Metrics

| Metric | Higher is worse? | Description |
|---|---|---|
| `p50LatencyMs` | ✅ | Median request latency |
| `p95LatencyMs` | ✅ | 95th-percentile latency |
| `p99LatencyMs` | ✅ | 99th-percentile latency |
| `throughputRps` | ❌ | Requests per second |
| `errorRate` | ✅ | Fraction of failed requests |
| `gcPauseDurationMs` | ✅ | GC pause (optional) |

---

## Benchmark Scenarios

| Scenario | Description |
|---|---|
| `api-request` | Representative HTTP endpoint latency |
| `db-query` | Single database round-trip |
| `message-processing` | Kafka message consumption pipeline |
| `crypto-ops` | Signature verification batch |

Each scenario runs for **5 minutes** to gather a statistically stable sample.

---

## Running Benchmarks

```bash
# Run all benchmark scenarios (local dev)
pnpm run benchmark

# Run a specific scenario
pnpm run benchmark -- --scenario api-request
```

---

## Baseline Management

Baselines are stored as JSON files in `.benchmarks/`, keyed by
`{branch}_{scenario}.json`.

```
.benchmarks/
  main_api-request.json
  main_db-query.json
  feature-xyz_api-request.json
```

**On main merge:**  Run benchmarks and update the baseline automatically via CI.

**On PR:**  Run benchmarks, load the `main` baseline, compare, and comment.

For S3 storage, mount the bucket at `.benchmarks/` or override `BASELINE_STORE_DIR`.

---

## CI Integration

The regression check runs as a CI step after the build:

```yaml
- name: Performance regression check
  run: pnpm run benchmark:ci
  env:
    BASELINE_BRANCH: main
    REGRESSION_THRESHOLD_PERCENT: 2
```

CI is blocked (exit code 1) if any metric exceeds the threshold.

### Manual Override

Add the label **`known regression`** to a PR to skip the CI block.
The regression report is still posted as a comment for visibility.

---

## Grafana Dashboard

Import `deploy/monitoring/performance-regression-dashboard.json` to visualise:

- Benchmark history per scenario with annotated change points.
- p50 / p95 / p99 latency trends over time.
- Throughput and error rate trends.
- Regression detection events (annotations).

The dashboard uses the `benchmark_metrics` TimescaleDB hypertable populated
by the CI pipeline.

---

## Architecture

```
src/performance/
  types.ts       ← shared type definitions
  edm.ts         ← EDM change point detection algorithm
  baseline.ts    ← JSON file / S3 baseline storage
  detector.ts    ← regression comparison & report generation
  benchmark.ts   ← scenario runner (latency / throughput / error rate)
  index.ts       ← re-exports
```

---

## References

- James & Matteson (2013) — *ecp: An R Package for Nonparametric Multiple
  Change Point Analysis of Multivariate Data*.
- Twitter Engineering Blog — *Detecting Performance Regressions with
  Change Point Analysis* (2015).
