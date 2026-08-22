const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findTests(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const stat = fs.statSync(path.join(dir, file));
    if (stat.isDirectory()) {
      findTests(path.join(dir, file), fileList);
    } else if (file.endsWith('.test.ts')) {
      fileList.push(path.join(dir, file));
    }
  }
  return fileList;
}

const testsDir = path.join(__dirname, '..', 'tests');
const testFiles = findTests(testsDir);
let failed = 0;

const regularTests = [];
const vitestTests = [];

for (const file of testFiles) {
  if (file.includes('queue')) {
    vitestTests.push(file);
  } else {
    regularTests.push(file);
  }
}

for (const file of regularTests) {
  console.log(`\n=== Running test: ${file} ===`);
  try {
    execSync(`npx ts-node --project tsconfig.json "${file}"`, { stdio: 'inherit', env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' } });
  } catch (error) {
    console.error(`\n!!! Test FAILED: ${file} !!!`);
    failed++;
  }
}

if (vitestTests.length > 0) {
  console.log(`\n=== Running vitest for: ${vitestTests.join(', ')} ===`);
  try {
    execSync(`npx vitest run ${vitestTests.map(f => `"${f}"`).join(' ')}`, { stdio: 'inherit' });
  } catch (error) {
    console.error(`\n!!! Vitest FAILED !!!`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} test suites failed.`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed.`);
  process.exit(0);
}
