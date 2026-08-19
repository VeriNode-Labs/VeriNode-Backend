/**
 * VeriNode Backend — TLS Certificate Lifecycle Tests (Issue #206)
 *
 * Covers: CertificateStore, AcmeRenewalManager, TlsCertificateReloader,
 *         FileChallengeStore, AcmeDns01Issuer, CertLifecycleManager,
 *         CertLifecycleMetrics, registerCertManagementRoutes,
 *         and the integration scenario described in the issue:
 *         "issue cert, fast-forward 25 days, verify auto-renewal triggers
 *          and cert is replaced."
 *
 * Compatible with the project's ts-node test runner (no Jest/Mocha).
 */

import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  CertificateStore,
  FileChallengeStore,
  AcmeDns01Issuer,
  TlsCertificateReloader,
  AcmeRenewalManager,
  CertLifecycleManager,
  CertLifecycleMetrics,
  registerCertManagementRoutes,
  createAcmeChallengeHandler,
} from '../src/tls/acme_rotation';

import type {
  AcmeIssuer,
  AcmeIssueRequest,
  StoredCertificate,
  Dns01ChallengeStore,
  RenewalResult,
} from '../src/tls/acme_rotation';

// ── Simple test runner ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`  ✗ ${name}: ${msg}`);
    process.stdout.write(`  ✗ ${name}\n    ${msg}\n`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verinode-tls-test-'));
  return fn(dir).finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });
}

/**
 * Generate a self-signed certificate using the `openssl` CLI so that
 * X509Certificate.validTo parsing works correctly in CertificateStore.readStatus().
 * Tries common openssl paths (including Git for Windows).
 */
async function generateSelfSignedCert(
  dir: string,
  options: { daysValid?: number } = {},
): Promise<{ certPath: string; keyPath: string }> {
  const daysValid = options.daysValid ?? 90;
  const certPath = path.join(dir, `cert-${daysValid}-${Date.now()}.pem`);
  const keyPath = path.join(dir, `key-${daysValid}-${Date.now()}.pem`);

  // Try several possible openssl executable paths (Linux/Mac default, Git for Windows)
  const opensslCandidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Git\\usr\\bin\\openssl.exe',
  ];

  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', String(daysValid),
    '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=verinode-test',
  ];

  let lastError: unknown;
  for (const opensslBin of opensslCandidates) {
    try {
      execFileSync(opensslBin, args, { stdio: 'ignore' });
      return { certPath, keyPath };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`openssl not found. Tried: ${opensslCandidates.join(', ')}. Last error: ${lastError}`);
}

// ── Mock ACME Issuer ─────────────────────────────────────────────────────────

/**
 * Mock issuer that generates a real self-signed certificate so that
 * X509Certificate.validTo parsing works correctly.
 */
function createMockIssuer(opts: { fail?: boolean; daysValid?: number } = {}): AcmeIssuer {
  return {
    async issueCertificate(req: AcmeIssueRequest): Promise<StoredCertificate> {
      if (opts.fail) throw new Error('ACME issuer simulated failure');
      if (req.domains.length === 0) throw new Error('No domains');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-issuer-'));
      try {
        const { certPath, keyPath } = await generateSelfSignedCert(tmpDir, {
          daysValid: opts.daysValid ?? 90,
        });
        const certificate = await fsp.readFile(certPath, 'utf8');
        const privateKey = await fsp.readFile(keyPath, 'utf8');
        return { certificate, privateKey, chain: certificate };
      } finally {
        setTimeout(() => {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
        }, 0);
      }
    },
  };
}

// ── Minimal mock Express app for route testing ────────────────────────────────

function createMockApp() {
  const routes: Record<string, Function> = {};
  return {
    get(routePath: string, handler: Function) { routes[`GET:${routePath}`] = handler; },
    post(routePath: string, handler: Function) { routes[`POST:${routePath}`] = handler; },
    async request(method: string, routePath: string, body?: unknown): Promise<{ status: number; json: unknown }> {
      const key = `${method}:${routePath}`;
      const handler = routes[key];
      if (!handler) return { status: 404, json: { error: 'not found' } };
      let resStatus = 200;
      let resJson: unknown = null;
      const res = {
        status(code: number) { resStatus = code; return res; },
        json(data: unknown) { resJson = data; return res; },
      };
      const req = { body: body ?? {} };
      await handler(req, res);
      return { status: resStatus, json: resJson };
    },
  };
}

