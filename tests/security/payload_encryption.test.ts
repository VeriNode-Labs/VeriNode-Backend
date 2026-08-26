import assert from 'assert';
import { randomBytes } from 'crypto';
import { isEncryptedEnvelope, PayloadEncryptionService, StaticKeyProvider } from '../../src/security/payload_encryption';

async function main(): Promise<void> {
  const service = new PayloadEncryptionService({
    keyProvider: new StaticKeyProvider({ keyId: 'k1', key: randomBytes(32) }),
    sensitiveFields: ['user.ssn', 'payment.cardNumber', 'members.secret'],
    aadContext: 'test-suite',
  });

  const payload = {
    user: { name: 'Ada', ssn: '123-45-6789' },
    payment: { cardNumber: '4111111111111111', amount: 42 },
    members: [{ secret: 'alpha' }, { secret: 'beta' }],
  };

  const encrypted = await service.encryptPayload(payload);
  assert.notStrictEqual(encrypted.user.ssn, payload.user.ssn);
  assert.ok(isEncryptedEnvelope(encrypted.user.ssn));
  assert.ok(isEncryptedEnvelope(encrypted.payment.cardNumber));
  assert.ok(isEncryptedEnvelope(encrypted.members[0].secret));
  assert.strictEqual(payload.user.ssn, '123-45-6789', 'source payload is immutable');

  const reencrypted = await service.encryptPayload(encrypted);
  assert.deepStrictEqual(reencrypted, encrypted, 'encrypted envelopes are not double-encrypted');

  const decrypted = await service.decryptPayload(encrypted);
  assert.deepStrictEqual(decrypted, payload);

  const tampered = await service.encryptPayload(payload);
  const ct = (tampered.user.ssn as any).ciphertext;
  // Flip the FIRST base64url character: it always carries 6 significant bits,
  // so the decoded bytes always change and the GCM tag check must fail.
  (tampered.user.ssn as any).ciphertext = (ct.startsWith('A') ? 'B' : 'A') + ct.slice(1);
  await assert.rejects(() => service.decryptPayload(tampered));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
