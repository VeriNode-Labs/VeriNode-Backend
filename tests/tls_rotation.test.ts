import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SecureContext } from 'tls';
import {
  AcmeIssuer,
  AcmeRenewalManager,
  CertificateStore,
  FileChallengeStore,
  StoredCertificate,
  TlsCertificateReloader,
} from '../src/tls/acme_rotation';

if (process.platform === 'win32') {
  const gitPaths = [
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files\\Git\\mingw64\\bin'
  ];
  for (const gitPath of gitPaths) {
    if (fs.existsSync(gitPath)) {
      process.env.PATH = `${gitPath};${process.env.PATH}`;
      break;
    }
  }
}

class StaticIssuer implements AcmeIssuer {
  public calls = 0;

  constructor(private readonly next: StoredCertificate) {}

  async issueCertificate(): Promise<StoredCertificate> {
    this.calls++;
    return this.next;
  }
}

class FailingIssuer implements AcmeIssuer {
  public calls = 0;

  async issueCertificate(): Promise<StoredCertificate> {
    this.calls++;
    throw new Error('acme unavailable');
  }
}

async function withTempDir<T>(name: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `verinode-${name}-`));
  try {
    return await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function selfSignedCertificate(dir: string, name: string, days: number): StoredCertificate {
  const keyPath = path.join(dir, `${name}.key`);
  const certPath = path.join(dir, `${name}.crt`);
  const configPath = path.join(dir, `${name}.openssl.cnf`);
  fs.writeFileSync(configPath, '[req]\ndistinguished_name=req_distinguished_name\n[req_distinguished_name]\n');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-config',
    configPath,
    '-subj',
    '/CN=localhost',
    '-days',
    String(days),
  ], { stdio: 'ignore' });
  return {
    privateKey: fs.readFileSync(keyPath, 'utf8'),
    certificate: fs.readFileSync(certPath, 'utf8'),
  };
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function check(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
      return;
    }
    console.log(`  ✗ ${name}`);
    failed++;
  }

  console.log('TLS ACME rotation tests\n');

  await withTempDir('tls-renew', async (dir) => {
    const oldCert = selfSignedCertificate(dir, 'old', 5);
    const newCert = selfSignedCertificate(dir, 'new', 90);
    const store = new CertificateStore({
      certPath: path.join(dir, 'live.crt'),
      keyPath: path.join(dir, 'live.key'),
    });
    await store.writeAtomic(oldCert);

    const issuer = new StaticIssuer(newCert);
    const alerts: string[] = [];
    const metrics: string[] = [];
    const manager = new AcmeRenewalManager({
      domains: ['localhost'],
      email: 'ops@example.com',
      issuer,
      store,
      now: () => new Date(),
      onAlert: (alert) => {
        alerts.push(`${alert.severity}:${alert.message}`);
      },
      onMetric: (name, value) => {
        metrics.push(`${name}:${value}`);
      },
    });

    const renewed = await manager.checkOnce();
    const status = await manager.status();
    const liveCert = await store.readCertificate();
    const tmpFiles = (await fsp.readdir(dir)).filter((entry) => entry.includes('.tmp'));

    check(renewed.attempted && renewed.renewed, 'certificate inside 30 days is renewed');
    check(issuer.calls === 1, 'ACME issuer called exactly once');
    check(liveCert.trim() === newCert.certificate.trim(), 'renewed certificate atomically replaces old certificate');
    check(tmpFiles.length === 0, 'atomic replacement leaves no temporary files behind');
    check(status.daysRemaining !== null && status.daysRemaining > 30, 'status reports fresh certificate after renewal');
    check(alerts.some((line) => line.startsWith('info:TLS certificate renewed successfully')), 'successful renewal emits alert');
    check(metrics.some((line) => line.startsWith('tls_certificate_days_remaining:')), 'days-remaining metric emitted');

    const second = await manager.checkOnce();
    check(!second.attempted && issuer.calls === 1, 'fresh certificate skips renewal on daily check');
  });

  await withTempDir('tls-fallback', async (dir) => {
    const oldCert = selfSignedCertificate(dir, 'old', 5);
    const store = new CertificateStore({
      certPath: path.join(dir, 'live.crt'),
      keyPath: path.join(dir, 'live.key'),
    });
    await store.writeAtomic(oldCert);

    const issuer = new FailingIssuer();
    const alerts: string[] = [];
    const manager = new AcmeRenewalManager({
      domains: ['localhost'],
      email: 'ops@example.com',
      issuer,
      store,
      now: () => new Date(),
      onAlert: (alert) => {
        alerts.push(`${alert.severity}:${alert.message}`);
      },
    });

    const result = await manager.checkOnce();
    const liveCert = await store.readCertificate();

    check(result.attempted && !result.renewed && result.error === 'acme unavailable', 'renewal failure is reported');
    check(liveCert.trim() === oldCert.certificate.trim(), 'renewal failure keeps existing certificate');
    check(alerts.some((line) => line.includes('critical:TLS certificate renewal failed')), 'failure inside 7 days emits critical alert');
  });

  await withTempDir('tls-challenge', async (dir) => {
    const challenges = new FileChallengeStore({ webroot: dir });
    await challenges.set('token_1-A', 'authorization');
    check((await challenges.get('token_1-A')) === 'authorization', 'ACME http-01 challenge is readable');
    await challenges.remove('token_1-A');
    check((await challenges.get('token_1-A')) === null, 'ACME http-01 challenge cleanup removes token');
    await assert.rejects(() => challenges.set('../escape', 'bad'), /invalid ACME challenge token/);
    passed++;
    console.log('  ✓ ACME challenge token rejects path traversal');
  });

  await withTempDir('tls-reloader', async (dir) => {
    const cert = selfSignedCertificate(dir, 'live', 90);
    const store = new CertificateStore({
      certPath: path.join(dir, 'live.crt'),
      keyPath: path.join(dir, 'live.key'),
    });
    await store.writeAtomic(cert);
    const reloader = new TlsCertificateReloader({ store });
    const initial = reloader.loadInitial();
    let callbackContext: SecureContext | undefined;
    reloader.SNICallback('localhost', (err, ctx) => {
      if (err) throw err;
      callbackContext = ctx;
    });
    check(callbackContext === initial, 'TLS reloader serves current SecureContext through SNICallback');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
