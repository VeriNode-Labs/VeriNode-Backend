export type KeyState = 'PENDING' | 'ACTIVE' | 'RETIRED';

export const ERR_DUPLICATE_KEY = 'ERR_DUPLICATE_KEY' as const;

export interface KeyRecord {
  validatorId: string;
  publicKey: string;
  state: KeyState;
  registeredEpoch: number;
  activationEpoch?: number;
  activationSlot?: number;
  deactivationEpoch?: number;
  deactivationSlot?: number;
  retirementEpoch?: number;
  signingEnabled: boolean;
}

export interface RegisterActiveKeyInput {
  validatorId: string;
  publicKey: string;
  registeredEpoch: number;
  activationEpoch?: number;
  activationSlot?: number;
}

export interface ReservePendingKeyInput {
  validatorId: string;
  publicKey: string;
  registeredEpoch: number;
}

export interface ActivateKeyRotationInput {
  validatorId: string;
  oldPublicKey: string;
  newPublicKey: string;
  activationEpoch: number;
  activationSlot: number;
}

export class DuplicateKeyError extends Error {
  readonly code = ERR_DUPLICATE_KEY;

  constructor(publicKey: string) {
    super(`Public key is already registered: ${publicKey}`);
    this.name = 'DuplicateKeyError';
  }
}

export class KeyRegistryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'KeyRegistryError';
  }
}

function assertIdentifier(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new KeyRegistryError(`${field} must not be empty`, 'ERR_INVALID_KEY_RECORD');
  }
}

function assertProtocolNumber(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KeyRegistryError(`${field} must be a non-negative safe integer`, 'ERR_INVALID_KEY_RECORD');
  }
}

function copyKey(record: KeyRecord): KeyRecord {
  return { ...record };
}

/**
 * In-memory protocol registry. Mutations are deliberately synchronous: each
 * check-and-update sequence completes in one JavaScript turn and never spans
 * network or consensus work.
 */
export class KeyRegistry {
  private readonly keysByPublicKey = new Map<string, KeyRecord>();
  private readonly currentSigningKeyByValidator = new Map<string, string>();
  private readonly pendingKeyByValidator = new Map<string, string>();

  registerActiveKey(input: RegisterActiveKeyInput): KeyRecord {
    this.validateRegistration(input.validatorId, input.publicKey, input.registeredEpoch);
    const activationEpoch = input.activationEpoch ?? input.registeredEpoch;
    const activationSlot = input.activationSlot ?? 0;
    assertProtocolNumber(activationEpoch, 'activationEpoch');
    assertProtocolNumber(activationSlot, 'activationSlot');

    this.assertPublicKeyAvailable(input.publicKey);
    if (this.currentSigningKeyByValidator.has(input.validatorId)) {
      throw new KeyRegistryError(
        `Validator ${input.validatorId} already has an active signing key`,
        'ERR_ACTIVE_KEY_EXISTS',
      );
    }

    const record: KeyRecord = {
      validatorId: input.validatorId,
      publicKey: input.publicKey,
      state: 'ACTIVE',
      registeredEpoch: input.registeredEpoch,
      activationEpoch,
      activationSlot,
      signingEnabled: true,
    };
    this.keysByPublicKey.set(record.publicKey, record);
    this.currentSigningKeyByValidator.set(record.validatorId, record.publicKey);
    return copyKey(record);
  }

  reservePendingKey(input: ReservePendingKeyInput): KeyRecord {
    this.validateRegistration(input.validatorId, input.publicKey, input.registeredEpoch);
    this.assertPublicKeyAvailable(input.publicKey);
    if (this.pendingKeyByValidator.has(input.validatorId)) {
      throw new KeyRegistryError(
        `Validator ${input.validatorId} already has a pending key`,
        'ERR_PENDING_KEY_EXISTS',
      );
    }

    const record: KeyRecord = {
      validatorId: input.validatorId,
      publicKey: input.publicKey,
      state: 'PENDING',
      registeredEpoch: input.registeredEpoch,
      signingEnabled: false,
    };
    this.keysByPublicKey.set(record.publicKey, record);
    this.pendingKeyByValidator.set(record.validatorId, record.publicKey);
    return copyKey(record);
  }

  /** Removes only an unactivated reservation, for INITIATE rollback. */
  releasePendingKey(validatorId: string, publicKey: string): boolean {
    const record = this.keysByPublicKey.get(publicKey);
    if (
      !record
      || record.validatorId !== validatorId
      || record.state !== 'PENDING'
      || this.pendingKeyByValidator.get(validatorId) !== publicKey
    ) {
      return false;
    }
    this.keysByPublicKey.delete(publicKey);
    this.pendingKeyByValidator.delete(validatorId);
    return true;
  }

