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
  const keyFile = join(workdir, 'tls.key');
  const certFile = join(workdir, 'tls.crt');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Math.floor(Math.random() * 1000000).toString() + Date.now().toString();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + days);

  const attrs = [{ name: 'commonName', value: 'verinode-backend' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 6, value: spiffeId }] }
  ]);

  cert.sign(keys.privateKey);

  const pemCert = forge.pki.certificateToPem(cert);
  const pemKey = forge.pki.privateKeyToPem(keys.privateKey);

  writeFileSync(certFile, pemCert);
  writeFileSync(keyFile, pemKey);

  return { key: keyFile, cert: certFile, ca: certFile };
}

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'verinode-mtls-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
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
  extractSpiffeIds({ subjectaltname: 'DNS:example, URI:spiffe://cluster.local/ns/verinode/sa/api' } as any),
  ['spiffe://cluster.local/ns/verinode/sa/api'],
);
assert.equal(validateSpiffeIdentity(['spiffe://cluster.local/ns/verinode/sa/api'], 'cluster.local', []), true);
assert.equal(validateSpiffeIdentity(['spiffe://evil.local/ns/verinode/sa/api'], 'cluster.local', []), false);
assert.equal(
  validateSpiffeIdentity(
    ['spiffe://cluster.local/ns/verinode/sa/api'],
    'cluster.local',
    ['spiffe://cluster.local/ns/verinode/sa/worker'],
  ),
  false,
);

assert.equal(mtlsConfigFromEnv({ VERINODE_MTLS_ENABLED: '1', SPIFFE_ALLOWED_IDS: 'a,b' } as any).enabled, true);
assert.deepEqual(mtlsConfigFromEnv({ VERINODE_MTLS_ENABLED: '1', SPIFFE_ALLOWED_IDS: 'a,b' } as any).allowedSpiffeIds, ['a', 'b']);

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
