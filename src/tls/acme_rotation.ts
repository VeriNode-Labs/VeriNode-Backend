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
import { getConfigManager } from '../config/manager';
import { createLogger, StructuredLogger } from '../diagnostics/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RENEW_BEFORE_DAYS = 30;
const DEFAULT_EMERGENCY_NOTIFY_DAYS = 7;
const DEFAULT_CHECK_INTERVAL_MS = DAY_MS;
const DEFAULT_WATCH_DEBOUNCE_MS = 250;

// ── Certificate Alert Threshold ───────────────────────────────────────────────
/** Alert severity threshold: alert when < 14 days remaining. */
const CERT_ALERT_DAYS = 14;

// ── Central Cert Store Path ───────────────────────────────────────────────────
/** Default root directory for per-service certificates. */
const DEFAULT_CERTS_ROOT = '/etc/verinode/certs';

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

// ── DNS-01 Challenge Support ───────────────────────────────────────────────────

export interface Dns01ChallengeStore {
  /** Set a _acme-challenge TXT DNS record for the given domain. */
  setTxtRecord(domain: string, value: string): Promise<void>;
  /** Remove the _acme-challenge TXT DNS record for the given domain. */
  removeTxtRecord(domain: string): Promise<void>;
}

export interface AcmeDns01IssuerOptions {
  directoryUrl: string;
  accountKeyPath: string;
  dns01Store: Dns01ChallengeStore;
  termsOfServiceAgreed: boolean;
}

// ── Multi-Service Certificate Manager Types ───────────────────────────────────

/** Per-service certificate status reported by the management API. */
export interface ServiceCertStatus {
  service: string;
  certPath: string;
  keyPath: string;
  chainPath: string;
  exists: boolean;
  expiresAt: string | null;
  daysRemaining: number | null;
  shouldRenew: boolean;
  emergency: boolean;
  alerting: boolean;
}

export interface CertRenewRequest {
  /** Service name to renew. If omitted, all services are renewed. */
  service?: string;
}

export interface CertRenewResponse {
  results: Array<{ service: string } & RenewalResult>;
}

/** Options for a single managed service. */
export interface ManagedServiceOptions {
  /** Logical service name — used as the sub-directory name under certsRoot. */
  service: string;
  domains: string[];
  email: string;
  /** Override the default certsRoot for this service. */
  certsRoot?: string;
  /** Override renewBeforeDays for this service. */
  renewBeforeDays?: number;
  /** Override emergencyNotifyDays for this service. */
  emergencyNotifyDays?: number;
}

export interface CertLifecycleManagerOptions {
  /** Root path; per-service dirs are {certsRoot}/{service}/. Default: /etc/verinode/certs */
  certsRoot?: string;
  services: ManagedServiceOptions[];
  issuer: AcmeIssuer;
  checkIntervalMs?: number;
  now?: () => Date;
  onAlert?: (alert: RenewalAlert & { service: string }) => void | Promise<void>;
  onMetric?: (name: string, value: number, labels?: Record<string, string>) => void;
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

  async readStatus(
    now: Date,
    renewBeforeDays: number,
    emergencyNotifyDays: number,
  ): Promise<CertificateStatus> {
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
    const certBody = next.chain
      ? `${next.certificate.trim()}\n${next.chain.trim()}\n`
      : ensureTrailingNewline(next.certificate);
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
    const ca =
      this.chainPath && fs.existsSync(this.chainPath)
        ? fs.readFileSync(this.chainPath, 'utf8')
        : undefined;
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

// ── DNS-01 Issuer ─────────────────────────────────────────────────────────────

/**
 * ACME issuer that uses the DNS-01 challenge method.
 *
 * The caller provides a `Dns01ChallengeStore` that sets and removes
 * `_acme-challenge.<domain>` TXT records. This is required for
 * wildcard certificates and environments where HTTP-01 is not feasible.
 */
export class AcmeDns01Issuer implements AcmeIssuer {
  constructor(private readonly options: AcmeDns01IssuerOptions) {}

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
      challengePriority: ['dns-01'],
      challengeCreateFn: async (_authz: unknown, _challenge: unknown, keyAuthorization: string) => {
        const authz = _authz as { identifier?: { value?: string } };
        const domain = authz?.identifier?.value ?? request.domains[0];
        await this.options.dns01Store.setTxtRecord(domain, keyAuthorization);
      },
      challengeRemoveFn: async (_authz: unknown, _challenge: unknown) => {
        const authz = _authz as { identifier?: { value?: string } };
        const domain = authz?.identifier?.value ?? request.domains[0];
        await this.options.dns01Store.removeTxtRecord(domain);
      },
    });

