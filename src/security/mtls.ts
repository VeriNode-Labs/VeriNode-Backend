import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync, watch, FSWatcher } from 'node:fs';
import * as tls from 'node:tls';
import { createLogger } from '../diagnostics/logger';

const DEFAULT_CERT_MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_SECONDS_UNTIL_EXPIRY = 60 * 60;
const DEFAULT_RELOAD_POLL_MS = 30_000;

export interface MtlsConfig {
  enabled: boolean;
  certFile?: string;
  keyFile?: string;
  caFile?: string;
  trustDomain: string;
  allowedSpiffeIds: string[];
  certMaxValidityMs: number;
  minSecondsUntilExpiry: number;
  reloadPollMs: number;
}

export interface MtlsMetricsSnapshot {
  certificateLoaded: boolean;
  certificateExpiresAtUnix: number;
  certificateSecondsUntilExpiry: number;
  certificateReloadsTotal: number;
  certificateReloadFailuresTotal: number;
  handshakeFailuresTotal: number;
  invalidPeerIdentityFailuresTotal: number;
}

export interface LoadedCertificate {
  certPem: Buffer;
  keyPem: Buffer;
  caPem: Buffer;
  fingerprint256: string;
  serialNumber: string;
  spiffeIds: string[];
  validFrom: Date;
  validTo: Date;
  secureContext: tls.SecureContext;
}

