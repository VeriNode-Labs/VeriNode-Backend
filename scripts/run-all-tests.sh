#!/bin/bash
# Run every test file under tests/ sequentially.
# Delegates to scripts/shard-tests.cjs so local `npm test` and CI shards share
# the same discovery and executor-selection logic.
set -e

exec node scripts/shard-tests.cjs --all
