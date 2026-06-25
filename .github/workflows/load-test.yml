name: Load Test — Node Simulator

on:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      profile:
        description: 'Load profile'
        required: false
        default: 'SteadyLoad'
        type: choice
        options:
          - SteadyLoad
          - SpikeTest
          - SoakTest

jobs:
  load-test:
    name: High-Density Node Simulator
    runs-on: ubuntu-latest  # Use a 4-core, 16GB runner in production: ubuntu-latest-4core

    env:
      SIMULATOR_RESULTS_DIR: /tmp/simulator_results
      SIMULATOR_TARGET: '0.0.0.0:9100'

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Create results directory
        run: mkdir -p $SIMULATOR_RESULTS_DIR

      - name: Download previous summary (for throughput comparison)
        uses: actions/cache@v4
        with:
          path: /tmp/prev_simulator_results
          key: load-test-baseline-${{ github.ref_name }}
          restore-keys: |
            load-test-baseline-main

      - name: Run node simulator (CI mode — 10k nodes, 2 min)
        run: |
          npx ts-node --project tsconfig.json tests/load/node_simulation.ts \
            --ci \
            --profile ${{ github.event.inputs.profile || 'SteadyLoad' }} \
            --results-dir $SIMULATOR_RESULTS_DIR

      - name: Compare throughput against previous run
        run: |
          CURRENT=$SIMULATOR_RESULTS_DIR/summary.json
          PREVIOUS=/tmp/prev_simulator_results/summary.json

          if [ ! -f "$PREVIOUS" ]; then
            echo "No previous baseline found — skipping throughput comparison."
            exit 0
          fi

          PREV_TP=$(jq '.throughputPerSec' "$PREVIOUS")
          CURR_TP=$(jq '.throughputPerSec' "$CURRENT")

          echo "Previous throughput : $PREV_TP attestations/sec"
          echo "Current  throughput : $CURR_TP attestations/sec"

          # Fail if throughput dropped by more than 10%
          python3 - <<EOF
          import sys
          prev = float("$PREV_TP")
          curr = float("$CURR_TP")
          if prev > 0 and curr < prev * 0.90:
              drop = (1 - curr / prev) * 100
              print(f"❌ Throughput dropped {drop:.1f}% (prev={prev:.0f}, curr={curr:.0f}) — exceeds 10% limit")
              sys.exit(1)
          print(f"✅ Throughput OK (prev={prev:.0f}, curr={curr:.0f})")
          EOF

      - name: Save current summary as new baseline
        run: |
          mkdir -p /tmp/prev_simulator_results
          cp $SIMULATOR_RESULTS_DIR/summary.json /tmp/prev_simulator_results/summary.json

      - name: Cache baseline for next run
        uses: actions/cache@v4
        with:
          path: /tmp/prev_simulator_results
          key: load-test-baseline-${{ github.ref_name }}

      - name: Upload simulation artifacts
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: load-test-results-${{ github.run_number }}
          path: |
            ${{ env.SIMULATOR_RESULTS_DIR }}/summary.json
            ${{ env.SIMULATOR_RESULTS_DIR }}/per_node_stats.csv
          retention-days: 30