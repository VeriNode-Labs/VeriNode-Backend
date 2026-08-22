# VeriNode Backend Guide

Node.js Express API server for the VeriNode Decentralized Savings Circle (ROSCA) protocol, managing circle lifecycles, collateral tracking, and leniency/governance workflows.

This document serves as the single source of truth for the VeriNode Backend, merging all previous documentation (README, setup guides, and technical deep-dives) into one comprehensive guide.

## 🚀 Key Features
* **Circle Lifecycle Management:** REST API endpoints to create, join, deposit, and process payout rounds for savings circles.
* **Collateral & Slashing Integrations:** Monitors collateral vault deposits, slashing events, and release state transitions.
* **Governance & Leniency Voting:** Interfaces for proposing and voting on leniency grace period requests and quadratic voting proposals.

## 🛠️ Tech Stack
* **Language/Framework:** Node.js / Express
* **Key Dependencies:** `express`, `cors`, `dotenv`
* **Observability:** OpenTelemetry (tracing, metrics)
* **Security:** mTLS, Rate Limiting (Redis-backed), Automated Certificate Rotation (ACME)

---

## 📦 Getting Started & Setup

### Prerequisites
Ensure you have the required toolchains installed:
* Node.js (v18 or higher recommended)
* npm (Node Package Manager)
* Docker (for CI/CD testing)

### Installation & Local Setup
```bash
# Clone the repository (if running manually)
git clone https://github.com/VeriNode-Labs/VeriNode-Backend

# Bootstrap local dependencies, config, and build checks
npm run onboard

# Start the application
node index.js
```

### Configuration Management
The backend utilizes a centralized configuration system (`config/index`). By default, it loads from `./config.json`. The application supports live-reloading of configuration via SIGHUP and includes a configuration drift auditor to monitor unauthorized or unexpected configuration changes at runtime.

---

## 📚 API Reference

Below is the comprehensive list of all endpoints supported by the VeriNode backend.

### Core & Health Endpoints
These endpoints provide basic routing, health checks, and metrics for the application.

* `GET /`
  * **Description:** Root status endpoint to verify the API is running.
  * **Response:** Text confirmation (`VeriNode API is running`).

* `GET /health/pools`
  * **Tier:** Enterprise
  * **Description:** Provides dual-pool connection statistics and health status.
  * **Response:** JSON object containing pool health details.

* `GET /metrics`
  * **Tier:** Free
  * **Description:** Prometheus text-format scrape endpoint. Exports metrics for connection pools, dead letter queues, mTLS managers, and cache layers.
  * **Response:** Prometheus metrics text payload.

### Internal & Debug Endpoints
Used for diagnostics, configuration auditing, and internal system maintenance.

* `GET /debug/traces/config`
  * **Tier:** Pro
  * **Description:** Returns the current OpenTelemetry tracing configuration.
  
* `POST /internal/archival/renew/:contractId`
  * **Tier:** Enterprise
  * **Description:** Force-renews the archival listener for a given contract ID.
  * **Response:** Result of the renewal process.

* `GET /debug/config-drift`
  * **Tier:** Pro
  * **Description:** Exposes current configuration drift audit status.

* `GET /debug/config-drift/history`
  * **Tier:** Pro
  * **Description:** Exposes historical configuration drift logs.

* `GET /debug/config-drift/ui`
  * **Tier:** Pro
  * **Description:** Provides a UI dashboard for configuration drift monitoring.

### Certificate & ACME Endpoints (TLS/mTLS)
Used for automated certificate generation and rotation.

* `GET /api/v1/certs/status`
  * **Description:** Retrieve the current status of the TLS certificates.

* `POST /api/v1/certs/renew`
  * **Description:** Trigger an immediate renewal of the TLS certificates.

* `GET /.well-known/acme-challenge/:token`
  * **Description:** Standard ACME challenge response endpoint for HTTP-01 validations.

---

## 🏗️ Architecture & Operations

### Docker & CI Cache
Docker image builds use a digest-pinned Node.js base image, dependency-layer pinning, and GitHub Actions BuildKit cache warmups. This ensures predictable build times and identical dev/prod environments.

### Cache Layer
The backend implements a dedicated caching layer for high-throughput reads (such as active circles or governance proposals). The cache integrates with Redis and exports its own metrics.

### Security: Rate Limiting & mTLS
* **Rate Limiting:** Managed via Redis. Endpoints are categorized into tiers (`free`, `pro`, `enterprise`) to restrict abuse.
* **mTLS (Mutual TLS):** Enforced on internal communications. The application will validate peer SPIFFE identities against a trusted domain config. Handshake failures and unauthorized accesses are logged and metered.

### Observability
All traffic is traced using OpenTelemetry. Tracing configs can be dynamically adjusted or queried via the debug endpoints.

---

## 🤝 Contributing
Contributions are highly welcome. Please ensure your commits are cryptographically signed using GPG or SSH keys. For major structural changes, please open an issue first to discuss your proposal.
