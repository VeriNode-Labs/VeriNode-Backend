/**
 * Seed the localnet database with a set of validator identities.
 *
 * This is the ROSCA-backend equivalent of a testnet "genesis file with
 * pre-funded accounts": it provisions a bond pool and N validators, each with
 * a stake (validator_stakes), a reputation score (reputations), and a pending
 * reward balance (reward_pending_amounts) — so a fresh checkout has realistic
 * data to develop and demo against.
 *
 * Idempotent: safe to run repeatedly (ON CONFLICT upserts).
 *
 * Usage:  npx ts-node scripts/seed-localnet.ts   (DB_* env, defaults to localnet)
 */
import { Client } from 'pg';

const VALIDATOR_COUNT = Number(process.env.LOCALNET_VALIDATORS ?? 8);
const POOL_ID = 'localnet-pool';
const STAKE_PER_VALIDATOR = 1_000_000;

function dbConfig() {
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'verinode',
    password: process.env.DB_PASSWORD ?? 'verinode',
    database: process.env.DB_NAME ?? 'verinode',
  };
}

export function validatorIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `validator-${String(i + 1).padStart(2, '0')}`);
}

async function main(): Promise<void> {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    const validators = validatorIds(VALIDATOR_COUNT);

    await client.query(
      `INSERT INTO bond_pools (id, balance) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance`,
      [POOL_ID, STAKE_PER_VALIDATOR * VALIDATOR_COUNT],
    );

    for (const [idx, v] of validators.entries()) {
      await client.query(
        `INSERT INTO validator_stakes (pool_id, validator_id, amount) VALUES ($1, $2, $3)
           ON CONFLICT (pool_id, validator_id) DO UPDATE SET amount = EXCLUDED.amount`,
        [POOL_ID, v, STAKE_PER_VALIDATOR],
      );
      // Varied but valid reputation scores (schema bounds: -1000..1000).
      await client.query(
        `INSERT INTO reputations (node_id, score) VALUES ($1, $2)
           ON CONFLICT (node_id) DO UPDATE SET score = EXCLUDED.score, updated_at = NOW()`,
        [v, 500 + idx * 40],
      );
      await client.query(
        `INSERT INTO reward_pending_amounts (node_id, amount) VALUES ($1, $2)
           ON CONFLICT (node_id) DO UPDATE SET amount = EXCLUDED.amount`,
        [v, (10 + idx).toFixed(7)],
      );
    }

    console.log(
      `Seeded ${VALIDATOR_COUNT} validators into bond pool "${POOL_ID}" ` +
        `(stake ${STAKE_PER_VALIDATOR} each) with reputations and pending rewards.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[seed-localnet] failed:', err);
  process.exit(1);
});
