# Docker CI Layer Cache

The CI Docker build uses BuildKit and GitHub Actions cache storage to reuse the expensive dependency and build layers between pull requests, pushes, and weekly warmups. The implementation is intentionally system-wide: every service built from this repository uses the same multi-stage `Dockerfile`, `.dockerignore`, and GitHub Actions cache scope.

## Solution Architecture

- `base` pins `node:22-bookworm-slim` by digest so CI does not silently pull a different base image during ordinary builds.
- `deps` copies only `package.json` and `package-lock.json` before `npm ci`, keeping dependency installation cached when source files change.
- `build` copies TypeScript sources after dependencies and runs `npm run build`.
- `runtime-deps` installs production-only dependencies in its own cacheable layer.
- `runtime` copies only `node_modules`, `dist`, `index.js`, and package metadata into the final image.
- `.dockerignore` removes local dependencies, test artifacts, docs, and generated output from the build context to keep cache keys stable.
- `.github/workflows/docker-image.yml` restores and saves BuildKit layers with `type=gha` under the `verinode-backend-node22` scope.

Keeping one active scope and a tight `.dockerignore` keeps the registry/cache footprint bounded for the 5GB target while making dependency layers reusable across pull requests, pushes, manual dispatches, and weekly warmups.

## Monitoring and Alerting

The workflow writes a cache summary to the GitHub Actions step summary on every run. Review the build logs for `CACHED` layer entries and elapsed time regressions.

Recommended alert thresholds:

| Signal | Target | Alert when |
| --- | --- | --- |
| Cache-hit build duration | < 3 minutes | 2 consecutive cache-hit runs exceed 3 minutes |
| Cache-miss build duration | < 8 minutes | Any cache-miss run exceeds 8 minutes |
| Cache restore duration | < 30 seconds | 2 consecutive restores exceed 30 seconds |
| Critical application path P99 after deployment | < 100ms | 5-minute P99 exceeds 100ms |
| Availability after deployment | 99.99% | 5xx rate or uptime SLO burn exceeds policy |

Dashboard panels should include total Docker build duration, restore/save duration, cache-hit ratio, dependency-layer rebuild count, image digest, application P99 latency, and deployment error budget burn.

## Deployment Strategy

Use a blue-green rollout for images produced by this workflow:

1. Build and publish the candidate image from `main` after the cached CI build succeeds.
2. Deploy the image to the green environment while blue continues serving traffic.
3. Run smoke tests against green, including health checks and the critical path latency probe.
4. Shift 5% of traffic to green for canary analysis.
5. Continue to 25%, 50%, and 100% only while P99 latency stays under 100ms, availability remains at or above 99.99%, and error rates do not regress.
6. Roll back by returning traffic to blue if any canary guardrail fails.

## Security Review

Security review is required when changing the pinned base-image digest, package manager install commands, Dockerfile stage boundaries, GitHub Actions permissions, or cache publishing behavior. The review must verify that untrusted pull requests do not publish images, secrets are not mounted into Docker builds, and dependency installation remains lockfile-based.

## Warmup Cadence

`.github/workflows/docker-image.yml` runs on pull requests, pushes to `main`, manual dispatch, and every Monday at 03:17 UTC. The scheduled run warms the pinned base and dependency layers.

`.github/dependabot.yml` checks Docker and GitHub Actions updates weekly. When Dependabot opens a Docker digest update for `NODE_IMAGE`, merging it refreshes the pinned base image for security patches without allowing ordinary CI runs to float to an unreviewed base layer.

## Benchmark Commands

Use these commands to compare cold and warm local BuildKit behavior:

```bash
docker buildx create --use --name verinode-cache-bench
docker buildx build --no-cache --target runtime --progress=plain -t verinode-backend:cold .
docker buildx build --target runtime --progress=plain -t verinode-backend:warm .
```

Expected CI targets:

- Cache restore: under 30 seconds.
- Cache-hit build: under 3 minutes.
- Cache-miss build: under 8 minutes.

GitHub Actions cache-hit timing is visible in the `Docker Image Cache` workflow logs after the first successful run populates the `verinode-backend-node22` cache scope.
