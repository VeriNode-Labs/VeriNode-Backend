import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  MtlsCertificateManager,
  MtlsConfig,
  mtlsConfigFromEnv,
  validateSpiffeIdentity,
} from '../src/security/mtls';

interface CertPaths {
  caKey: string;
  caCert: string;
  serviceKey: string;
  serviceCsr: string;
  serviceCert: string;
  serviceExt: string;
}

const SPIFFE_ID = 'spiffe://cluster.local/ns/verinode/sa/verinode-backend';
const GIT_OPENSSL_CONF = 'C:\\Program Files\\Git\\usr\\ssl\\openssl.cnf';
const OPENSSL_ENV = existsSync(GIT_OPENSSL_CONF)
  ? { ...process.env, OPENSSL_CONF: process.env.OPENSSL_CONF || GIT_OPENSSL_CONF }
  : process.env;

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'ignore', env: OPENSSL_ENV });
}

function pathsFor(dir: string, prefix: string): CertPaths {
  return {
    caKey: join(dir, `${prefix}-ca.key`),
    caCert: join(dir, `${prefix}-ca.crt`),
    serviceKey: join(dir, `${prefix}-service.key`),
    serviceCsr: join(dir, `${prefix}-service.csr`),
    serviceCert: join(dir, `${prefix}-service.crt`),
    serviceExt: join(dir, `${prefix}-service.ext`),
  };
}

function generateCertificate(dir: string, prefix: string, days: number, spiffeId: string = SPIFFE_ID): CertPaths {
  const paths = pathsFor(dir, prefix);
  const caKey = basename(paths.caKey);
  const caCert = basename(paths.caCert);
  const serviceKey = basename(paths.serviceKey);
  const serviceCsr = basename(paths.serviceCsr);
  const serviceCert = basename(paths.serviceCert);
  const serviceExt = basename(paths.serviceExt);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKey], dir);
  openssl([
    'req',
    '-x509',
    '-new',
    '-key',
    caKey,
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=verinode-test-ca',
    '-out',
    caCert,
  ], dir);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', serviceKey], dir);
  openssl(['req', '-new', '-key', serviceKey, '-subj', '/CN=verinode-backend', '-out', serviceCsr], dir);
  writeFileSync(paths.serviceExt, [
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth,clientAuth',
    `subjectAltName=URI:${spiffeId}`,
    '',
  ].join('\n'));
  openssl([
    'x509',
    '-req',
    '-in',
    serviceCsr,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    serviceCert,
    '-days',
    String(days),
    '-sha256',
    '-extfile',
    serviceExt,
  ], dir);
  return paths;
}

function configFor(paths: CertPaths, allowedSpiffeIds: string[] = [SPIFFE_ID]): MtlsConfig {
  return {
    enabled: true,
    certFile: paths.serviceCert,
    keyFile: paths.serviceKey,
    caFile: paths.caCert,
    trustDomain: 'cluster.local',
    allowedSpiffeIds,
    certMaxValidityMs: 24 * 60 * 60 * 1000,
    minSecondsUntilExpiry: 60 * 60,
    reloadPollMs: 1_000,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'verinode-mtls-'));
  try {
    const certs = generateCertificate(dir, 'valid', 1);
    const manager = new MtlsCertificateManager(configFor(certs));
    const loaded = manager.load();
    assert.equal(loaded.spiffeIds[0], SPIFFE_ID, 'loads SPIFFE identity from URI SAN');
    assert(validateSpiffeIdentity(loaded.spiffeIds, 'cluster.local', [SPIFFE_ID]), 'accepts allowed SPIFFE identity');
    assert(!validateSpiffeIdentity(loaded.spiffeIds, 'example.test', [SPIFFE_ID]), 'rejects the wrong trust domain');

    const beforeFingerprint = loaded.fingerprint256;
    generateCertificate(dir, 'valid', 1);
    assert.equal(manager.reloadIfChanged(), true, 'reload detects overwritten certificate material');
    assert.notEqual(manager.current?.fingerprint256, beforeFingerprint, 'reload swaps to the new certificate without restarting');

    const metrics = manager.prometheusMetrics();
    assert(metrics.includes('verinode_mtls_certificate_loaded 1'), 'metrics report loaded certificate');
    assert(metrics.includes('verinode_mtls_certificate_seconds_until_expiry'), 'metrics expose certificate expiry');
    assert(metrics.includes('verinode_mtls_handshake_failures_total 0'), 'metrics expose handshake failures');

    const parsed = mtlsConfigFromEnv({
      VERINODE_MTLS_ENABLED: 'true',
      VERINODE_MTLS_CERT_FILE: certs.serviceCert,
      VERINODE_MTLS_KEY_FILE: certs.serviceKey,
      VERINODE_MTLS_CA_FILE: certs.caCert,
      SPIFFE_TRUST_DOMAIN: 'cluster.local',
      SPIFFE_ALLOWED_IDS: `${SPIFFE_ID}, spiffe://cluster.local/ns/verinode/sa/worker`,
    });
    assert.equal(parsed.enabled, true, 'env parser enables mTLS');
    assert.deepEqual(parsed.allowedSpiffeIds, [SPIFFE_ID, 'spiffe://cluster.local/ns/verinode/sa/worker']);

    const twoDayCerts = generateCertificate(dir, 'too-long', 2);
    assert.throws(
      () => new MtlsCertificateManager(configFor(twoDayCerts)).load(),
      /validity exceeds 24-hour policy/,
      'rejects workload certificates longer than 24 hours',
    );

    const wrongIdentityCerts = generateCertificate(dir, 'wrong-id', 1, 'spiffe://cluster.local/ns/other/sa/backend');
    assert.throws(
      () => new MtlsCertificateManager(configFor(wrongIdentityCerts)).load(),
      /missing an allowed SPIFFE identity/,
      'rejects certificates outside the allowed SPIFFE set',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
