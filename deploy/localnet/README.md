# VeriNode localnet

A one-command local development environment for the VeriNode backend, so a new
contributor can go from a fresh clone to a running, populated, observable stack
in minutes instead of days.

```bash
make localnet         # build + boot everything, then seed data
make localnet-clean   # tear it all down and remove state
```

## What comes up

| Service | URL / port | Purpose |
|---|---|---|
| API | http://localhost:3000 | The backend (`/metrics` for Prometheus) |
| Postgres (TimescaleDB) | localhost:5432 | `verinode` / `verinode`; migrations auto-applied |
| OTel collector | localhost:4317 (OTLP gRPC) | Receives traces from the API |
| Prometheus | http://localhost:9090 | Scrapes the API `/metrics` + collector |
| Grafana | http://localhost:3001 | Pre-provisioned Prometheus datasource + the repo's dashboards |

Migrations under `src/database/migrations/` are mounted into the Postgres
container's `docker-entrypoint-initdb.d`, so they run in order on first boot
(the image is `timescale/timescaledb-ha` because `002_uptime_schema.sql`
requires TimescaleDB + pg_cron). Grafana loads the existing dashboards from
`deploy/observability/` and `deploy/monitoring/` via file provisioning.

## Seed data

Run automatically by `make localnet` (and re-runnable on their own):

- `make localnet-seed` — provisions a bond pool and **8 validators**, each with
  a stake, a reputation score, and a pending reward balance.
- `make localnet-mock` — emits a window of `uptime_heartbeat` rows and a few
  `reward_tx` rows per validator, so the time-series panels have live data.

## A note on scope

The original issue was framed as a blockchain **validator testnet** (genesis
file, pre-funded accounts, mock attestations). This repo is the ROSCA
savings-circle API backend, which has no genesis/accounts primitives — so, per
the maintainer's confirmation on the issue, those steps are mapped to their
real equivalents here: the **seed script** provisions validator identities with
stakes/reputations/rewards (the "pre-funded accounts" analogue), and the
**mock-telemetry generator** produces heartbeat/reward data (the "mock
attestation" analogue). Everything is grounded in tables that actually exist
(`bond_pools`, `validator_stakes`, `reputations`, `reward_pending_amounts`,
`reward_tx`, `uptime_heartbeat`).

## Requirements

- Docker + Docker Compose v2 (`up --wait` support)
- Node.js (for the seed/mock scripts, run on the host via `ts-node`)
