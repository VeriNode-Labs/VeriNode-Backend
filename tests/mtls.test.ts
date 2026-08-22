import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MtlsCertificateManager,
  extractSpiffeIds,
  mtlsConfigFromEnv,
  validateSpiffeIdentity,
  validateServiceMeshConfig,
} from '../src/security/mtls';

import * as forge from 'node-forge';

function createCert(workdir: string, spiffeId: string, days = 1) {
  const key = join(workdir, 'tls.key');
  const cert = join(workdir, 'tls.crt');
  const config = join(workdir, 'openssl.cnf');
  writeFileSync(
    config,
    `
[req]
distinguished_name=req_distinguished_name
x509_extensions=v3_req
prompt=no
[req_distinguished_name]
CN=verinode-backend
[v3_req]
subjectAltName=URI:${spiffeId}
`,
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      String(days),
      '-keyout',
      key,
      '-out',
      cert,
      '-config',
      config,
    ],
    { stdio: 'ignore' },
  );
  return { key, cert, ca: cert };
}

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'verinode-mtls-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

withTempDir((dir) => {
  const identity = 'spiffe://cluster.local/ns/verinode/sa/verinode-backend';
  const paths = createCert(dir, identity);
  const manager = new MtlsCertificateManager({
    enabled: true,
    certFile: paths.cert,
    keyFile: paths.key,
    caFile: paths.ca,
    trustDomain: 'cluster.local',
    allowedSpiffeIds: [identity],
    certMaxValidityMs: 86_400_000,
    minSecondsUntilExpiry: 3_600,
    reloadPollMs: 10_000,
  });

  const loaded = manager.load();
  assert.equal(loaded.spiffeIds[0], identity);
  assert.equal(manager.serverOptions().requestCert, true);
  assert.equal(manager.serverOptions().rejectUnauthorized, true);
  manager.recordHandshakeFailure();
  manager.recordInvalidPeerIdentity();
  const metrics = manager.prometheusMetrics();
  assert.match(metrics, /verinode_mtls_certificate_loaded 1/);
  assert.match(metrics, /verinode_mtls_handshake_failures_total 1/);
  assert.match(metrics, /verinode_mtls_invalid_peer_identity_failures_total 1/);
});

assert.deepEqual(
  extractSpiffeIds({
    subjectaltname: 'DNS:example, URI:spiffe://cluster.local/ns/verinode/sa/api',
  } as any),
  ['spiffe://cluster.local/ns/verinode/sa/api'],
);
assert.equal(
  validateSpiffeIdentity(['spiffe://cluster.local/ns/verinode/sa/api'], 'cluster.local', []),
  true,
);
assert.equal(
  validateSpiffeIdentity(['spiffe://evil.local/ns/verinode/sa/api'], 'cluster.local', []),
  false,
);
assert.equal(
  validateSpiffeIdentity(['spiffe://cluster.local/ns/verinode/sa/api'], 'cluster.local', [
    'spiffe://cluster.local/ns/verinode/sa/worker',
  ]),
  false,
);

assert.equal(
  mtlsConfigFromEnv({ VERINODE_MTLS_ENABLED: '1', SPIFFE_ALLOWED_IDS: 'a,b' } as any).enabled,
  true,
);
assert.deepEqual(
  mtlsConfigFromEnv({ VERINODE_MTLS_ENABLED: '1', SPIFFE_ALLOWED_IDS: 'a,b' } as any)
    .allowedSpiffeIds,
  ['a', 'b'],
);

const meshIssues = validateServiceMeshConfig({
  enabled: true,
  trustDomain: 'cluster.local',
  allowedSpiffeIds: [],
  certMaxValidityMs: 90_000_000,
  minSecondsUntilExpiry: 60,
  reloadPollMs: 1_000,
});
assert.deepEqual(meshIssues, [
  'allowedSpiffeIds must list explicit SPIFFE identities when mTLS is enabled',
  'certMaxValidityMs must not exceed the 24-hour workload certificate policy',
  'minSecondsUntilExpiry should be at least 300 seconds for safe rotation alerting',
  'reloadPollMs should be at least 10000 milliseconds to avoid excessive filesystem polling',
]);

console.log('mtls tests passed');
