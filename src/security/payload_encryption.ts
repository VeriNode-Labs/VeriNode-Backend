import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { performance } from 'perf_hooks';
import { metrics } from '@opentelemetry/api';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ENVELOPE_VERSION = 1;
const MARKER = '__verinode_e2ee';

export interface KeyProvider {
  getActiveKey(): Promise<PayloadEncryptionKey> | PayloadEncryptionKey;
  getKey(
    keyId: string,
  ): Promise<PayloadEncryptionKey | undefined> | PayloadEncryptionKey | undefined;
}

export interface PayloadEncryptionKey {
  keyId: string;
  key: Buffer | string;
}

export interface EncryptedFieldEnvelope {
  __verinode_e2ee: true;
  version: 1;
  alg: 'AES-256-GCM';
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface PayloadEncryptionOptions {
  keyProvider: KeyProvider;
  sensitiveFields: string[];
  aadContext?: string;
}

type JsonObject = Record<string, unknown>;

const meter = metrics.getMeter('payload_encryption', '1.0.0');
export const payloadEncryptionLatencyMs = meter.createHistogram(
  'payload_encryption.operation_latency_ms',
  {
    description: 'Latency for sensitive payload field encrypt/decrypt operations',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [1, 5, 10, 25, 50, 100] },
  },
);
export const payloadEncryptionFailuresTotal = meter.createCounter(
  'payload_encryption.failures_total',
  {
    description: 'Total payload encryption/decryption failures',
  },
);

export class StaticKeyProvider implements KeyProvider {
  constructor(
    private readonly activeKey: PayloadEncryptionKey,
    private readonly keys: PayloadEncryptionKey[] = [],
  ) {}
  getActiveKey(): PayloadEncryptionKey {
    return this.activeKey;
  }
  getKey(keyId: string): PayloadEncryptionKey | undefined {
    return [this.activeKey, ...this.keys].find((entry) => entry.keyId === keyId);
  }
}

export class PayloadEncryptionService {
  private readonly sensitivePaths: string[][];

  constructor(private readonly options: PayloadEncryptionOptions) {
    this.sensitivePaths = options.sensitiveFields.map(parsePath);
  }

  async encryptPayload<T>(payload: T): Promise<T> {
    return this.transform(payload, 'encrypt') as Promise<T>;
  }

  async decryptPayload<T>(payload: T): Promise<T> {
    return this.transform(payload, 'decrypt') as Promise<T>;
  }

  private async transform(payload: unknown, operation: 'encrypt' | 'decrypt'): Promise<unknown> {
    const start = performance.now();
    try {
      const cloned = clone(payload);
      for (const path of this.sensitivePaths) {
        await this.visitPath(cloned, path, operation);
      }
      payloadEncryptionLatencyMs.record(performance.now() - start, { operation });
      return cloned;
    } catch (error) {
      payloadEncryptionFailuresTotal.add(1, { operation });
      throw error;
    }
  }

  private async visitPath(
    node: unknown,
    path: string[],
    operation: 'encrypt' | 'decrypt',
  ): Promise<void> {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      await Promise.all(node.map((child) => this.visitPath(child, path, operation)));
      return;
    }
    if (!isObject(node)) return;
    const [head, ...rest] = path;
    if (!(head in node)) return;
    if (rest.length > 0) {
      await this.visitPath(node[head], rest, operation);
      return;
    }
    if (operation === 'encrypt') node[head] = await this.encryptValue(node[head], path.join('.'));
    else node[head] = await this.decryptValue(node[head], path.join('.'));
  }

  private async encryptValue(value: unknown, fieldPath: string): Promise<unknown> {
    if (value === undefined || isEncryptedEnvelope(value)) return value;
    const activeKey = await this.options.keyProvider.getActiveKey();
    const key = normalizeKey(activeKey.key);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(this.aad(activeKey.keyId, fieldPath));
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      [MARKER]: true,
      version: ENVELOPE_VERSION,
      alg: 'AES-256-GCM',
      keyId: activeKey.keyId,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    } satisfies EncryptedFieldEnvelope;
  }

  private async decryptValue(value: unknown, fieldPath: string): Promise<unknown> {
    if (!isEncryptedEnvelope(value)) return value;
    const encryptionKey = await this.options.keyProvider.getKey(value.keyId);
    if (!encryptionKey) throw new Error(`No payload encryption key found for keyId ${value.keyId}`);
    const decipher = createDecipheriv(
      ALGORITHM,
      normalizeKey(encryptionKey.key),
      Buffer.from(value.nonce, 'base64url'),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(this.aad(value.keyId, fieldPath));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  private aad(keyId: string, fieldPath: string): Buffer {
    return Buffer.from(`${this.options.aadContext ?? 'verinode'}:${fieldPath}:${keyId}`, 'utf8');
  }
}

function parsePath(path: string): string[] {
  const parts = path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('Sensitive field path cannot be empty');
  return parts;
}

function normalizeKey(key: Buffer | string): Buffer {
  const raw = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
  if (raw.length === KEY_BYTES) return raw;
  return createHash('sha256').update(raw).digest();
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedFieldEnvelope {
  if (!isObject(value)) return false;
  const marker = value[MARKER];
  if (typeof marker !== 'boolean') return false;
  return (
    timingSafeEqual(Buffer.from(marker ? '1' : '0'), Buffer.from('1')) &&
    value.version === ENVELOPE_VERSION &&
    value.alg === 'AES-256-GCM' &&
    typeof value.keyId === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.ciphertext === 'string' &&
    typeof value.tag === 'string'
  );
}
