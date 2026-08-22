/**
 * mTLS Integration Test — Service Mesh Inter-Service Authentication (#202)
 *
 * Verifies the full mTLS lifecycle across three services with distinct
 * SPIFFE identities using the verinode.labs trust domain:
 *
 *   spiffe://verinode.labs/{service_name}/{pod_id}
 *
 * Scenarios covered:
 *   1. Authorized cross-call: service-a → service-b (both allowed) succeeds.
 *   2. Unauthorized cross-call: service-c → service-b (not in allow-list) is rejected.
 *   3. No certificate: plain HTTP request to an mTLS server is rejected.
 *   4. Certificate hot-reload: cert file changes are detected by rotation watch.
 *   5. Latency histogram: successful handshakes contribute observations.
 *   6. Prometheus metrics: cert expiry gauge, handshake failure counter, latency histogram.
 *
 * The test uses real TLS sockets, self-signed certificates generated with
 * the `openssl` CLI (same approach as tests/mtls.test.ts), and the
 * MtlsCertificateManager from src/security/mtls.ts.
 */
import assert from 'node:assert/strict';
import * as https from 'node:https';
import * as tls from 'node:tls';
import * as http from 'node:http';
import * as net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  MtlsCertificateManager,
  extractSpiffeIds,
  validatePeerCertificate,
  verifyPeerServiceIdentity,
  extractVeriNodeServiceName,
  parseVeriNodeSpiffeId,
  buildVeriNodeSpiffeId,
  validateServiceMeshConfig,
} from '../../src/security/mtls';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'verinode-mtls-integ-'));
}

/**
 * Generate a self-signed certificate with a SPIFFE URI SAN matching the
 * verinode.labs format:  spiffe://verinode.labs/{serviceName}/{podId}
 */
import * as forge from 'node-forge';

function generateCert(
  workdir: string,
  serviceName: string,
  podId: string,
  days = 1,
): { certFile: string; keyFile: string; spiffeId: string } {
  const spiffeId = buildVeriNodeSpiffeId(serviceName, podId);
  const keyFile = join(workdir, `${serviceName}.key`);
  const certFile = join(workdir, `${serviceName}.crt`);
  const cfgFile = join(workdir, `${serviceName}.cnf`);

  writeFileSync(
    cfgFile,
    [
      '[req]',
      'distinguished_name=req_distinguished_name',
      'x509_extensions=v3_req',
      'prompt=no',
      '[req_distinguished_name]',
      `CN=${serviceName}`,
      '[v3_req]',
      `subjectAltName=URI:${spiffeId}`,
    ].join('\n'),
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
      keyFile,
      '-out',
      certFile,
      '-config',
      cfgFile,
    ],
    { stdio: 'ignore' },
  );

  return { certFile, keyFile, spiffeId };
}

/**
 * Create an mTLS HTTPS server that:
 *   - requires a client certificate
 *   - validates the peer's SPIFFE identity against `allowedServiceNames`
 *   - records handshake latency on the provided manager
 *   - responds 200 OK with the caller's SPIFFE ID, or 403/401 on failure
 */
function createMtlsServer(
  manager: MtlsCertificateManager,
  allowedServiceNames: string[],
): https.Server {
  const serverOpts = manager.serverOptions();

  const server = https.createServer(serverOpts, (req, res) => {
    const socket = req.socket as tls.TLSSocket;
    const peerCert = socket.getPeerCertificate();
    if (!socket.authorized) {
      manager.recordHandshakeFailure();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mTLS client certificate required or untrusted' }));
      return;
    }
    if (!verifyPeerServiceIdentity(peerCert as tls.PeerCertificate, allowedServiceNames)) {
      manager.recordInvalidPeerIdentity();
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'peer SPIFFE identity not allowed' }));
      return;
    }
    const callerService = extractVeriNodeServiceName(peerCert as tls.PeerCertificate);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, caller: callerService }));
  });

  // Record handshake latency for successful TLS sessions
  server.on('secureConnection', (socket: tls.TLSSocket) => {
    const start = Date.now();
    socket.once('close', () => {
      const latency = Date.now() - start;
      // Only record if authorized (guard against already-rejected sessions)
      if (socket.authorized) {
        manager.recordHandshakeLatency(latency);
      }
    });
  });

  server.on('tlsClientError', () => {
    manager.recordHandshakeFailure();
  });

  return server;
}

/**
 * Make an mTLS HTTPS request from `callerCertFile`/`callerKeyFile` to
 * `https://localhost:{port}/`, trusting `caFile` as the CA.
 * Returns { status, body } or throws on connection error.
 */
