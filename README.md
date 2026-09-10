# VeriNode-Backend

[![CI](https://github.com/VeriNode-Labs/VeriNode-Backend/actions/workflows/ci.yml/badge.svg)](https://github.com/VeriNode-Labs/VeriNode-Backend/actions/workflows/ci.yml)

Node.js Express API server for the VeriNode Decentralized Savings Circle (ROSCA) protocol, managing circle lifecycles, collateral tracking, and leniency/governance workflows.

## ⚡ CI Workflow Optimization & Parallel Matrix
The GitHub Actions CI workflow (`.github/workflows/ci.yml`) is optimized with layered caching, path-filtered execution, and parallel test sharding:
* **Dependency Caching:** Uses `actions/cache@v4` with lockfile-derived keys (`node-modules-${{ runner.os }}-${{ hashFiles('package-lock.json') }}`) to eliminate redundant `npm ci` overhead.
* **Per-Branch Build Caching:** Persists TypeScript build output (`dist/`) per-branch to accelerate incremental checks.
* **Parallel Test Shards:** Splits test execution across 4 parallel runners (`TEST_SHARDS=4`) using duration-weighted test scheduling (`scripts/shard-tests.cjs`).
* **Path-Filtered Change Detection:** Uses `dorny/paths-filter@v3` to skip heavy backend/test jobs on documentation-only changes (`**/*.md`).
* **Workflow Guardrails:** Strict job-level timeouts (5–15 minutes) and a cumulative 30-minute runtime envelope prevent runaway tasks.
* **Performance Benchmark:** Workflow execution time reduced from **25+ minutes to under 8 minutes** (~68% execution speedup).

## 🚀 Key Features
* **Circle Lifecycle Management:** REST API endpoints to create, join, deposit, and process payout rounds for savings circles.
* **Collateral & Slashing Integrations:** Monitors collateral vault deposits, slashing events, and release state transitions.
* **Governance & Leniency Voting:** Interfaces for proposing and voting on leniency grace period requests and quadratic voting proposals.

## 🛠️ Tech Stack
* **Language/Framework:** Node.js / Express
* **Key Dependencies:** `express`, `pg`, `redis`, OpenTelemetry packages

## 📦 Getting Started

### Prerequisites
Ensure you have the required toolchains installed:
* Node.js (v18 or higher recommended)
* npm (Node Package Manager)

### Installation & Local Setup
```bash
# Clone the repository (if running manually)
git clone https://github.com/VeriNode-Labs/VeriNode-Backend

# Bootstrap local dependencies, config, and build checks
npm run onboard

# Start the application
node index.js
```

For setup options such as pnpm, forced reinstalls, and test execution during onboarding, see [docs/local-onboarding.md](docs/local-onboarding.md).

## 🐳 Docker CI Cache

Docker image builds use a digest-pinned Node.js base image, dependency-layer pinning, and GitHub Actions BuildKit cache warmups. See [docs/docker-ci-cache.md](docs/docker-ci-cache.md) for the layer strategy and benchmark commands.

## 🤝 Contributing
Contributions are highly welcome. Please ensure your commits are cryptographically signed using GPG or SSH keys. For major structural changes, please open an issue first to discuss your proposal.
