import { EventEmitter } from 'events';
import { X509Certificate } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import type express from 'express';
import { createLogger, type StructuredLogger } from '../diagnostics/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RENEW_BEFORE_DAYS = 30;
const DEFAULT_EMERGENCY_NOTIFY_DAYS = 7;
const DEFAULT_CHECK_INTERVAL_MS = DAY_MS;
const DEFAULT_WATCH_DEBOUNCE_MS = 250;

export interface CertificatePaths {
  certPath: string;
  keyPath: string;
  chainPath?: string;
}

export interface StoredCertificate {
  certificate: string;
  privateKey: string;
  chain?: string;
}

export interface CertificateStatus {
  exists: boolean;
  expiresAt: Date | null;
  daysRemaining: number | null;
  shouldRenew: boolean;
  emergency: boolean;
}

export interface RenewalResult {
  attempted: boolean;
  renewed: boolean;
  expiresAt: Date | null;
  error?: string;
}

export interface RenewalAlert {
  severity: 'warning' | 'critical' | 'info';
  message: string;
  error?: unknown;
  status?: CertificateStatus;
}

export interface AcmeIssueRequest {
  domains: string[];
  email: string;
}

export interface AcmeIssuer {
  issueCertificate(request: AcmeIssueRequest): Promise<StoredCertificate>;
}

export interface CertificateStoreOptions extends CertificatePaths {
  fileMode?: number;
}

export interface ChallengeStore {
  set(token: string, keyAuthorization: string): Promise<void>;
  remove(token: string): Promise<void>;
  get(token: string): Promise<string | null>;
}

export interface FileChallengeStoreOptions {
  webroot: string;
}

export interface AcmeClientIssuerOptions {
  directoryUrl: string;
  accountKeyPath: string;
  challengeStore: ChallengeStore;
  termsOfServiceAgreed: boolean;
}

export interface RenewalManagerOptions {
  domains: string[];
  email: string;
  issuer: AcmeIssuer;
  store: CertificateStore;
  renewBeforeDays?: number;
  emergencyNotifyDays?: number;
  checkIntervalMs?: number;
  now?: () => Date;
  onAlert?: (alert: RenewalAlert) => void | Promise<void>;
  onMetric?: (name: string, value: number, labels?: Record<string, string>) => void;
}

export interface TlsReloaderOptions {
  store: CertificateStore;
  debounceMs?: number;
  onReload?: (context: tls.SecureContext) => void;
  onError?: (error: unknown) => void;
}

export interface EnvTlsBootstrapOptions {
  httpPort: number | string;
  log?: Pick<Console, 'log' | 'warn' | 'error'> | StructuredLogger;
}

export class CertificateStore {
  public readonly certPath: string;
  public readonly keyPath: string;
  public readonly chainPath?: string;
  private readonly fileMode: number;

  constructor(options: CertificateStoreOptions) {
    this.certPath = options.certPath;
    this.keyPath = options.keyPath;
    this.chainPath = options.chainPath;
    this.fileMode = options.fileMode ?? 0o600;
  }

  async exists(): Promise<boolean> {
    const [certExists, keyExists] = await Promise.all([
      fileExists(this.certPath),
      fileExists(this.keyPath),
    ]);
    return certExists && keyExists;
  }

  async readCertificate(): Promise<string> {
    return fsp.readFile(this.certPath, 'utf8');
  }

  async readPrivateKey(): Promise<string> {
    return fsp.readFile(this.keyPath, 'utf8');
  }