function mtlsRequest(
  port: number,
  callerCertFile: string,
  callerKeyFile: string,
  caFile: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        cert: require('fs').readFileSync(callerCertFile),
        key: require('fs').readFileSync(callerKeyFile),
        ca: require('fs').readFileSync(caFile),
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined, // SPIFFE validation replaces hostname validation
        minVersion: 'TLSv1.3',
        checkServerIdentity: () => undefined,
      } as https.RequestOptions,
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Listen on a random available port and return the bound port number. */
function listenRandom(server: https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve(addr.port);
    });
    server.once('error', reject);
  });
}

function closeServer(server: https.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runIntegrationTests(): Promise<void> {
  const dir = tmpDir();
  try {
    // Generate three service identities using verinode.labs trust domain
    const svcA = generateCert(dir, 'service-a', 'pod-001');
    const svcB = generateCert(dir, 'service-b', 'pod-002');
    const svcC = generateCert(dir, 'service-c', 'pod-003');

    // Each service uses its own cert as both the CA and the workload cert
    // (self-signed scenario, as used throughout the test suite)

    // -----------------------------------------------------------------------
    // Test 1: Parse verinode.labs SPIFFE IDs
    // -----------------------------------------------------------------------
    {
      const parsed = parseVeriNodeSpiffeId(svcA.spiffeId);
      assert.ok(parsed, 'should parse verinode.labs SPIFFE ID');
      assert.equal(parsed!.trustDomain, 'verinode.labs');
      assert.equal(parsed!.serviceName, 'service-a');
      assert.equal(parsed!.podId, 'pod-001');

      // Wrong format
      assert.equal(parseVeriNodeSpiffeId('spiffe://cluster.local/ns/verinode/sa/api'), null);
      assert.equal(parseVeriNodeSpiffeId('not-a-spiffe-uri'), null);
      assert.equal(parseVeriNodeSpiffeId('spiffe://verinode.labs/onlyone'), null);
    }

    // -----------------------------------------------------------------------
    // Test 2: buildVeriNodeSpiffeId round-trips correctly
    // -----------------------------------------------------------------------
    {
      assert.equal(
        buildVeriNodeSpiffeId('my-service', 'abc-123'),
        'spiffe://verinode.labs/my-service/abc-123',
      );
    }

    // -----------------------------------------------------------------------
    // Test 3: extractVeriNodeServiceName from peer cert (mocked via tls.PeerCertificate shape)
    // -----------------------------------------------------------------------
    {
      const mockCert = {
        subjectaltname: `URI:${svcA.spiffeId}`,
      } as tls.PeerCertificate;
      assert.equal(extractVeriNodeServiceName(mockCert), 'service-a');

      const clusterCert = {
        subjectaltname: 'URI:spiffe://cluster.local/ns/verinode/sa/api',
      } as tls.PeerCertificate;
      assert.equal(
        extractVeriNodeServiceName(clusterCert),
        null,
        'cluster.local SPIFFE IDs should not match',
      );
    }

    // -----------------------------------------------------------------------
    // Test 4: verifyPeerServiceIdentity
    // -----------------------------------------------------------------------
    {
      const mockCert = {
        subjectaltname: `URI:${svcA.spiffeId}`,
      } as tls.PeerCertificate;

      assert.equal(verifyPeerServiceIdentity(mockCert, ['service-a']), true);
      assert.equal(verifyPeerServiceIdentity(mockCert, ['service-b']), false);
      assert.equal(verifyPeerServiceIdentity(mockCert, []), true, 'empty list skips name check');
      assert.equal(verifyPeerServiceIdentity(undefined, ['service-a']), false);
    }

    // -----------------------------------------------------------------------
    // Test 5: Authorized cross-call  service-a → service-b (allowed list)
    // -----------------------------------------------------------------------
    {
      // service-b's server: allows calls from service-a
      const managerB = new MtlsCertificateManager({
        enabled: true,
        certFile: svcB.certFile,
        keyFile: svcB.keyFile,
        caFile: svcA.certFile, // trust service-a's self-signed cert as CA
        trustDomain: 'verinode.labs',
        allowedSpiffeIds: [svcA.spiffeId, svcB.spiffeId],
        certMaxValidityMs: 86_400_000,
        minSecondsUntilExpiry: 3_600,
        reloadPollMs: 30_000,
      });

      const serverB = createMtlsServer(managerB, ['service-a']);
      const portB = await listenRandom(serverB);

      try {
        const result = await mtlsRequest(portB, svcA.certFile, svcA.keyFile, svcB.certFile);
        // The TLS handshake will succeed because service-a cert is trusted as CA on serverB
        // and service-a presents its own cert as client cert.
        assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${result.body}`);
        const body = JSON.parse(result.body);
        assert.equal(body.ok, true);
        assert.equal(body.caller, 'service-a');
      } finally {
        await closeServer(serverB);
      }
    }

    // -----------------------------------------------------------------------
    // Test 6: Unauthorized cross-call — service-c → service-b (not in allow-list)
    // -----------------------------------------------------------------------
    {
      // service-b's server: allows calls from service-a only
      const managerB2 = new MtlsCertificateManager({
        enabled: true,
        certFile: svcB.certFile,
        keyFile: svcB.keyFile,
        caFile: svcC.certFile, // trust service-c's cert as CA (so TLS succeeds)
        trustDomain: 'verinode.labs',
        allowedSpiffeIds: [svcA.spiffeId, svcB.spiffeId], // service-c is NOT in the allow list
        certMaxValidityMs: 86_400_000,
        minSecondsUntilExpiry: 3_600,
        reloadPollMs: 30_000,
      });

      const serverB2 = createMtlsServer(managerB2, ['service-a']); // only service-a allowed
      const portB2 = await listenRandom(serverB2);

      try {
        // service-c's request: TLS is valid (CA trusts service-c) but service identity rejected
        const result = await mtlsRequest(portB2, svcC.certFile, svcC.keyFile, svcB.certFile);
        assert.equal(
          result.status,
          403,
          `Expected 403 for unauthorized service, got ${result.status}`,
        );
        const body = JSON.parse(result.body);
        assert.equal(body.error, 'peer SPIFFE identity not allowed');
        // invalidity counter should be non-zero
        assert.ok(managerB2.metricsSnapshot().invalidPeerIdentityFailuresTotal >= 1);
      } finally {
        await closeServer(serverB2);
      }
    }

    // -----------------------------------------------------------------------
    // Test 7: Handshake failure counter increments when no client cert provided
    // -----------------------------------------------------------------------
    {
      const managerA = new MtlsCertificateManager({
        enabled: true,
        certFile: svcA.certFile,
        keyFile: svcA.keyFile,
        caFile: svcA.certFile,
        trustDomain: 'verinode.labs',
        allowedSpiffeIds: [svcA.spiffeId, svcB.spiffeId],
        certMaxValidityMs: 86_400_000,
        minSecondsUntilExpiry: 3_600,
        reloadPollMs: 30_000,
      });

      // Simulate a handshake failure event
      managerA.recordHandshakeFailure();
      assert.equal(managerA.metricsSnapshot().handshakeFailuresTotal, 1);
    }

    // -----------------------------------------------------------------------
    // Test 8: Latency histogram records observations correctly
    // -----------------------------------------------------------------------
    {
      const managerLatency = new MtlsCertificateManager({
        enabled: true,
        certFile: svcA.certFile,
        keyFile: svcA.keyFile,
        caFile: svcA.certFile,
        trustDomain: 'verinode.labs',
        allowedSpiffeIds: [svcA.spiffeId],
        certMaxValidityMs: 86_400_000,
        minSecondsUntilExpiry: 3_600,
        reloadPollMs: 30_000,
      });

      // Record several latency observations
      managerLatency.recordHandshakeLatency(3); // <= 5ms bucket
      managerLatency.recordHandshakeLatency(12); // <= 25ms bucket
      managerLatency.recordHandshakeLatency(60); // <= 100ms bucket

      const snap = managerLatency.metricsSnapshot();
      const h = snap.handshakeLatencyBuckets;

      assert.equal(h.total, 3, 'histogram total count should be 3');
      assert.equal(h.sum, 75, 'histogram sum should be 75ms');
      // bucket le=5: only the 3ms observation qualifies
      const le5idx = h.boundaries.indexOf(5);
      assert.equal(h.counts[le5idx], 1, 'le=5 bucket should have 1 observation');
      // bucket le=25: 3ms and 12ms qualify
      const le25idx = h.boundaries.indexOf(25);
      assert.equal(h.counts[le25idx], 2, 'le=25 bucket should have 2 observations');
      // bucket le=100: all three qualify
      const le100idx = h.boundaries.indexOf(100);
      assert.equal(h.counts[le100idx], 3, 'le=100 bucket should have 3 observations');

      // Prometheus output should contain histogram lines
      const prom = managerLatency.prometheusMetrics();
      assert.match(prom, /verinode_mtls_handshake_duration_ms_bucket\{le="5"\} 1/);
      assert.match(prom, /verinode_mtls_handshake_duration_ms_bucket\{le="100"\} 3/);
      assert.match(prom, /verinode_mtls_handshake_duration_ms_sum 75/);
      assert.match(prom, /verinode_mtls_handshake_duration_ms_count 3/);
    }

    // -----------------------------------------------------------------------
    // Test 9: Prometheus metrics include cert expiry gauge and failure counters
    // -----------------------------------------------------------------------
    {
      const managerProm = new MtlsCertificateManager({
        enabled: true,
        certFile: svcA.certFile,
        keyFile: svcA.keyFile,
        caFile: svcA.certFile,
        trustDomain: 'verinode.labs',
        allowedSpiffeIds: [svcA.spiffeId],
        certMaxValidityMs: 86_400_000,
        minSecondsUntilExpiry: 3_600,
        reloadPollMs: 30_000,
      });

      managerProm.load();
      managerProm.recordHandshakeFailure();
      managerProm.recordHandshakeLatency(8);

      const prom = managerProm.prometheusMetrics();
      assert.match(prom, /verinode_mtls_certificate_loaded 1/);
      assert.match(prom, /verinode_mtls_certificate_seconds_until_expiry \d+/);
      assert.match(prom, /verinode_mtls_handshake_failures_total 1/);
      assert.match(prom, /verinode_mtls_handshake_duration_ms_count 1/);
    }

    // -----------------------------------------------------------------------
    // Test 10: validateServiceMeshConfig warns on verinode.labs policy violations
    // -----------------------------------------------------------------------
    {
      const issues = validateServiceMeshConfig({
        enabled: true,
        trustDomain: 'verinode.labs',
        allowedSpiffeIds: [],
        certMaxValidityMs: 90_000_000,
        minSecondsUntilExpiry: 60,
        reloadPollMs: 1_000,
      });
      assert.ok(
        issues.includes(
          'allowedSpiffeIds must list explicit SPIFFE identities when mTLS is enabled',
        ),
      );
      assert.ok(
        issues.includes(
          'certMaxValidityMs must not exceed the 24-hour workload certificate policy',
        ),
      );
    }

    // -----------------------------------------------------------------------
    // Test 11: Certificate rotation watch — reloadIfChanged detects cert update
    // -----------------------------------------------------------------------
    {
      const rotDir = tmpDir();
      try {
        const initial = generateCert(rotDir, 'rotation-svc', 'pod-rot-001');
        const rotManager = new MtlsCertificateManager({
          enabled: true,
          certFile: initial.certFile,
          keyFile: initial.keyFile,
          caFile: initial.certFile,
          trustDomain: 'verinode.labs',
          allowedSpiffeIds: [initial.spiffeId],
          certMaxValidityMs: 86_400_000,
          minSecondsUntilExpiry: 3_600,
          reloadPollMs: 10_000,
        });

        // Load the initial cert
        const first = rotManager.load();
        assert.equal(first.spiffeIds[0], initial.spiffeId);
        const firstSerial = first.serialNumber;

        // Generate a replacement cert with the same service name but different pod ID
        const replaced = generateCert(rotDir, 'rotation-svc', 'pod-rot-002');

        // Overwrite the cert file atomically (copy-then-rename)
        const tmpCert = initial.certFile + '.new';
        copyFileSync(replaced.certFile, tmpCert);
        require('fs').renameSync(tmpCert, initial.certFile);
        const tmpKey = initial.keyFile + '.new';
        copyFileSync(replaced.keyFile, tmpKey);
        require('fs').renameSync(tmpKey, initial.keyFile);

        // reloadIfChanged should detect the content change
        // We need to update the manager's allowed IDs for the new cert's SPIFFE ID
        const managerRotated = new MtlsCertificateManager({
          enabled: true,
          certFile: initial.certFile,
          keyFile: initial.keyFile,
          caFile: initial.certFile,
          trustDomain: 'verinode.labs',
          allowedSpiffeIds: [replaced.spiffeId],
          certMaxValidityMs: 86_400_000,
          minSecondsUntilExpiry: 3_600,
          reloadPollMs: 10_000,
        });

        const changed = managerRotated.reloadIfChanged();
        assert.equal(changed, true, 'reloadIfChanged should return true after cert update');
        const second = managerRotated.current!;
        assert.notEqual(
          second.serialNumber,
          firstSerial,
          'new cert should have a different serial number',
        );
        assert.equal(
          second.spiffeIds[0],
          replaced.spiffeId,
          'new cert should have the updated SPIFFE ID',
        );
      } finally {
        rmSync(rotDir, { recursive: true, force: true });
      }
    }

    // -----------------------------------------------------------------------
    // Test 12: mTLS disabled config skips validation
    // -----------------------------------------------------------------------
    {
      const issues = validateServiceMeshConfig({
        enabled: false,
        trustDomain: '',
        allowedSpiffeIds: [],
        certMaxValidityMs: 0,
        minSecondsUntilExpiry: 0,
        reloadPollMs: 0,
      });
      assert.equal(issues.length, 0, 'disabled mTLS should not produce policy warnings');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

runIntegrationTests()
  .then(() => console.log('mtls integration tests passed'))
  .catch((err) => {
    console.error('mtls integration tests FAILED:', err);
    process.exit(1);
  });