  activateRotation(input: ActivateKeyRotationInput): { oldKey: KeyRecord; newKey: KeyRecord } {
    const oldKey = this.keysByPublicKey.get(input.oldPublicKey);
    const newKey = this.keysByPublicKey.get(input.newPublicKey);
    assertProtocolNumber(input.activationEpoch, 'activationEpoch');
    assertProtocolNumber(input.activationSlot, 'activationSlot');

    if (
      oldKey?.validatorId === input.validatorId
      && newKey?.validatorId === input.validatorId
      && oldKey.state === 'ACTIVE'
      && !oldKey.signingEnabled
      && newKey.state === 'ACTIVE'
      && newKey.signingEnabled
      && this.currentSigningKeyByValidator.get(input.validatorId) === input.newPublicKey
    ) {
      if (
        oldKey.deactivationEpoch !== input.activationEpoch
        || oldKey.deactivationSlot !== input.activationSlot
        || newKey.activationEpoch !== input.activationEpoch
        || newKey.activationSlot !== input.activationSlot
      ) {
        throw new KeyRegistryError(
          'Rotation was already activated with different protocol coordinates',
          'ERR_ACTIVATION_CONFLICT',
        );
      }
      return { oldKey: copyKey(oldKey), newKey: copyKey(newKey) };
    }

    if (!oldKey || oldKey.validatorId !== input.validatorId || oldKey.state !== 'ACTIVE') {
      throw new KeyRegistryError('Rotation old key is not active for the validator', 'ERR_INVALID_OLD_KEY');
    }
    if (!oldKey.signingEnabled || this.currentSigningKeyByValidator.get(input.validatorId) !== input.oldPublicKey) {
      throw new KeyRegistryError('Rotation old key is not the current signing key', 'ERR_INVALID_OLD_KEY');
    }
    if (!newKey || newKey.validatorId !== input.validatorId || newKey.state !== 'PENDING') {
      throw new KeyRegistryError('Rotation new key is not pending for the validator', 'ERR_INVALID_NEW_KEY');
    }
    if (this.pendingKeyByValidator.get(input.validatorId) !== input.newPublicKey) {
      throw new KeyRegistryError('Rotation pending-key index is inconsistent', 'ERR_INVALID_NEW_KEY');
    }

    // All validation happens before either record is replaced, so consumers
    // cannot observe two unrestricted signing keys.
    const deactivatedOldKey: KeyRecord = {
      ...oldKey,
      signingEnabled: false,
      deactivationEpoch: input.activationEpoch,
      deactivationSlot: input.activationSlot,
    };
    const activatedNewKey: KeyRecord = {
      ...newKey,
      state: 'ACTIVE',
      signingEnabled: true,
      activationEpoch: input.activationEpoch,
      activationSlot: input.activationSlot,
    };

    this.keysByPublicKey.set(input.oldPublicKey, deactivatedOldKey);
    this.keysByPublicKey.set(input.newPublicKey, activatedNewKey);
    this.currentSigningKeyByValidator.set(input.validatorId, input.newPublicKey);
    this.pendingKeyByValidator.delete(input.validatorId);

    return { oldKey: copyKey(deactivatedOldKey), newKey: copyKey(activatedNewKey) };
  }

  retireKey(validatorId: string, publicKey: string, retirementEpoch: number): KeyRecord {
    assertProtocolNumber(retirementEpoch, 'retirementEpoch');
    const record = this.keysByPublicKey.get(publicKey);
    if (!record || record.validatorId !== validatorId) {
      throw new KeyRegistryError('Retirement key does not belong to the validator', 'ERR_UNKNOWN_KEY');
    }
    if (record.state === 'RETIRED') {
      return copyKey(record);
    }
    if (record.state !== 'ACTIVE' || record.signingEnabled || record.deactivationSlot === undefined) {
      throw new KeyRegistryError('Only a deactivated active key can be retired', 'ERR_KEY_NOT_DEACTIVATED');
    }

    const retired: KeyRecord = {
      ...record,
      state: 'RETIRED',
      signingEnabled: false,
      retirementEpoch,
    };
    this.keysByPublicKey.set(publicKey, retired);
    return copyKey(retired);
  }

  getKey(publicKey: string): KeyRecord | undefined {
    const record = this.keysByPublicKey.get(publicKey);
    return record ? copyKey(record) : undefined;
  }

  getCurrentSigningKey(validatorId: string): KeyRecord | undefined {
    const publicKey = this.currentSigningKeyByValidator.get(validatorId);
    return publicKey ? this.getKey(publicKey) : undefined;
  }

  getValidatorKeys(validatorId: string): KeyRecord[] {
    const records: KeyRecord[] = [];
    for (const record of this.keysByPublicKey.values()) {
      if (record.validatorId === validatorId) records.push(copyKey(record));
    }
    return records;
  }

  hasPublicKey(publicKey: string): boolean {
    return this.keysByPublicKey.has(publicKey);
  }

  get size(): number {
    return this.keysByPublicKey.size;
  }

  assertConsistent(): void {
    for (const [validatorId, publicKey] of this.currentSigningKeyByValidator) {
      const record = this.keysByPublicKey.get(publicKey);
      if (!record || record.validatorId !== validatorId || record.state !== 'ACTIVE' || !record.signingEnabled) {
        throw new KeyRegistryError('Current signing-key index is inconsistent', 'ERR_REGISTRY_INCONSISTENT');
      }
    }
    for (const [validatorId, publicKey] of this.pendingKeyByValidator) {
      const record = this.keysByPublicKey.get(publicKey);
      if (!record || record.validatorId !== validatorId || record.state !== 'PENDING') {
        throw new KeyRegistryError('Pending-key index is inconsistent', 'ERR_REGISTRY_INCONSISTENT');
      }
    }
  }

  private validateRegistration(validatorId: string, publicKey: string, registeredEpoch: number): void {
    assertIdentifier(validatorId, 'validatorId');
    assertIdentifier(publicKey, 'publicKey');
    assertProtocolNumber(registeredEpoch, 'registeredEpoch');
  }

  private assertPublicKeyAvailable(publicKey: string): void {
    // Direct indexing makes duplicate rejection deterministic and independent
    // of registry size, network latency, retries, or consensus.
    if (this.keysByPublicKey.has(publicKey)) throw new DuplicateKeyError(publicKey);
  }
}
