import assert from 'assert';
import { InMemorySecretStore, SecretRotationService } from '../../src/security/secret_rotation';

async function testSuccessfulRotation() {
  let now = new Date('2026-01-01T00:00:00.000Z');
  let sequence = 0;
  const store = new InMemorySecretStore();
  const applied: string[] = [];
  const service = new SecretRotationService({
    store,
    clock: () => now,
    versionIdFactory: () => `v${++sequence}`,
    generator: { generate: () => 'rotated-password' },
    hooks: {
      apply: (_secret, version) => {
        applied.push(version.id);
      },
    },
    canaryPercent: 10,
    rotationIntervalMs: 1000,
  });

  await service.registerSecret('database/main', 'database', 'initial-password', now);
  now = new Date('2026-01-01T00:00:01.000Z');
  const result = await service.rotate('database/main');
  const descriptor = await store.getSecret('database/main');
  const previous = await store.getVersion('database/main', 'v1');
  const current = await store.getVersion('database/main', 'v2');

  assert.equal(result.phase, 'complete');
  assert.equal(result.oldVersionId, 'v1');
  assert.equal(result.newVersionId, 'v2');
  assert.deepEqual(applied, ['v2']);
  assert.equal(descriptor?.currentVersionId, 'v2');
  assert.equal(descriptor?.previousVersionId, 'v1');
  assert.equal(descriptor?.canaryPercent, 0);
  assert.equal(previous?.labels.state, 'previous');
  assert.equal(current?.labels.state, 'current');
  assert.equal(service.metricsSnapshot().rotationsSucceeded, 1);
  assert.match(service.renderPrometheus(), /secret_rotation_success_total 1/);
}

async function testRollbackOnValidationFailure() {
  let sequence = 0;
  const store = new InMemorySecretStore();
  const service = new SecretRotationService({
    store,
    versionIdFactory: () => `v${++sequence}`,
    generator: { generate: () => 'bad-api-key' },
    hooks: {
      validate: () => {
        throw new Error('synthetic validation failure');
      },
    },
  });

  await service.registerSecret('api/public', 'api_key', 'live-api-key');
  const result = await service.rotate('api/public');
  const descriptor = await store.getSecret('api/public');

  assert.equal(result.phase, 'rolled_back');
  assert.equal(result.oldVersionId, 'v1');
  assert.equal(descriptor?.currentVersionId, 'v1');
  assert.equal(descriptor?.phase, 'rolled_back');
  assert.match(descriptor?.lastError ?? '', /synthetic validation failure/);
  assert.equal(service.metricsSnapshot().rotationsFailed, 1);
  assert.equal(service.metricsSnapshot().rollbacks, 1);
}

async function testDueForRotation() {
  const now = new Date('2026-01-01T00:00:00.000Z');
  let sequence = 0;
  const store = new InMemorySecretStore();
  const service = new SecretRotationService({
    store,
    clock: () => now,
    versionIdFactory: () => `v${++sequence}`,
  });

  await service.registerSecret(
    'database/old',
    'database',
    'old',
    new Date('2025-12-31T00:00:00.000Z'),
  );
  await service.registerSecret(
    'database/future',
    'database',
    'future',
    new Date('2026-02-01T00:00:00.000Z'),
  );

  const due = await service.dueForRotation(now);
  assert.deepEqual(
    due.map((secret) => secret.name),
    ['database/old'],
  );
}

(async () => {
  await testSuccessfulRotation();
  await testRollbackOnValidationFailure();
  await testDueForRotation();
  console.log('secret_rotation tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