  async readStatus(now: Date, renewBeforeDays: number, emergencyNotifyDays: number): Promise<CertificateStatus> {
    if (!(await this.exists())) {
      return {
        exists: false,
        expiresAt: null,
        daysRemaining: null,
        shouldRenew: true,
        emergency: true,
      };
    }

    const cert = await this.readCertificate();
    const expiresAt = certificateExpiry(cert);
    const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);
    return {
      exists: true,
      expiresAt,
      daysRemaining,
      shouldRenew: daysRemaining < renewBeforeDays,
      emergency: daysRemaining < emergencyNotifyDays,
    };
  }

  async writeAtomic(next: StoredCertificate): Promise<void> {
    const certBody = next.chain ? `${next.certificate.trim()}\n${next.chain.trim()}\n` : ensureTrailingNewline(next.certificate);
    await Promise.all([
      atomicWriteFile(this.certPath, certBody, 0o644),
      atomicWriteFile(this.keyPath, ensureTrailingNewline(next.privateKey), this.fileMode),
    ]);
    if (this.chainPath && next.chain) {
      await atomicWriteFile(this.chainPath, ensureTrailingNewline(next.chain), 0o644);
    }
  }

  loadSecureContext(): tls.SecureContext {
    const cert = fs.readFileSync(this.certPath, 'utf8');
    const key = fs.readFileSync(this.keyPath, 'utf8');
    const ca = this.chainPath && fs.existsSync(this.chainPath) ? fs.readFileSync(this.chainPath, 'utf8') : undefined;
    return tls.createSecureContext({ cert, key, ca });
  }
}

export class FileChallengeStore implements ChallengeStore {
  private readonly challengeDir: string;

  constructor(options: FileChallengeStoreOptions) {
    this.challengeDir = path.join(options.webroot, '.well-known', 'acme-challenge');
  }

  async set(token: string, keyAuthorization: string): Promise<void> {
    validateChallengeToken(token);
    await fsp.mkdir(this.challengeDir, { recursive: true });
    await atomicWriteFile(path.join(this.challengeDir, token), keyAuthorization, 0o644);
  }

  async remove(token: string): Promise<void> {
    validateChallengeToken(token);
    await fsp.rm(path.join(this.challengeDir, token), { force: true });
  }

  async get(token: string): Promise<string | null> {
    validateChallengeToken(token);
    try {
      return await fsp.readFile(path.join(this.challengeDir, token), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

export class AcmeClientIssuer implements AcmeIssuer {
  constructor(private readonly options: AcmeClientIssuerOptions) {}

  async issueCertificate(request: AcmeIssueRequest): Promise<StoredCertificate> {
    if (request.domains.length === 0) throw new Error('at least one ACME domain is required');
    const acme = require('acme-client');
    await fsp.mkdir(path.dirname(this.options.accountKeyPath), { recursive: true });
    let accountKey: Buffer;
    if (await fileExists(this.options.accountKeyPath)) {
      accountKey = await fsp.readFile(this.options.accountKeyPath);
    } else {
      accountKey = await acme.forge.createPrivateKey();
      await atomicWriteFile(this.options.accountKeyPath, accountKey.toString(), 0o600);
    }

    const client = new acme.Client({
      directoryUrl: this.options.directoryUrl,
      accountKey,
    });
    const [privateKey, csr] = await acme.forge.createCsr({
      commonName: request.domains[0],
      altNames: request.domains,
    });

    const certificate = await client.auto({
      csr,
      email: request.email,
      termsOfServiceAgreed: this.options.termsOfServiceAgreed,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_authz: unknown, _challenge: unknown, keyAuthorization: string) => {
        const challenge = _challenge as { token?: string };
        if (!challenge.token) throw new Error('ACME http-01 challenge token missing');
        await this.options.challengeStore.set(challenge.token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz: unknown, _challenge: unknown) => {
        const challenge = _challenge as { token?: string };
        if (challenge.token) await this.options.challengeStore.remove(challenge.token);
      },
    });

    return {
      certificate: certificate.toString(),
      privateKey: privateKey.toString(),
    };
  }
}

export class TlsCertificateReloader extends EventEmitter {
  private currentContext: tls.SecureContext | null = null;
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;

  constructor(private readonly options: TlsReloaderOptions) {
    super();
    this.debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  }

  loadInitial(): tls.SecureContext {
    this.currentContext = this.options.store.loadSecureContext();
    return this.currentContext;
  }

  getContext(): tls.SecureContext {
    if (!this.currentContext) return this.loadInitial();
    return this.currentContext;
  }

  SNICallback(_servername: string, callback: (err: Error | null, ctx?: tls.SecureContext) => void): void {
    callback(null, this.getContext());
  }

  start(): void {
    if (this.watchers.length > 0) return;
    const dirs = new Set([path.dirname(this.options.store.certPath), path.dirname(this.options.store.keyPath)]);
    if (this.options.store.chainPath) dirs.add(path.dirname(this.options.store.chainPath));
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
      this.watchers.push(fs.watch(dir, () => this.scheduleReload()));
    }
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      try {
        const context = this.options.store.loadSecureContext();
        this.currentContext = context;
        this.options.onReload?.(context);
        this.emit('reload', context);
      } catch (err) {
        this.options.onError?.(err);
        this.emit('error', err);
      }
    }, this.debounceMs);
  }
}

export class AcmeRenewalManager extends EventEmitter {
  private readonly renewBeforeDays: number;
  private readonly emergencyNotifyDays: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: RenewalManagerOptions) {
    super();
    this.renewBeforeDays = options.renewBeforeDays ?? DEFAULT_RENEW_BEFORE_DAYS;
    this.emergencyNotifyDays = options.emergencyNotifyDays ?? DEFAULT_EMERGENCY_NOTIFY_DAYS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
  }

