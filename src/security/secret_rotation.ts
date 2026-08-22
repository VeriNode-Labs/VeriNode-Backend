import { createHash, randomBytes } from 'crypto';

export type SecretKind = 'database' | 'api_key';
export type RotationPhase =
  'idle' | 'preparing' | 'canary' | 'promoting' | 'complete' | 'failed' | 'rolled_back';

export interface SecretVersion {
  id: string;
  value: string;
  createdAt: Date;
  activatedAt?: Date;
  retiredAt?: Date;
  labels: Record<string, string>;
}

export interface SecretDescriptor {
  name: string;
  kind: SecretKind;
  currentVersionId: string;
  previousVersionId?: string;
  rotateAfter: Date;
  canaryPercent: number;
  phase: RotationPhase;
  lastRotatedAt?: Date;
  lastError?: string;
}

export interface SecretStore {
  getSecret(name: string): Promise<SecretDescriptor | undefined>;
  listSecrets(): Promise<SecretDescriptor[]>;
  putSecret(secret: SecretDescriptor): Promise<void>;
  getVersion(name: string, versionId: string): Promise<SecretVersion | undefined>;
  putVersion(name: string, version: SecretVersion): Promise<void>;
}

export interface SecretGenerator {
  generate(secret: SecretDescriptor): Promise<string> | string;
}

export interface RotationHooks {
  validate?(secret: SecretDescriptor, candidate: SecretVersion): Promise<void> | void;
  apply?(secret: SecretDescriptor, candidate: SecretVersion): Promise<void> | void;
  rollback?(secret: SecretDescriptor, previous: SecretVersion): Promise<void> | void;
}

export interface SecretRotationOptions {
  store: SecretStore;
  generator?: SecretGenerator;
  hooks?: RotationHooks;
  clock?: () => Date;
  canaryPercent?: number;
  rotationIntervalMs?: number;
  versionIdFactory?: () => string;
}

export interface RotationResult {
  name: string;
  phase: RotationPhase;
  oldVersionId: string;
  newVersionId?: string;
  durationMs: number;
  canaryPercent: number;
  error?: string;
}

export interface SecretRotationMetricsSnapshot {
  rotationsStarted: number;
  rotationsSucceeded: number;
  rotationsFailed: number;
  rollbacks: number;
  activeCanaries: number;
  lastDurationMs: number;
}

const DEFAULT_ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CANARY_PERCENT = 5;

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function assertValidName(name: string): void {
  if (!/^[a-zA-Z0-9_.:/-]{3,128}$/.test(name)) {
    throw new Error(
      'Secret name must be 3-128 chars and contain only letters, numbers, _, ., :, /, or -',
    );
  }
}

export class RandomSecretGenerator implements SecretGenerator {
  constructor(private readonly bytes = 32) {}

  generate(): string {
    return randomBytes(this.bytes).toString('base64url');
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, SecretDescriptor>();
  private readonly versions = new Map<string, Map<string, SecretVersion>>();

  async getSecret(name: string): Promise<SecretDescriptor | undefined> {
    const secret = this.secrets.get(name);
    return secret ? { ...secret } : undefined;
  }

  async listSecrets(): Promise<SecretDescriptor[]> {
    return Array.from(this.secrets.values()).map((secret) => ({ ...secret }));
  }

  async putSecret(secret: SecretDescriptor): Promise<void> {
    assertValidName(secret.name);
    this.secrets.set(secret.name, { ...secret });
  }

  async getVersion(name: string, versionId: string): Promise<SecretVersion | undefined> {
    const version = this.versions.get(name)?.get(versionId);
    return version ? { ...version, labels: { ...version.labels } } : undefined;
  }

  async putVersion(name: string, version: SecretVersion): Promise<void> {
    assertValidName(name);
    const scopedVersions = this.versions.get(name) ?? new Map<string, SecretVersion>();
    scopedVersions.set(version.id, { ...version, labels: { ...version.labels } });
    this.versions.set(name, scopedVersions);
  }
}

export class SecretRotationService {
  private readonly store: SecretStore;
  private readonly generator: SecretGenerator;
  private readonly hooks: RotationHooks;
  private readonly clock: () => Date;
  private readonly canaryPercent: number;
  private readonly rotationIntervalMs: number;
  private readonly versionIdFactory: () => string;
  private readonly metrics: SecretRotationMetricsSnapshot = {
    rotationsStarted: 0,
    rotationsSucceeded: 0,
    rotationsFailed: 0,
    rollbacks: 0,
    activeCanaries: 0,
    lastDurationMs: 0,
  };

  constructor(options: SecretRotationOptions) {
    this.store = options.store;
    this.generator = options.generator ?? new RandomSecretGenerator();
    this.hooks = options.hooks ?? {};
    this.clock = options.clock ?? (() => new Date());
    this.canaryPercent = options.canaryPercent ?? DEFAULT_CANARY_PERCENT;
    this.rotationIntervalMs = options.rotationIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS;
    this.versionIdFactory =
      options.versionIdFactory ?? (() => `v-${Date.now()}-${randomBytes(6).toString('hex')}`);
  }

  async registerSecret(
    name: string,
    kind: SecretKind,
    initialValue: string,
    rotateAfter?: Date,
  ): Promise<SecretDescriptor> {
    assertValidName(name);
    if (!initialValue) throw new Error('Initial secret value must not be empty');
    const now = this.clock();
    const version: SecretVersion = {
      id: this.versionIdFactory(),
      value: initialValue,
      createdAt: now,
      activatedAt: now,
      labels: { state: 'current', fingerprint: fingerprint(initialValue) },
    };
    const descriptor: SecretDescriptor = {
      name,
      kind,
      currentVersionId: version.id,
      rotateAfter: rotateAfter ?? new Date(now.getTime() + this.rotationIntervalMs),
      canaryPercent: 0,
      phase: 'idle',
      lastRotatedAt: now,
    };
    await this.store.putVersion(name, version);
    await this.store.putSecret(descriptor);
    return descriptor;
  }

