'use strict';

const fs = require('fs');
const path = require('path');

const workflowPath = path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

const requiredSnippets = [
  'concurrency:',
  'cancel-in-progress: true',
  'dorny/paths-filter@v3',
  'Warm dependency cache',
  'actions/cache@v4',
  "node-modules-${{ runner.os }}-${{ hashFiles('package-lock.json') }}",
  'dist-${{ runner.os }}-${{ github.ref }}',
  'shard-tests.cjs --shard',
  'fail-fast: false',
  'CodeQL analyze',
  'npm audit --omit=dev --audit-level high',
  'docker/build-push-action@v6',
  'CI timing report',
  'CI complete',
];

const missing = requiredSnippets.filter((snippet) => !workflow.includes(snippet));
if (missing.length > 0) {
  console.error('CI workflow is missing required optimization gates:');
  for (const snippet of missing) console.error(`- ${snippet}`);
  process.exit(1);
}

const shardEnv = workflow.match(/^\s*TEST_SHARDS:\s*(\d+)$/m);
const shardList = workflow.match(/^\s*shard:\s*\[([^\]]+)\]$/m);
if (!shardEnv || !shardList) {
  console.error('CI workflow must declare a TEST_SHARDS env var and a numeric test shard matrix.');
  process.exit(1);
}
const configuredShards = Number(shardEnv[1]);
const matrixShards = shardList[1]
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map(Number);
if (matrixShards.length !== configuredShards || matrixShards.length < 4) {
  console.error(
    `Expected test matrix to list exactly TEST_SHARDS=${configuredShards} shards, ` +
      `found ${matrixShards.length}.`,
  );
  process.exit(1);
}

for (const requiredFile of ['scripts/shard-tests.cjs', 'scripts/test-durations.json']) {
  if (!fs.existsSync(path.resolve(__dirname, '..', requiredFile))) {
    console.error(`CI workflow depends on missing file: ${requiredFile}`);
    process.exit(1);
  }
}

console.log(
  `Validated ${matrixShards.length} parallel test shards, shared dependency cache, ` +
    'per-branch build cache, and required optimization gates.',
);
