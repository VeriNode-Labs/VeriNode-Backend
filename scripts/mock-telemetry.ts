/**
 * Generate mock telemetry for the seeded validators.
 *
 * This is the ROSCA-backend equivalent of a "mock attestation generator": it
 * emits a window of uptime_heartbeat rows (the TimescaleDB hypertable the node
 * monitoring is built on) plus a few reward_tx rows per validator, so Grafana
 * panels and API endpoints have live-looking time-series data to show.
 *
 * Idempotent-ish: re-running appends a fresh window of heartbeats.
 *
 * Usage:  npx ts-node scripts/mock-telemetry.ts   (DB_* env, defaults to localnet)
 */
import { Client } from 'pg';
import { validatorIds } from './seed-localnet';

const VALIDATOR_COUNT = Number(process.env.LOCALNET_VALIDATORS ?? 8);
const HEARTBEAT_MINUTES = Number(process.env.LOCALNET_HEARTBEAT_MINUTES ?? 60);

function dbConfig() {
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'verinode',
    password: process.env.DB_PASSWORD ?? 'verinode',
    database: process.env.DB_NAME ?? 'verinode',
  };
}

async function main(): Promise<void> {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    const validators = validatorIds(VALIDATOR_COUNT);
    const now = Date.now();
    let heartbeats = 0;
    let rewards = 0;

    for (const [idx, v] of validators.entries()) {
      // One heartbeat per minute over the window.
      for (let m = HEARTBEAT_MINUTES; m >= 0; m--) {
        const ts = new Date(now - m * 60_000).toISOString();
        // Deterministic-ish variation: mostly up, occasional degraded.
        const degraded = (m + idx) % 17 === 0;
        const latency = 20 + ((m * 7 + idx * 3) % 40) + (degraded ? 120 : 0);
        const status = degraded ? 'degraded' : 'up';
        const uptimePct = degraded ? 98.5 : 100.0;
        const blockHeight = 1_000_000 + (HEARTBEAT_MINUTES - m) * 12 + idx;
        await client.query(
          `INSERT INTO uptime_heartbeat
             (time, node_id, latency_ms, status, uptime_pct, block_height)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [ts, v, latency, status, uptimePct, blockHeight],
        );
        heartbeats++;
      }

      // A couple of reward transactions per validator (references reward_pending_amounts).
      for (let r = 0; r < 3; r++) {
        await client.query(
          `INSERT INTO reward_tx (node_id, amount) VALUES ($1, $2)`,
          [v, (0.5 + r * 0.25).toFixed(7)],
        );
        rewards++;
      }
    }

    console.log(
      `Generated ${heartbeats} heartbeat rows and ${rewards} reward_tx rows ` +
        `across ${VALIDATOR_COUNT} validators (${HEARTBEAT_MINUTES}m window).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[mock-telemetry] failed:', err);
  process.exit(1);
});