  async dueForRotation(now: Date = this.clock()): Promise<SecretDescriptor[]> {
    return (await this.store.listSecrets()).filter(
      (secret) => secret.phase !== 'canary' && secret.rotateAfter <= now,
    );
  }

  async rotate(name: string): Promise<RotationResult> {
    const startedAt = this.clock().getTime();
    const secret = await this.requiredSecret(name);
    const oldVersion = await this.requiredVersion(secret.name, secret.currentVersionId);
    this.metrics.rotationsStarted++;

    try {
      await this.updatePhase(secret, 'preparing');
      const value = await this.generator.generate(secret);
      if (!value || value === oldVersion.value)
        throw new Error(
          'Generated secret must be non-empty and different from the current version',
        );

      const candidate: SecretVersion = {
        id: this.versionIdFactory(),
        value,
        createdAt: this.clock(),
        labels: { state: 'candidate', fingerprint: fingerprint(value) },
      };
      await this.store.putVersion(secret.name, candidate);
      await this.hooks.validate?.(secret, candidate);

      await this.updatePhase(secret, 'canary', candidate.id, this.canaryPercent);
      this.metrics.activeCanaries++;
      await this.hooks.apply?.(secret, candidate);

      await this.promote(secret.name, candidate.id);
      const durationMs = this.clock().getTime() - startedAt;
      this.metrics.rotationsSucceeded++;
      this.metrics.lastDurationMs = durationMs;
      return {
        name,
        phase: 'complete',
        oldVersionId: oldVersion.id,
        newVersionId: candidate.id,
        durationMs,
        canaryPercent: this.canaryPercent,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.rollback(secret.name, oldVersion.id, message);
      const durationMs = this.clock().getTime() - startedAt;
      this.metrics.rotationsFailed++;
      this.metrics.lastDurationMs = durationMs;
      return {
        name,
        phase: 'rolled_back',
        oldVersionId: oldVersion.id,
        durationMs,
        canaryPercent: 0,
        error: message,
      };
    }
  }

  async promote(name: string, candidateVersionId: string): Promise<void> {
    const secret = await this.requiredSecret(name);
    const previous = await this.requiredVersion(name, secret.currentVersionId);
    const candidate = await this.requiredVersion(name, candidateVersionId);
    const now = this.clock();

    previous.retiredAt = now;
    previous.labels = { ...previous.labels, state: 'previous' };
    candidate.activatedAt = now;
    candidate.labels = { ...candidate.labels, state: 'current' };

    await this.store.putVersion(name, previous);
    await this.store.putVersion(name, candidate);
    await this.store.putSecret({
      ...secret,
      currentVersionId: candidate.id,
      previousVersionId: previous.id,
      rotateAfter: new Date(now.getTime() + this.rotationIntervalMs),
      canaryPercent: 0,
      phase: 'complete',
      lastRotatedAt: now,
      lastError: undefined,
    });
    this.metrics.activeCanaries = Math.max(0, this.metrics.activeCanaries - 1);
  }

  async rollback(
    name: string,
    previousVersionId: string,
    reason = 'manual rollback',
  ): Promise<void> {
    const secret = await this.requiredSecret(name);
    const previous = await this.requiredVersion(name, previousVersionId);
    await this.hooks.rollback?.(secret, previous);
    previous.labels = { ...previous.labels, state: 'current' };
    await this.store.putVersion(name, previous);
    await this.store.putSecret({
      ...secret,
      currentVersionId: previous.id,
      canaryPercent: 0,
      phase: 'rolled_back',
      lastError: reason,
    });
    this.metrics.rollbacks++;
    this.metrics.activeCanaries = Math.max(0, this.metrics.activeCanaries - 1);
  }

  metricsSnapshot(): SecretRotationMetricsSnapshot {
    return { ...this.metrics };
  }

  renderPrometheus(): string {
    const m = this.metricsSnapshot();
    return [
      `secret_rotation_started_total ${m.rotationsStarted}`,
      `secret_rotation_success_total ${m.rotationsSucceeded}`,
      `secret_rotation_failure_total ${m.rotationsFailed}`,
      `secret_rotation_rollback_total ${m.rollbacks}`,
      `secret_rotation_active_canaries ${m.activeCanaries}`,
      `secret_rotation_last_duration_ms ${m.lastDurationMs}`,
    ].join('\n');
  }

  private async updatePhase(
    secret: SecretDescriptor,
    phase: RotationPhase,
    _candidateVersionId?: string,
    canaryPercent = 0,
  ): Promise<void> {
    await this.store.putSecret({
      ...secret,
      phase,
      previousVersionId: secret.previousVersionId,
      canaryPercent,
    });
  }

  private async requiredSecret(name: string): Promise<SecretDescriptor> {
    const secret = await this.store.getSecret(name);
    if (!secret) throw new Error(`Secret not found: ${name}`);
    return secret;
  }

  private async requiredVersion(name: string, versionId: string): Promise<SecretVersion> {
    const version = await this.store.getVersion(name, versionId);
    if (!version) throw new Error(`Secret version not found: ${name}@${versionId}`);
    return version;
  }
}

export function createSecretRotationService(options: SecretRotationOptions): SecretRotationService {
  return new SecretRotationService(options);
}