// ── Main test runner ─────────────────────────────────────────────────────────

async function runTests(): Promise<void> {

  // ── CertificateStore ────────────────────────────────────────────────────────

  console.log('\n  CertificateStore');

  await test('exists() returns false when cert files are absent', async () => {
    await withTempDir(async (dir) => {
      const store = new CertificateStore({
        certPath: path.join(dir, 'cert.pem'),
        keyPath: path.join(dir, 'key.pem'),
      });
      assert.equal(await store.exists(), false);
    });
  });

  await test('writeAtomic() creates cert and key files', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir);
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const targetDir = path.join(dir, 'output');
      const store = new CertificateStore({
        certPath: path.join(targetDir, 'cert.pem'),
        keyPath: path.join(targetDir, 'key.pem'),
        chainPath: path.join(targetDir, 'chain.pem'),
      });
      await store.writeAtomic({ certificate, privateKey, chain: certificate });
      assert.equal(await store.exists(), true);
      const written = await store.readCertificate();
      assert.ok(written.includes('CERTIFICATE'), 'cert content should include CERTIFICATE');
    });
  });

  await test('readStatus() returns shouldRenew=true when cert expires in < 30 days', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 10 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(dir, 'cert2.pem'),
        keyPath: path.join(dir, 'key2.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });
      const status = await store.readStatus(new Date(), 30, 7);
      assert.equal(status.exists, true);
      assert.equal(status.shouldRenew, true, 'should renew when < 30 days remain');
    });
  });

  await test('readStatus() returns shouldRenew=false when cert has > 30 days', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 60 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(dir, 'cert3.pem'),
        keyPath: path.join(dir, 'key3.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });
      const status = await store.readStatus(new Date(), 30, 7);
      assert.equal(status.shouldRenew, false, 'should not renew when > 30 days remain');
    });
  });

  await test('readStatus() returns emergency=true when cert < 7 days', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 3 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(dir, 'cert4.pem'),
        keyPath: path.join(dir, 'key4.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });
      const status = await store.readStatus(new Date(), 30, 7);
      assert.equal(status.emergency, true, 'should be emergency when < 7 days');
    });
  });

  // ── FileChallengeStore (HTTP-01) ───────────────────────────────────────────

  console.log('\n  FileChallengeStore (HTTP-01)');

  await test('set/get/remove challenge token works', async () => {
    await withTempDir(async (dir) => {
      const store = new FileChallengeStore({ webroot: dir });
      await store.set('abc123', 'key-authorization-value');
      const val = await store.get('abc123');
      assert.equal(val, 'key-authorization-value');
      await store.remove('abc123');
      const gone = await store.get('abc123');
      assert.equal(gone, null);
    });
  });

  await test('get() returns null for unknown token', async () => {
    await withTempDir(async (dir) => {
      const store = new FileChallengeStore({ webroot: dir });
      const val = await store.get('nonexistent');
      assert.equal(val, null);
    });
  });

  await test('set() rejects invalid token characters', async () => {
    await withTempDir(async (dir) => {
      const store = new FileChallengeStore({ webroot: dir });
      await assert.rejects(
        () => store.set('../evil', 'value'),
        /invalid ACME challenge token/,
      );
    });
  });

  // ── DNS-01 Challenge ───────────────────────────────────────────────────────

  console.log('\n  AcmeDns01Issuer (DNS-01)');

  await test('AcmeDns01Issuer rejects empty domains array', async () => {
    const dns01Store: Dns01ChallengeStore = {
      async setTxtRecord() { return; },
      async removeTxtRecord() { return; },
    };
    const issuer = new AcmeDns01Issuer({
      directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      accountKeyPath: path.join(os.tmpdir(), 'acme-test-account.key'),
      dns01Store,
      termsOfServiceAgreed: true,
    });
    await assert.rejects(
      () => issuer.issueCertificate({ domains: [], email: 'test@example.com' }),
      /at least one ACME domain is required/,
    );
  });

  await test('DNS-01 challenge store set/remove records correctly', async () => {
    const records = new Map<string, string>();
    const dns01Store: Dns01ChallengeStore = {
      async setTxtRecord(domain: string, value: string) { records.set(domain, value); },
      async removeTxtRecord(domain: string) { records.delete(domain); },
    };
    await dns01Store.setTxtRecord('example.com', 'some-acme-key');
    assert.equal(records.get('example.com'), 'some-acme-key');
    await dns01Store.removeTxtRecord('example.com');
    assert.equal(records.has('example.com'), false);
  });

  // ── CertLifecycleMetrics ───────────────────────────────────────────────────

  console.log('\n  CertLifecycleMetrics');

  await test('setExpiryDays / getExpiryDays per service', () => {
    const metrics = new CertLifecycleMetrics();
    metrics.setExpiryDays('api-gateway', 42);
    metrics.setExpiryDays('auth-service', 5);
    assert.equal(metrics.getExpiryDays('api-gateway'), 42);
    assert.equal(metrics.getExpiryDays('auth-service'), 5);
    assert.equal(metrics.getExpiryDays('unknown'), undefined);
  });

  await test('isAlertingForService is true when < 14 days', () => {
    const metrics = new CertLifecycleMetrics();
    metrics.setExpiryDays('api-gateway', 13);
    metrics.setExpiryDays('auth-service', 20);
    assert.equal(metrics.isAlertingForService('api-gateway'), true);
    assert.equal(metrics.isAlertingForService('auth-service'), false);
    assert.equal(metrics.isAlertingForService('unknown'), false);
  });

  await test('isAlertingForService is false at exactly 14 days', () => {
    const metrics = new CertLifecycleMetrics();
    metrics.setExpiryDays('svc', 14);
    assert.equal(metrics.isAlertingForService('svc'), false);
  });

  await test('renderPrometheus includes cert_expiry_days gauge with service labels', () => {
    const metrics = new CertLifecycleMetrics();
    metrics.setExpiryDays('api-gateway', 30);
    metrics.setExpiryDays('auth-service', 5);
    metrics.recordRenewalAttempt('api-gateway');
    metrics.recordRenewalSuccess('api-gateway');
    metrics.recordRenewalAttempt('auth-service');
    metrics.recordRenewalFailure('auth-service');
    const prom = metrics.renderPrometheus();
    assert.ok(prom.includes('verinode_cert_expiry_days{service="api-gateway"} 30'), 'api-gateway gauge');
    assert.ok(prom.includes('verinode_cert_expiry_days{service="auth-service"} 5'), 'auth-service gauge');
    assert.ok(prom.includes('verinode_cert_renewal_successes_total{service="api-gateway"} 1'), 'success counter');
    assert.ok(prom.includes('verinode_cert_renewal_failures_total{service="auth-service"} 1'), 'failure counter');
    assert.ok(prom.includes('# HELP verinode_cert_expiry_days'), 'HELP line');
    assert.ok(prom.includes('# TYPE verinode_cert_expiry_days gauge'), 'TYPE line');
  });

  // ── AcmeRenewalManager ─────────────────────────────────────────────────────

  console.log('\n  AcmeRenewalManager');

  await test('checkOnce() does not renew when cert has > 30 days remaining', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 60 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(dir, 'out', 'cert.pem'),
        keyPath: path.join(dir, 'out', 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      let issueCalled = false;
      const trackingIssuer: AcmeIssuer = {
        async issueCertificate(req: AcmeIssueRequest): Promise<StoredCertificate> {
          issueCalled = true;
          return createMockIssuer().issueCertificate(req);
        },
      };

      const manager = new AcmeRenewalManager({
        domains: ['example.com'],
        email: 'admin@example.com',
        issuer: trackingIssuer,
        store,
        renewBeforeDays: 30,
      });
      const result: RenewalResult = await manager.checkOnce();
      assert.equal(result.attempted, false, 'should not attempt renewal');
      assert.equal(issueCalled, false, 'issuer should not be called');
    });
  });

  await test('checkOnce() renews when cert has < 30 days remaining', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 10 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(dir, 'out', 'cert.pem'),
        keyPath: path.join(dir, 'out', 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const manager = new AcmeRenewalManager({
        domains: ['example.com'],
        email: 'admin@example.com',
        issuer: createMockIssuer({ daysValid: 90 }),
        store,
        renewBeforeDays: 30,
      });
      const result: RenewalResult = await manager.checkOnce();
      assert.equal(result.attempted, true, 'should attempt renewal');
      assert.equal(result.renewed, true, 'should renew successfully');
      assert.ok(result.expiresAt !== null, 'new expiry date should be set');
    });
  });

  await test('checkOnce() emits warning alert on renewal failure', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 10 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(dir, 'out', 'cert.pem'),
        keyPath: path.join(dir, 'out', 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const alerts: string[] = [];
      const manager = new AcmeRenewalManager({
        domains: ['example.com'],
        email: 'admin@example.com',
        issuer: createMockIssuer({ fail: true }),
        store,
        renewBeforeDays: 30,
        onAlert: (a) => { alerts.push(a.severity); },
      });
      const result: RenewalResult = await manager.checkOnce();
      assert.equal(result.attempted, true, 'should attempt renewal');
      assert.equal(result.renewed, false, 'should not succeed');
      assert.ok(result.error !== undefined, 'should have error message');
      assert.ok(alerts.length > 0, 'should emit alert');
    });
  });

  await test('checkOnce() emits critical alert in emergency window on failure', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 3 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(dir, 'out', 'cert.pem'),
        keyPath: path.join(dir, 'out', 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const alerts: Array<{ severity: string }> = [];
      const manager = new AcmeRenewalManager({
        domains: ['example.com'],
        email: 'admin@example.com',
        issuer: createMockIssuer({ fail: true }),
        store,
        renewBeforeDays: 30,
        emergencyNotifyDays: 7,
        onAlert: (a) => { alerts.push({ severity: a.severity }); },
      });
      await manager.checkOnce();
      assert.ok(
        alerts.some((a) => a.severity === 'critical'),
        'should emit critical alert in emergency window',
      );
    });
  });

  await test('status() returns correct status when no cert exists', async () => {
    await withTempDir(async (dir) => {
      const store = new CertificateStore({
        certPath: path.join(dir, 'cert.pem'),
        keyPath: path.join(dir, 'key.pem'),
      });
      const manager = new AcmeRenewalManager({
        domains: ['example.com'],
        email: 'admin@example.com',
        issuer: createMockIssuer(),
        store,
      });
      const s = await manager.status();
      assert.equal(s.exists, false, 'no cert yet');
      assert.equal(s.shouldRenew, true, 'missing cert should trigger renewal');
      assert.equal(s.emergency, true, 'missing cert is emergency');
    });
  });

  await test('start() / stop() lifecycle runs without error', async () => {
    await withTempDir(async (dir) => {
      const store = new CertificateStore({
        certPath: path.join(dir, 'cert.pem'),
        keyPath: path.join(dir, 'key.pem'),
      });
      const manager = new AcmeRenewalManager({
        domains: ['example.com'],
        email: 'admin@example.com',
        issuer: createMockIssuer({ fail: true }),
        store,
        checkIntervalMs: 100_000,
      });
      manager.start();
      assert.equal(manager.isRunning(), true);
      manager.stop();
      assert.equal(manager.isRunning(), false);
    });
  });

  // ── Integration Test: Issue Cert, Fast-Forward 25 Days, Verify Renewal ─────

  console.log('\n  Integration: auto-renewal after 25 days (Issue #206)');

  await test('issue cert → fast-forward 25 days → renewal triggers → cert replaced', async () => {
    await withTempDir(async (dir) => {
      // Step 1: Issue an initial certificate with 30-day validity
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 30 });
      const initialCert = await fsp.readFile(srcCert, 'utf8');
      const initialKey = await fsp.readFile(srcKey, 'utf8');

      const storeDir = path.join(dir, 'store');
      const store = new CertificateStore({
        certPath: path.join(storeDir, 'cert.pem'),
        keyPath: path.join(storeDir, 'key.pem'),
        chainPath: path.join(storeDir, 'chain.pem'),
      });

      // Write the initial certificate
      await store.writeAtomic({ certificate: initialCert, privateKey: initialKey });
      const initialStatus = await store.readStatus(new Date(), 30, 7);
      assert.equal(initialStatus.exists, true, 'initial cert should exist');

      // Step 2: Fast-forward 25 days — the cert now has ~5 days left → < 30 days → should renew
      const msIn25Days = 25 * 24 * 60 * 60 * 1000;
      const simulatedNow = new Date(Date.now() + msIn25Days);

      // Step 3: Create renewal manager with simulated clock
      const manager = new AcmeRenewalManager({
        domains: ['example.com'],
        email: 'admin@example.com',
        issuer: createMockIssuer({ daysValid: 90 }),
        store,
        renewBeforeDays: 30,
        emergencyNotifyDays: 7,
        now: () => simulatedNow,
      });

      // Verify status shows renewal needed with fast-forwarded clock
      const statusBefore = await manager.status();
      assert.equal(
        statusBefore.shouldRenew, true,
        `cert should need renewal after 25 days, daysRemaining=${statusBefore.daysRemaining}`,
      );
      assert.ok(
        statusBefore.daysRemaining !== null && statusBefore.daysRemaining < 30,
        `expected < 30 days remaining, got ${statusBefore.daysRemaining}`,
      );

      // Step 4: Trigger renewal and verify cert is replaced on disk
      const result: RenewalResult = await manager.checkOnce();
      assert.equal(result.attempted, true, 'renewal should be attempted');
      assert.equal(result.renewed, true, 'renewal should succeed');
      assert.ok(result.expiresAt !== null, 'new expiry should be set');

      // Step 5: Verify the cert on disk was replaced with a longer-lived cert
      const newCertContent = await store.readCertificate();
      assert.ok(newCertContent.includes('CERTIFICATE'), 'new cert should be valid PEM');
      assert.ok(
        new Date(result.expiresAt!).getTime() > new Date(initialStatus.expiresAt!).getTime() + msIn25Days,
        'renewed cert should expire later than the original',
      );
    });
  });

  // ── CertLifecycleManager (Multi-Service) ──────────────────────────────────

  console.log('\n  CertLifecycleManager (multi-service)');

  await test('initializes per-service stores at {certsRoot}/{service}/', async () => {
    await withTempDir(async (dir) => {
      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [
          { service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' },
          { service: 'auth-service', domains: ['auth.example.com'], email: 'ops@example.com' },
        ],
        issuer: createMockIssuer({ fail: true }),
      });
      const statuses = await mgr.getAllStatus();
      assert.equal(statuses.length, 2, 'should return status for 2 services');
      const svcNames = statuses.map((s) => s.service).sort();
      assert.deepEqual(svcNames, ['api-gateway', 'auth-service']);

      const apiStatus = statuses.find((s) => s.service === 'api-gateway')!;
      assert.ok(
        apiStatus.certPath.includes(path.join(dir, 'api-gateway')),
        `cert path should be under certsRoot/service/, got ${apiStatus.certPath}`,
      );
      assert.ok(
        apiStatus.certPath.endsWith('cert.pem'),
        `cert file should be cert.pem, got ${apiStatus.certPath}`,
      );
      assert.ok(
        apiStatus.keyPath.endsWith('key.pem'),
        `key file should be key.pem, got ${apiStatus.keyPath}`,
      );
      assert.ok(
        apiStatus.chainPath.endsWith('chain.pem'),
        `chain file should be chain.pem, got ${apiStatus.chainPath}`,
      );
    });
  });

  await test('getAllStatus() returns alerting=true when cert < 14 days', async () => {
    await withTempDir(async (dir) => {
      const svcDir = path.join(dir, 'api-gateway');
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 10 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(svcDir, 'cert.pem'),
        keyPath: path.join(svcDir, 'key.pem'),
        chainPath: path.join(svcDir, 'chain.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer({ fail: true }),
      });
      const statuses = await mgr.getAllStatus();
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0].alerting, true, 'should be alerting when < 14 days remain');
    });
  });

  await test('getAllStatus() returns alerting=false when cert has > 14 days', async () => {
    await withTempDir(async (dir) => {
      const svcDir = path.join(dir, 'api-gateway');
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 20 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const store = new CertificateStore({
        certPath: path.join(svcDir, 'cert.pem'),
        keyPath: path.join(svcDir, 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer({ fail: true }),
      });
      const statuses = await mgr.getAllStatus();
      assert.equal(statuses[0].alerting, false, 'should not be alerting when > 14 days remain');
    });
  });

  await test('checkAllOnce() renews all services with expiring certs', async () => {
    await withTempDir(async (dir) => {
      for (const svc of ['svc-a', 'svc-b']) {
        const svcDir = path.join(dir, svc);
        const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 5 });
        const certificate = await fsp.readFile(srcCert, 'utf8');
        const privateKey = await fsp.readFile(srcKey, 'utf8');
        const store = new CertificateStore({
          certPath: path.join(svcDir, 'cert.pem'),
          keyPath: path.join(svcDir, 'key.pem'),
        });
        await store.writeAtomic({ certificate, privateKey });
      }

      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [
          { service: 'svc-a', domains: ['a.example.com'], email: 'ops@example.com' },
          { service: 'svc-b', domains: ['b.example.com'], email: 'ops@example.com' },
        ],
        issuer: createMockIssuer({ daysValid: 90 }),
      });
      const response = await mgr.checkAllOnce();
      assert.equal(response.results.length, 2, 'should have results for 2 services');
      for (const r of response.results) {
        assert.equal(r.renewed, true, `${r.service} should be renewed`);
      }
    });
  });

  await test('checkServiceOnce() renews individual service', async () => {
    await withTempDir(async (dir) => {
      const svcDir = path.join(dir, 'api-gateway');
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 5 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');
      const store = new CertificateStore({
        certPath: path.join(svcDir, 'cert.pem'),
        keyPath: path.join(svcDir, 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer({ daysValid: 90 }),
      });
      const result = await mgr.checkServiceOnce('api-gateway');
      assert.equal(result.service, 'api-gateway');
      assert.equal(result.renewed, true, 'should be renewed');
    });
  });

  await test('checkServiceOnce() throws for unknown service', async () => {
    await withTempDir(async (dir) => {
      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer(),
      });
      await assert.rejects(
        () => mgr.checkServiceOnce('nonexistent'),
        /Unknown service: nonexistent/,
      );
    });
  });

  await test('prometheusMetrics() includes cert_expiry_days gauge per service', async () => {
    await withTempDir(async (dir) => {
      const svcDir = path.join(dir, 'api-gateway');
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 10 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');
      const store = new CertificateStore({
        certPath: path.join(svcDir, 'cert.pem'),
        keyPath: path.join(svcDir, 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer({ fail: true }),
      });
      await mgr.checkAllOnce();
      const prom = mgr.prometheusMetrics();
      assert.ok(prom.includes('verinode_cert_expiry_days'), 'should include cert_expiry_days metric');
      assert.ok(prom.includes('service="api-gateway"'), 'should have api-gateway label');
    });
  });

  await test('start() / stop() lifecycle is idempotent', async () => {
    await withTempDir(async (dir) => {
      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer({ fail: true }),
        checkIntervalMs: 100_000,
      });
      mgr.start();
      assert.equal(mgr.isRunning(), true);
      mgr.start(); // idempotent
      assert.equal(mgr.isRunning(), true);
      mgr.stop();
      assert.equal(mgr.isRunning(), false);
    });
  });

  // ── Management API Routes ──────────────────────────────────────────────────

  console.log('\n  Management API (/api/v1/certs)');

  await test('GET /api/v1/certs/status returns services array', async () => {
    await withTempDir(async (dir) => {
      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer({ fail: true }),
      });
      const app = createMockApp();
      registerCertManagementRoutes(app, mgr);
      const response = await app.request('GET', '/api/v1/certs/status');
      assert.equal(response.status, 200, 'should return 200');
      const body = response.json as any;
      assert.ok(Array.isArray(body.services), 'should return services array');
      assert.equal(body.services[0].service, 'api-gateway');
    });
  });

  await test('POST /api/v1/certs/renew triggers renewal for all services', async () => {
    await withTempDir(async (dir) => {
      const svcDir = path.join(dir, 'api-gateway');
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 5 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');
      const store = new CertificateStore({
        certPath: path.join(svcDir, 'cert.pem'),
        keyPath: path.join(svcDir, 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer({ daysValid: 90 }),
      });
      const app = createMockApp();
      registerCertManagementRoutes(app, mgr);
      const response = await app.request('POST', '/api/v1/certs/renew', {});
      assert.equal(response.status, 200);
      const body = response.json as any;
      assert.ok(Array.isArray(body.results), 'should return results array');
      assert.equal(body.results[0].renewed, true, 'cert should be renewed');
    });
  });

  await test('POST /api/v1/certs/renew with service name targets only that service', async () => {
    await withTempDir(async (dir) => {
      const svcDir = path.join(dir, 'api-gateway');
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir, { daysValid: 5 });
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');
      const store = new CertificateStore({
        certPath: path.join(svcDir, 'cert.pem'),
        keyPath: path.join(svcDir, 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [
          { service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' },
        ],
        issuer: createMockIssuer({ daysValid: 90 }),
      });
      const app = createMockApp();
      registerCertManagementRoutes(app, mgr);
      const response = await app.request('POST', '/api/v1/certs/renew', { service: 'api-gateway' });
      assert.equal(response.status, 200);
      const body = response.json as any;
      assert.equal(body.results.length, 1, 'should only renew specified service');
      assert.equal(body.results[0].service, 'api-gateway');
    });
  });

  await test('POST /api/v1/certs/renew returns 500 for unknown service', async () => {
    await withTempDir(async (dir) => {
      const mgr = new CertLifecycleManager({
        certsRoot: dir,
        services: [{ service: 'api-gateway', domains: ['api.example.com'], email: 'ops@example.com' }],
        issuer: createMockIssuer(),
      });
      const app = createMockApp();
      registerCertManagementRoutes(app, mgr);
      const response = await app.request('POST', '/api/v1/certs/renew', { service: 'nonexistent' });
      assert.equal(response.status, 500);
    });
  });

  // ── TlsCertificateReloader ─────────────────────────────────────────────────

  console.log('\n  TlsCertificateReloader');

  await test('loadInitial() loads secureContext from store', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir);
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const storeDir = path.join(dir, 'tls');
      const store = new CertificateStore({
        certPath: path.join(storeDir, 'cert.pem'),
        keyPath: path.join(storeDir, 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const reloader = new TlsCertificateReloader({ store });
      const ctx = reloader.loadInitial();
      assert.ok(ctx !== null, 'secureContext should be loaded');
      assert.ok(reloader.getContext() !== null, 'getContext() should return context');
    });
  });

  await test('start() / stop() works without throwing', async () => {
    await withTempDir(async (dir) => {
      const { certPath: srcCert, keyPath: srcKey } = await generateSelfSignedCert(dir);
      const certificate = await fsp.readFile(srcCert, 'utf8');
      const privateKey = await fsp.readFile(srcKey, 'utf8');

      const storeDir = path.join(dir, 'tls');
      const store = new CertificateStore({
        certPath: path.join(storeDir, 'cert.pem'),
        keyPath: path.join(storeDir, 'key.pem'),
      });
      await store.writeAtomic({ certificate, privateKey });

      const reloader = new TlsCertificateReloader({ store });
      reloader.loadInitial();
      reloader.start();
      reloader.stop();
    });
  });

  // ── createAcmeChallengeHandler ─────────────────────────────────────────────

  console.log('\n  createAcmeChallengeHandler');

  await test('serves the challenge token value as text/plain', async () => {
    await withTempDir(async (dir) => {
      const store = new FileChallengeStore({ webroot: dir });
      await store.set('testtoken', 'test-key-auth');
      const handler = await createAcmeChallengeHandler(store);

      let sent: string | null = null;
      let contentType: string | null = null;
      let statusCode = 200;
      const req = { params: { token: 'testtoken' } };
      const res = {
        type(ct: string) { contentType = ct; return res; },
        send(val: string) { sent = val; return res; },
        status(code: number) { statusCode = code; return res; },
      };
      await handler(req as any, res as any, (() => { return; }) as any);
      assert.equal(sent, 'test-key-auth');
      assert.equal(contentType, 'text/plain');
      assert.equal(statusCode, 200);
    });
  });

  await test('returns 404 for unknown challenge token', async () => {
    await withTempDir(async (dir) => {
      const store = new FileChallengeStore({ webroot: dir });
      const handler = await createAcmeChallengeHandler(store);

      let statusCode = 200;
      const req = { params: { token: 'unknown' } };
      const res = {
        type(_ct: string) { return res; },
        send(_val: string) { return res; },
        status(code: number) { statusCode = code; return res; },
      };
      await handler(req as any, res as any, (() => { return; }) as any);
      assert.equal(statusCode, 404);
    });
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passed: ${passed} | Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const msg of failures) console.log(msg);
    process.exit(1);
  }
  console.log('All tls_rotation tests passed!\n');
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('tls_rotation test suite error:', err);
    process.exit(1);
  });