export function mtlsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MtlsConfig {
  const enabled = env.VERINODE_MTLS_ENABLED === 'true' || env.VERINODE_MTLS_ENABLED === '1';
  return {
    enabled,
    certFile: env.VERINODE_MTLS_CERT_FILE,
    keyFile: env.VERINODE_MTLS_KEY_FILE,
    caFile: env.VERINODE_MTLS_CA_FILE,
    trustDomain: env.SPIFFE_TRUST_DOMAIN || 'cluster.local',
    allowedSpiffeIds: splitCsv(env.SPIFFE_ALLOWED_IDS),
    certMaxValidityMs: positiveInt(env.VERINODE_MTLS_CERT_MAX_VALIDITY_MS, DEFAULT_CERT_MAX_VALIDITY_MS),
    minSecondsUntilExpiry: positiveInt(env.VERINODE_MTLS_MIN_SECONDS_UNTIL_EXPIRY, DEFAULT_MIN_SECONDS_UNTIL_EXPIRY),
    reloadPollMs: positiveInt(env.VERINODE_MTLS_RELOAD_POLL_MS, DEFAULT_RELOAD_POLL_MS),
  };
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function hashInputs(parts: Buffer[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

export function extractSpiffeIds(cert: X509Certificate | tls.PeerCertificate | undefined): string[] {
  const subjectAltName = cert instanceof X509Certificate ? cert.subjectAltName : cert?.subjectaltname;
  if (!subjectAltName) return [];
  return subjectAltName
    .split(/,\s*/)
    .map((entry: string) => entry.trim())
    .filter((entry: string) => entry.startsWith('URI:spiffe://'))
    .map((entry: string) => entry.slice('URI:'.length));
}

export function validateSpiffeIdentity(
  spiffeIds: string[],
  trustDomain: string,
  allowedSpiffeIds: string[] = [],
): boolean {
  if (spiffeIds.length === 0) return false;
  const trustPrefix = `spiffe://${trustDomain}/`;
  return spiffeIds.some((id) => {
    if (!id.startsWith(trustPrefix)) return false;
    return allowedSpiffeIds.length === 0 || allowedSpiffeIds.includes(id);
  });
}

export function validatePeerCertificate(
  cert: tls.PeerCertificate | undefined,
  config: Pick<MtlsConfig, 'trustDomain' | 'allowedSpiffeIds'>,
): boolean {
  return validateSpiffeIdentity(extractSpiffeIds(cert), config.trustDomain, config.allowedSpiffeIds);
}

export class MtlsCertificateManager {
  private loaded: LoadedCertificate | null = null;
  private contentHash = '';
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reloadFailuresTotal = 0;
  private certificateReloadsTotal = 0;
  private handshakeFailuresTotal = 0;
  private invalidPeerIdentityFailuresTotal = 0;
  private log = createLogger('mtls', { 'tls.mode': 'mtls' });

  constructor(public readonly config: MtlsConfig) {
    if (config.enabled) this.assertConfigured();
  }

  get current(): LoadedCertificate | null {
    return this.loaded;
  }

  assertConfigured(): void {
    const missing = [
      ['VERINODE_MTLS_CERT_FILE', this.config.certFile],
      ['VERINODE_MTLS_KEY_FILE', this.config.keyFile],
      ['VERINODE_MTLS_CA_FILE', this.config.caFile],
    ].filter(([, value]) => !value);
    if (missing.length > 0) {
      throw new Error(`mTLS enabled but missing ${missing.map(([name]) => name).join(', ')}`);
    }
  }

  load(): LoadedCertificate {
    this.assertConfigured();
    const certPem = readFileSync(this.config.certFile!);
    const keyPem = readFileSync(this.config.keyFile!);
    const caPem = readFileSync(this.config.caFile!);
    const contentHash = hashInputs([certPem, keyPem, caPem]);
    if (this.loaded && contentHash === this.contentHash) return this.loaded;

    const cert = new X509Certificate(certPem);
    const validFrom = new Date(cert.validFrom);
    const validTo = new Date(cert.validTo);
    const validityMs = validTo.getTime() - validFrom.getTime();
    if (validityMs > this.config.certMaxValidityMs + 1_000) {
      throw new Error(`mTLS certificate validity exceeds 24-hour policy: ${Math.ceil(validityMs / 1000)}s`);
    }

    const spiffeIds = extractSpiffeIds(cert);
    if (!validateSpiffeIdentity(spiffeIds, this.config.trustDomain, this.config.allowedSpiffeIds)) {
      throw new Error(`mTLS certificate is missing an allowed SPIFFE identity for trust domain ${this.config.trustDomain}`);
    }

    const loaded: LoadedCertificate = {
      certPem,
      keyPem,
      caPem,
      fingerprint256: cert.fingerprint256,
      serialNumber: cert.serialNumber,
      spiffeIds,
      validFrom,
      validTo,
      secureContext: tls.createSecureContext({ cert: certPem, key: keyPem, ca: caPem }),
    };
    this.loaded = loaded;
    this.contentHash = contentHash;
    return loaded;
  }

  reloadIfChanged(): boolean {
    const before = this.contentHash;
    try {
      this.load();
      const changed = before !== this.contentHash;
      if (changed) this.certificateReloadsTotal += 1;
      return changed;
    } catch (err) {
      this.reloadFailuresTotal += 1;
      throw err;
    }
  }

  startRotationWatch(): void {
    if (!this.config.enabled || this.watcher || this.pollTimer) return;
    this.load();
    const onChange = (): void => {
      try {
        this.reloadIfChanged();
      } catch (err) {
        this.log.error('certificate reload failed', {
          'error.message': err instanceof Error ? err.message : String(err),
        });
      }
    };
    this.watcher = watch(this.config.certFile!, { persistent: false }, onChange);
    this.pollTimer = setInterval(onChange, this.config.reloadPollMs);
    this.pollTimer.unref?.();
  }

  stopRotationWatch(): void {
    this.watcher?.close();
    this.watcher = null;
    clearInterval(this.pollTimer ?? undefined);
    this.pollTimer = null;
  }

  serverOptions(): tls.TlsOptions {
    const loaded = this.load();
    return {
      cert: loaded.certPem,
      key: loaded.keyPem,
      ca: loaded.caPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      SNICallback: (_servername, cb) => cb(null, this.loaded?.secureContext ?? loaded.secureContext),
    };
  }

  recordHandshakeFailure(): void {
    this.handshakeFailuresTotal += 1;
  }

  recordInvalidPeerIdentity(): void {
    this.invalidPeerIdentityFailuresTotal += 1;
  }

  metricsSnapshot(now: Date = new Date()): MtlsMetricsSnapshot {
    const expiresAt = this.loaded?.validTo.getTime() ?? 0;
    const secondsUntilExpiry = expiresAt === 0 ? 0 : Math.max(0, Math.floor((expiresAt - now.getTime()) / 1000));
    return {
      certificateLoaded: this.loaded !== null,
      certificateExpiresAtUnix: expiresAt === 0 ? 0 : Math.floor(expiresAt / 1000),
      certificateSecondsUntilExpiry: secondsUntilExpiry,
      certificateReloadsTotal: this.certificateReloadsTotal,
      certificateReloadFailuresTotal: this.reloadFailuresTotal,
      handshakeFailuresTotal: this.handshakeFailuresTotal,
      invalidPeerIdentityFailuresTotal: this.invalidPeerIdentityFailuresTotal,
    };
  }

  prometheusMetrics(): string {
    const m = this.metricsSnapshot();
    const expiringSoon = m.certificateLoaded && m.certificateSecondsUntilExpiry < this.config.minSecondsUntilExpiry ? 1 : 0;
    return [
      '# HELP verinode_mtls_certificate_loaded Whether an mTLS workload certificate is loaded.',
      '# TYPE verinode_mtls_certificate_loaded gauge',
      `verinode_mtls_certificate_loaded ${m.certificateLoaded ? 1 : 0}`,
      '# HELP verinode_mtls_certificate_expires_at_unix_seconds Workload certificate expiry time.',
      '# TYPE verinode_mtls_certificate_expires_at_unix_seconds gauge',
      `verinode_mtls_certificate_expires_at_unix_seconds ${m.certificateExpiresAtUnix}`,
      '# HELP verinode_mtls_certificate_seconds_until_expiry Seconds until the loaded workload certificate expires.',
      '# TYPE verinode_mtls_certificate_seconds_until_expiry gauge',
      `verinode_mtls_certificate_seconds_until_expiry ${m.certificateSecondsUntilExpiry}`,
      '# HELP verinode_mtls_certificate_expiring_soon Certificate is inside the configured expiry warning window.',
      '# TYPE verinode_mtls_certificate_expiring_soon gauge',
      `verinode_mtls_certificate_expiring_soon ${expiringSoon}`,
      '# HELP verinode_mtls_certificate_reload_failures_total Certificate reload failures.',
      '# TYPE verinode_mtls_certificate_reload_failures_total counter',
      `verinode_mtls_certificate_reload_failures_total ${m.certificateReloadFailuresTotal}`,
      '# HELP verinode_mtls_handshake_failures_total TLS handshake failures observed by the service.',
      '# TYPE verinode_mtls_handshake_failures_total counter',
      `verinode_mtls_handshake_failures_total ${m.handshakeFailuresTotal}`,
      '# HELP verinode_mtls_invalid_peer_identity_failures_total Authorized TLS peers rejected for missing or disallowed SPIFFE identity.',
      '# TYPE verinode_mtls_invalid_peer_identity_failures_total counter',
      `verinode_mtls_invalid_peer_identity_failures_total ${m.invalidPeerIdentityFailuresTotal}`,
      '',
    ].join('\n');
  }

}

export function createMtlsManagerFromEnv(env: NodeJS.ProcessEnv = process.env): MtlsCertificateManager {
  return new MtlsCertificateManager(mtlsConfigFromEnv(env));
}
