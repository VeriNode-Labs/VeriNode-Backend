# VeriNode-Backend developer tasks.
#
# The `localnet` target brings up a one-command local development environment
# so new contributors don't have to wire Postgres, the OTel collector,
# Prometheus and Grafana by hand. See deploy/localnet/README.md.

COMPOSE := docker compose -f deploy/localnet/docker-compose.yml
LOCALNET_DB_ENV := DB_HOST=localhost DB_PORT=$(or $(LOCALNET_PG_PORT),5432) DB_USER=verinode DB_PASSWORD=verinode DB_NAME=verinode

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: localnet
localnet: ## Boot the full local stack (API + Postgres + OTel + Prometheus + Grafana) and seed data
	$(COMPOSE) up -d --build --wait
	$(MAKE) localnet-seed
	$(MAKE) localnet-mock
	@echo ""
	@echo "localnet is up:"
	@echo "  API         http://localhost:3000     (/metrics for Prometheus scrape)"
	@echo "  Prometheus  http://localhost:9090"
	@echo "  Grafana     http://localhost:3001     (anonymous viewer; login admin/admin)"
	@echo "  Postgres    localhost:5432            (verinode / verinode)"

.PHONY: localnet-seed
localnet-seed: ## Seed validators / stakes / reputations / pending rewards (idempotent)
	$(LOCALNET_DB_ENV) npx ts-node scripts/seed-localnet.ts

.PHONY: localnet-mock
localnet-mock: ## Generate mock heartbeat + reward telemetry for the seeded validators
	$(LOCALNET_DB_ENV) npx ts-node scripts/mock-telemetry.ts

.PHONY: localnet-logs
localnet-logs: ## Tail all localnet service logs
	$(COMPOSE) logs -f

.PHONY: localnet-clean
localnet-clean: ## Tear down the stack and remove all state (volumes)
	$(COMPOSE) down -v --remove-orphans