    return {
      certificate: certificate.toString(),
      privateKey: privateKey.toString(),
    };
  }
}

// ── Certificate Metrics ───────────────────────────────────────────────────────

/**
 * Lightweight Prometheus-compatible metrics tracker for ACME certificate lifecycle.
 *
 * Tracks `cert_expiry_days` gauge per service and renewal counters.
 * Emits alerts when days remaining < CERT_ALERT_DAYS (14).
 */
export class CertLifecycleMetrics {
  /** cert_expiry_days gauge: keyed by service name. */
  private readonly expiryDaysGauge = new Map<string, number>();
  private readonly renewalAttempts = new Map<string, number>();
  private readonly renewalSuccesses = new Map<string, number>();
  private readonly renewalFailures = new Map<string, number>();

  setExpiryDays(service: string, days: number): void {
    this.expiryDaysGauge.set(service, days);
  }

  recordRenewalAttempt(service: string): void {
    this.renewalAttempts.set(service, (this.renewalAttempts.get(service) ?? 0) + 1);
  }

  recordRenewalSuccess(service: string): void {
    this.renewalSuccesses.set(service, (this.renewalSuccesses.get(service) ?? 0) + 1);
  }

  recordRenewalFailure(service: string): void {
    this.renewalFailures.set(service, (this.renewalFailures.get(service) ?? 0) + 1);
  }

  getExpiryDays(service: string): number | undefined {
    return this.expiryDaysGauge.get(service);
  }

  isAlertingForService(service: string): boolean {
    const days = this.expiryDaysGauge.get(service);
    return days !== undefined && days < CERT_ALERT_DAYS;
  }

