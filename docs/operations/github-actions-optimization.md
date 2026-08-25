# GitHub Actions optimization runbook

## Architecture

The CI workflow is split into a short path-filter stage, a shared dependency-cache warmup, and independent build, unit-test, security, and Docker smoke-test jobs. Unit tests run as named shards so slow areas can execute in parallel while keeping failures easy to map back to a domain.

## Performance controls

- Path filtering skips expensive backend checks for documentation-only pull requests.
- `concurrency.cancel-in-progress` stops superseded runs on the same ref.
- pnpm and Docker BuildKit caches are restored across jobs to reduce install and image-build latency.
- Test sharding targets fast feedback for critical paths by separating blockchain, configuration, crypto, operations, and staking suites.

## Security review gates

Every backend or workflow change runs production dependency auditing and CodeQL analysis before the aggregate `ci-complete` job can pass. Treat `ci-complete` as the required branch-protection check so skipped jobs are handled consistently for docs-only changes.

## Monitoring and alerting

Use GitHub's workflow notifications and branch protection to page maintainers when `ci-complete` fails. Review the per-shard duration trend weekly from the Actions run summary; split a shard when it exceeds twice the median shard duration for three consecutive runs.

## Blue-green and canary deployment guidance

Deployment workflows should depend on `ci-complete`, publish immutable image digests, and promote in two phases:

1. Green environment deploy with smoke checks against `/health` and representative critical-path requests.
2. Canary promotion starting at 5%, then 25%, then 50%, then 100% only if P99 latency remains below 100 ms and error budget burn remains within the 99.99% availability target.

Rollback immediately to the previous digest if canary analysis shows elevated P99 latency, health-check failures, or security-gate regressions.
