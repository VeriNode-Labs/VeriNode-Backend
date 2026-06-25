const path = require('path');

require('ts-node').register({
  project: path.resolve(__dirname, '..', 'tsconfig.json'),
  transpileOnly: true,
});

// Ensure any module-level initTracing() uses a fast-fail endpoint
// instead of the default otel-collector:4317 which hangs in CI.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:14317';

const originalExit = process.exit.bind(process);
let globalExitCode = 0;

const TEST_FILES = [
  'tests/blockchain/rpc_client.test.ts',
  'tests/blockchain/transaction_builder.test.ts',
  'tests/config/database.test.ts',
  'tests/config.test.ts',
  'tests/core/attestation/engine.test.ts',
  'tests/core/crypto/signature.test.ts',
  'tests/core/crypto/aggregate_sig.test.ts',
  'tests/dead_letter_queue.test.ts',
  'tests/mtls.test.ts',
  'tests/reputation/scoreService.test.ts',
  'tests/slashing_sequencer.test.ts',
  'tests/staking/bondPool.test.ts',
  'tests/staking/slashing_sequencer.test.ts',
  'tests/tls_rotation.test.ts',
  'tests/uptime_queries.test.ts',
  'tests/tracer.test.ts',
  'tests/pool_isolation.test.ts',
  'tests/state_archival.test.ts',
  'tests/rewards/distributor.test.ts',
];

async function main() {
  for (const relativePath of TEST_FILES) {
    const absolutePath = path.resolve(__dirname, '..', relativePath);
    let currentTestResolve;
    const currentTestDone = new Promise((resolve) => { currentTestResolve = resolve; });

    process.exit = function interceptedExit(code = 0) {
      if (code !== 0) {
        console.error(`[FAIL] ${relativePath} exited with code ${code}`);
        globalExitCode = code;
      }
      process.exit = originalExit;
      currentTestResolve(code);
    };

    console.error(`\n--- ${relativePath} ---`);
    try {
      delete require.cache[absolutePath];
      require(absolutePath);

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`TIMEOUT: ${relativePath} did not exit within 60s`)), 60000)
      );
      await Promise.race([currentTestDone, timeout]);
    } catch (err) {
      console.error(`[ERROR] ${relativePath}: ${err.message}`);
      globalExitCode = 1;
    }
  }

  originalExit(globalExitCode);
}

main().catch((err) => {
  console.error('Runner crashed:', err);
  originalExit(1);
});