  renderPrometheus(): string {
    const lines: string[] = [
      '# HELP verinode_cert_expiry_days Days until TLS certificate expires, per service.',
      '# TYPE verinode_cert_expiry_days gauge',
    ];
    for (const [service, days] of this.expiryDaysGauge) {
      lines.push(`verinode_cert_expiry_days{service="${service}"} ${days}`);
    }
    lines.push(
      '# HELP verinode_cert_renewal_attempts_total Total certificate renewal attempts per service.',
      '# TYPE verinode_cert_renewal_attempts_total counter',
    );
    for (const [service, count] of this.renewalAttempts) {
      lines.push(`verinode_cert_renewal_attempts_total{service="${service}"} ${count}`);
    }
    lines.push(
      '# HELP verinode_cert_renewal_successes_total Successful certificate renewals per service.',
      '# TYPE verinode_cert_renewal_successes_total counter',
    );
    for (const [service, count] of this.renewalSuccesses) {
      lines.push(`verinode_cert_renewal_successes_total{service="${service}"} ${count}`);
    }
    lines.push(
      '# HELP verinode_cert_renewal_failures_total Failed certificate renewal attempts per service.',
      '# TYPE verinode_cert_renewal_failures_total counter',
    );
    for (const [service, count] of this.renewalFailures) {
      lines.push(`verinode_cert_renewal_failures_total{service="${service}"} ${count}`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

// ── Multi-Service Certificate Lifecycle Manager ───────────────────────────────

/**
 * Manages the full ACME certificate lifecycle for multiple services.
 *
 * Each service stores its certificate at:
 *   {certsRoot}/{service}/cert.pem    — leaf certificate (PEM)
 *   {certsRoot}/{service}/key.pem     — private key (PEM)
 *   {certsRoot}/{service}/chain.pem   — CA chain (PEM)
 *
 * Behaviour:
 * - Daily cron check (configurable) across all registered services.
 * - Renews when < renewBeforeDays (default 30) days remain.
 * - Falls back to existing cert if renewal fails, until < 7 days left (emergency).
 * - Emits `cert_expiry_days` gauge metric per service; alerts when < 14 days.
 * - Provides the management API handler functions for express integration.
 */
export class CertLifecycleManager extends EventEmitter {
  private readonly certsRoot: string;
  private readonly checkIntervalMs: number;
  private readonly now: () => Date;
  private readonly metrics = new CertLifecycleMetrics();
  private readonly log = createLogger('cert-lifecycle');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** Per-service AcmeRenewalManager instances, keyed by service name. */
  private readonly managers = new Map<string, AcmeRenewalManager>();
  /** Per-service CertificateStore instances, keyed by service name. */
  private readonly stores = new Map<string, CertificateStore>();

  constructor(private readonly options: CertLifecycleManagerOptions) {
    super();
    this.certsRoot = options.certsRoot ?? DEFAULT_CERTS_ROOT;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());

    for (const svc of options.services) {
      const root = svc.certsRoot ?? this.certsRoot;
      const serviceDir = path.join(root, svc.service);
      const store = new CertificateStore({
        certPath: path.join(serviceDir, 'cert.pem'),
        keyPath: path.join(serviceDir, 'key.pem'),
        chainPath: path.join(serviceDir, 'chain.pem'),
      });
      this.stores.set(svc.service, store);

      const renewBeforeDays = svc.renewBeforeDays ?? DEFAULT_RENEW_BEFORE_DAYS;
      const emergencyNotifyDays = svc.emergencyNotifyDays ?? DEFAULT_EMERGENCY_NOTIFY_DAYS;

      const manager = new AcmeRenewalManager({
        domains: svc.domains,
        email: svc.email,
        issuer: options.issuer,
        store,
        renewBeforeDays,
        emergencyNotifyDays,
        now: this.now,
        onAlert: async (alert) => {
          const enriched = { ...alert, service: svc.service };
          await options.onAlert?.(enriched);
          this.emit('alert', enriched);
        },
        onMetric: (name, value, labels) => {
          const enrichedLabels = { ...labels, service: svc.service };
          options.onMetric?.(name, value, enrichedLabels);
          if (name === 'tls_certificate_days_remaining') {
            this.metrics.setExpiryDays(svc.service, value);
            if (value < CERT_ALERT_DAYS) {
              const severity = value < emergencyNotifyDays ? 'critical' : 'warning';
              const alertMsg = `Certificate for service ${svc.service} expires in ${value} days (alert threshold: ${CERT_ALERT_DAYS} days)`;
              this.log.warn(alertMsg, { service: svc.service, days_remaining: value });
              void options.onAlert?.({ severity, message: alertMsg, service: svc.service });
            }
          }
        },
      });
      this.managers.set(svc.service, manager);
    }
  }

  /** Start the daily renewal check across all services. */
  start(): void {
    if (this.timer) return;
    this.running = true;
    void this.checkAllOnce();
    this.timer = setInterval(() => void this.checkAllOnce(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  /** Stop all renewal checks. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    for (const manager of this.managers.values()) {
      manager.stop();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Run renewal checks for all services immediately. */
  async checkAllOnce(): Promise<CertRenewResponse> {
    const results: CertRenewResponse['results'] = [];
    for (const [service, manager] of this.managers) {
      try {
        this.metrics.recordRenewalAttempt(service);
        const result = await manager.checkOnce();
        if (result.attempted && result.renewed) {
          this.metrics.recordRenewalSuccess(service);
        } else if (result.attempted && !result.renewed) {
          this.metrics.recordRenewalFailure(service);
        }
        results.push({ service, ...result });
      } catch (err) {
        this.metrics.recordRenewalFailure(service);
        results.push({
          service,
          attempted: true,
          renewed: false,
          expiresAt: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  }

  /** Run renewal check for a single service. */
  async checkServiceOnce(service: string): Promise<{ service: string } & RenewalResult> {
    const manager = this.managers.get(service);
    if (!manager) throw new Error(`Unknown service: ${service}`);
    this.metrics.recordRenewalAttempt(service);
    try {
      const result = await manager.checkOnce();
      if (result.attempted && result.renewed) this.metrics.recordRenewalSuccess(service);
      else if (result.attempted && !result.renewed) this.metrics.recordRenewalFailure(service);
      return { service, ...result };
    } catch (err) {
      this.metrics.recordRenewalFailure(service);
      return {
        service,
        attempted: true,
        renewed: false,
        expiresAt: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Get current certificate status for all services. */
  async getAllStatus(): Promise<ServiceCertStatus[]> {
    const statuses: ServiceCertStatus[] = [];
    for (const [service, store] of this.stores) {
      const manager = this.managers.get(service)!;
      const status = await manager.status();
      statuses.push({
        service,
        certPath: store.certPath,
        keyPath: store.keyPath,
        chainPath: store.chainPath ?? path.join(path.dirname(store.certPath), 'chain.pem'),
        exists: status.exists,
        expiresAt: status.expiresAt?.toISOString() ?? null,
        daysRemaining: status.daysRemaining,
        shouldRenew: status.shouldRenew,
        emergency: status.emergency,
        alerting: status.daysRemaining !== null && status.daysRemaining < CERT_ALERT_DAYS,
      });
    }
    return statuses;
  }

  /** Get current certificate status for a single service. */
  async getServiceStatus(service: string): Promise<ServiceCertStatus> {
    const store = this.stores.get(service);
    const manager = this.managers.get(service);
    if (!store || !manager) throw new Error(`Unknown service: ${service}`);
    const status = await manager.status();
    return {
      service,
      certPath: store.certPath,
      keyPath: store.keyPath,
      chainPath: store.chainPath ?? path.join(path.dirname(store.certPath), 'chain.pem'),
      exists: status.exists,
      expiresAt: status.expiresAt?.toISOString() ?? null,
      daysRemaining: status.daysRemaining,
      shouldRenew: status.shouldRenew,
      emergency: status.emergency,
      alerting: status.daysRemaining !== null && status.daysRemaining < CERT_ALERT_DAYS,
    };
  }

  prometheusMetrics(): string {
    return this.metrics.renderPrometheus();
  }

  getMetrics(): CertLifecycleMetrics {
    return this.metrics;
  }
}

// ── Management API Routes ─────────────────────────────────────────────────────

/**
 * Register the certificate management API routes on an Express app.
 *
 * Routes:
 *   POST /api/v1/certs/renew   — trigger renewal for one or all services
 *   GET  /api/v1/certs/status  — return current status for all services
 */
export function registerCertManagementRoutes(app: any, manager: CertLifecycleManager): void {
  /**
   * GET /api/v1/certs/status
   * Returns an array of ServiceCertStatus for all managed services.
   */
  app.get('/api/v1/certs/status', async (_req: any, res: any) => {
    try {
      const statuses = await manager.getAllStatus();
      res.json({ services: statuses });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'failed to get certificate status',
      });
    }
  });

  /**
   * POST /api/v1/certs/renew
   * Body: { service?: string }
   * Triggers renewal for a named service or all services if service is omitted.
   */
  app.post('/api/v1/certs/renew', async (req: any, res: any) => {
    try {
      const body: CertRenewRequest = req.body ?? {};
      if (body.service) {
        const result = await manager.checkServiceOnce(body.service);
        res.json({ results: [result] });
      } else {
        const response = await manager.checkAllOnce();
        res.json(response);
      }
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'renewal failed',
      });
    }
  });
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

  SNICallback(
    _servername: string,
    callback: (err: Error | null, ctx?: tls.SecureContext) => void,
  ): void {
    callback(null, this.getContext());
  }

  start(): void {
    if (this.watchers.length > 0) return;
    const dirs = new Set([
      path.dirname(this.options.store.certPath),
      path.dirname(this.options.store.keyPath),
    ]);
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
    return this.options.store.readStatus(
      this.now(),
      this.renewBeforeDays,
      this.emergencyNotifyDays,
    );
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
      await this.alert({
        severity: 'info',
        message: 'TLS certificate renewed successfully',
        status: after,
      });
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

export async function createAcmeChallengeHandler(
  store: ChallengeStore,
): Promise<express.RequestHandler> {
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

export async function bootstrapTlsFromEnv(
  app: express.Express,
  options: EnvTlsBootstrapOptions,
): Promise<https.Server | null> {
  if (process.env.TLS_ACME_ENABLED !== 'true') return null;
  const log = options.log ?? createLogger('acme_rotation', { 'tls.mode': 'acme' });
  const domains = readCsvEnv('TLS_DOMAINS');
  const email = process.env.TLS_ACME_EMAIL;
  const certPath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;
  if (domains.length === 0 || !email || !certPath || !keyPath) {
    throw new Error(
      'TLS_ACME_ENABLED requires TLS_DOMAINS, TLS_ACME_EMAIL, TLS_CERT_PATH, and TLS_KEY_PATH',
    );
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
    directoryUrl:
      process.env.TLS_ACME_DIRECTORY_URL ?? 'https://acme-v02.api.letsencrypt.org/directory',
    accountKeyPath:
      process.env.TLS_ACME_ACCOUNT_KEY_PATH ?? path.join(path.dirname(keyPath), 'acme-account.key'),
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
  const server = https.createServer(
    {
      SNICallback: reloader.SNICallback.bind(reloader),
      secureContext: initialContext,
    },
    app,
  );
  server.listen(Number(tlsPort), () =>
    log.log(`HTTPS server running on port ${tlsPort}`, { 'tls.port': Number(tlsPort) }),
  );

  app.locals.tlsCertificateStore = store;
  app.locals.tlsCertificateReloader = reloader;
  app.locals.tlsRenewalManager = manager;
  app.locals.tlsServer = server;
  app.locals.httpPort = options.httpPort;
  return server;
}

/**
 * Bootstrap TLS/ACME from the centralized config system,
 * falling back to environment variables and defaults.
 */
export async function bootstrapTlsFromConfig(
  app: express.Express,
  options: EnvTlsBootstrapOptions,
): Promise<https.Server | null> {
  let tlsCfg: any = {};
  try {
    const mgr = getConfigManager();
    tlsCfg = mgr.getIn('tls') ?? {};
  } catch {
    return bootstrapTlsFromEnv(app, options);
  }

  const acmeCfg = tlsCfg.acme ?? {};
  if (acmeCfg.enabled !== true) return null;

  const log = options.log ?? console;
  const domains: string[] = acmeCfg.domains ?? [];
  const email: string = acmeCfg.email ?? '';
  const certPath: string = tlsCfg.certPath ?? '';
  const keyPath: string = tlsCfg.keyPath ?? '';

  if (domains.length === 0 || !email || !certPath || !keyPath) {
    throw new Error('ACME TLS requires domains, email, certPath, and keyPath');
  }

  const webroot = tlsCfg.webroot ?? path.join(os.tmpdir(), 'verinode-acme');
  const challengeStore = new FileChallengeStore({ webroot });
  app.get('/.well-known/acme-challenge/:token', await createAcmeChallengeHandler(challengeStore));

  const store = new CertificateStore({
    certPath,
    keyPath,
    chainPath: tlsCfg.chainPath,
  });
  const issuer = new AcmeClientIssuer({
    directoryUrl: acmeCfg.directoryUrl ?? 'https://acme-v02.api.letsencrypt.org/directory',
    accountKeyPath:
      process.env.TLS_ACME_ACCOUNT_KEY_PATH ?? path.join(path.dirname(keyPath), 'acme-account.key'),
    challengeStore,
    termsOfServiceAgreed: acmeCfg.termsOfServiceAgreed === true,
  });
  const manager = new AcmeRenewalManager({
    domains,
    email,
    issuer,
    store,
    renewBeforeDays: acmeCfg.renewBeforeDays ?? 30,
    emergencyNotifyDays: acmeCfg.emergencyNotifyDays ?? 7,
    checkIntervalMs: acmeCfg.checkIntervalMs ?? 86400000,
    onAlert: async (alert) => {
      const line = `[tls-acme] ${alert.severity}: ${alert.message}`;
      if (alert.severity === 'critical') log.error(line, alert.error ?? '');
      else if (alert.severity === 'warning') log.warn(line, alert.error ?? '');
      else log.log(line);
    },
  });

  await manager.checkOnce();
  if (!(await store.exists())) throw new Error('TLS certificate unavailable after ACME bootstrap');

  const reloader = new TlsCertificateReloader({
    store,
    onReload: () => log.log('[tls-acme] TLS certificate reloaded'),
    onError: (err) => log.error('[tls-acme] TLS certificate reload failed', err),
  });
  const initialContext = reloader.loadInitial();
  reloader.start();
  manager.start();

  const tlsPort = process.env.TLS_PORT ?? '3443';
  const server = https.createServer(
    {
      SNICallback: reloader.SNICallback.bind(reloader),
      secureContext: initialContext,
    },
    app,
  );
  server.listen(Number(tlsPort), () =>
    log.log(`[tls-acme] HTTPS server running on port ${tlsPort}`),
  );

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
  const tmp = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
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