  isRunning(): boolean {
    return this.running;
  }

  async status(): Promise<CertificateStatus> {
    return this.options.store.readStatus(this.now(), this.renewBeforeDays, this.emergencyNotifyDays);
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    void this.checkOnce();
    this.timer = setInterval(() => void this.checkOnce(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async checkOnce(): Promise<RenewalResult> {
    const before = await this.status();
    this.emitMetrics(before);
    if (!before.shouldRenew) {
      return { attempted: false, renewed: false, expiresAt: before.expiresAt };
    }

    try {
      const issued = await this.options.issuer.issueCertificate({
        domains: this.options.domains,
        email: this.options.email,
      });
      await this.options.store.writeAtomic(issued);
      const after = await this.status();
      this.emitMetrics(after);
      await this.alert({ severity: 'info', message: 'TLS certificate renewed successfully', status: after });
      this.emit('renewed', after);
      return { attempted: true, renewed: true, expiresAt: after.expiresAt };
    } catch (err) {
      const current = await this.status().catch(() => before);
      const severity = current.emergency ? 'critical' : 'warning';
      await this.alert({
        severity,
        message: current.emergency
          ? 'TLS certificate renewal failed and certificate is inside the 7-day emergency window'
          : 'TLS certificate renewal failed; keeping existing certificate',
        error: err,
        status: current,
      });
      this.emit('renewalFailed', err, current);
      return {
        attempted: true,
        renewed: false,
        expiresAt: current.expiresAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private emitMetrics(status: CertificateStatus): void {
    if (status.daysRemaining !== null) {
      this.options.onMetric?.('tls_certificate_days_remaining', status.daysRemaining, {
        domains: this.options.domains.join(','),
      });
    }
    this.options.onMetric?.('tls_certificate_renewal_due', status.shouldRenew ? 1 : 0, {
      domains: this.options.domains.join(','),
    });
  }

  private async alert(alert: RenewalAlert): Promise<void> {
    await this.options.onAlert?.(alert);
    this.emit('alert', alert);
  }
}

export async function createAcmeChallengeHandler(store: ChallengeStore): Promise<express.RequestHandler> {
  return async (req, res) => {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    if (!token) return res.status(400).send('invalid challenge');
    try {
      const value = await store.get(token);
      if (value === null) return res.status(404).send('challenge not found');
      res.type('text/plain').send(value);
    } catch (err) {
      res.status(400).send(err instanceof Error ? err.message : 'invalid challenge');
    }
  };
}

export async function bootstrapTlsFromEnv(app: express.Express, options: EnvTlsBootstrapOptions): Promise<https.Server | null> {
  if (process.env.TLS_ACME_ENABLED !== 'true') return null;
  const log = options.log ?? createLogger('acme_rotation', { 'tls.mode': 'acme' });
  const domains = readCsvEnv('TLS_DOMAINS');
  const email = process.env.TLS_ACME_EMAIL;
  const certPath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;
  if (domains.length === 0 || !email || !certPath || !keyPath) {
    throw new Error('TLS_ACME_ENABLED requires TLS_DOMAINS, TLS_ACME_EMAIL, TLS_CERT_PATH, and TLS_KEY_PATH');
  }

  const webroot = process.env.TLS_ACME_WEBROOT ?? path.join(os.tmpdir(), 'verinode-acme');
  const challengeStore = new FileChallengeStore({ webroot });
  app.get('/.well-known/acme-challenge/:token', await createAcmeChallengeHandler(challengeStore));

  const store = new CertificateStore({
    certPath,
    keyPath,
    chainPath: process.env.TLS_CHAIN_PATH,
  });
  const issuer = new AcmeClientIssuer({
    directoryUrl: process.env.TLS_ACME_DIRECTORY_URL ?? 'https://acme-v02.api.letsencrypt.org/directory',
    accountKeyPath: process.env.TLS_ACME_ACCOUNT_KEY_PATH ?? path.join(path.dirname(keyPath), 'acme-account.key'),
    challengeStore,
    termsOfServiceAgreed: process.env.TLS_ACME_TERMS_AGREED === 'true',
  });
  const manager = new AcmeRenewalManager({
    domains,
    email,
    issuer,
    store,
    renewBeforeDays: intEnv('TLS_RENEW_BEFORE_DAYS', DEFAULT_RENEW_BEFORE_DAYS),
    emergencyNotifyDays: intEnv('TLS_EMERGENCY_NOTIFY_DAYS', DEFAULT_EMERGENCY_NOTIFY_DAYS),
    checkIntervalMs: intEnv('TLS_RENEW_CHECK_INTERVAL_MS', DEFAULT_CHECK_INTERVAL_MS),
    onAlert: async (alert) => {
      const attrs = {
        'acme.alert.severity': alert.severity,
        'acme.alert.error': alert.error ?? '',
      };
      if (alert.severity === 'critical') log.error(alert.message, attrs);
      else if (alert.severity === 'warning') log.warn(alert.message, attrs);
      else log.log(alert.message, attrs);
    },
  });

  await manager.checkOnce();
  if (!(await store.exists())) throw new Error('TLS certificate unavailable after ACME bootstrap');

  const reloader = new TlsCertificateReloader({
    store,
    onReload: () => log.log('TLS certificate reloaded'),
    onError: (err) => log.error('TLS certificate reload failed', err),
  });
  const initialContext = reloader.loadInitial();
  reloader.start();
  manager.start();

  const tlsPort = process.env.TLS_PORT ?? '3443';
  const server = https.createServer({
    SNICallback: reloader.SNICallback.bind(reloader),
    secureContext: initialContext,
  }, app);
  server.listen(Number(tlsPort), () => log.log(`HTTPS server running on port ${tlsPort}`, { 'tls.port': Number(tlsPort) }));

  app.locals.tlsCertificateStore = store;
  app.locals.tlsCertificateReloader = reloader;
  app.locals.tlsRenewalManager = manager;
  app.locals.tlsServer = server;
  app.locals.httpPort = options.httpPort;
  return server;
}

function certificateExpiry(pem: string): Date {
  const parsed = new X509Certificate(pem);
  return new Date(parsed.validTo);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

async function atomicWriteFile(targetPath: string, content: string, mode: number): Promise<void> {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fsp.open(tmp, 'w', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, targetPath);
  await fsp.chmod(targetPath, mode);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function validateChallengeToken(token: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid ACME challenge token');
}

function readCsvEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
