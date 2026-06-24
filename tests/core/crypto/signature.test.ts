import {
  VerificationError,
  PublicKeyValidationError,
  SignatureValidationError,
  ProofOfPossessionError,
  verifyEd25519,
  verifyBatchEd25519,
  loadEd25519,
} from '../../../src/core/crypto/signature';

async function getEd25519() {
  return loadEd25519();
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  \u2713 ${name}`);
      passed++;
    } else {
      console.log(`  \u2717 ${name}`);
      failed++;
    }
  }

  console.log('\nCrypto Signature Tests\n');

  // ── Error class constructors and inheritance ──────────────────────
  {
    const ve = new VerificationError('bad verify');
    assert(ve instanceof Error, 'VerificationError extends Error');
    assert(ve.name === 'VerificationError', 'VerificationError.name');
    assert(ve.message === 'bad verify', 'VerificationError.message');
    assert(ve.code === 'VERIFICATION_FAILED', 'VerificationError default code');

    const pkv = new PublicKeyValidationError('bad key');
    assert(pkv instanceof VerificationError, 'PublicKeyValidationError extends VerificationError');
    assert(pkv.name === 'PublicKeyValidationError', 'PublicKeyValidationError.name');
    assert(pkv.code === 'INVALID_PUBLIC_KEY', 'PublicKeyValidationError code');

    const sv = new SignatureValidationError('bad sig');
    assert(sv instanceof VerificationError, 'SignatureValidationError extends VerificationError');
    assert(sv.name === 'SignatureValidationError', 'SignatureValidationError.name');
    assert(sv.code === 'INVALID_SIGNATURE', 'SignatureValidationError code');

    const pop = new ProofOfPossessionError('bad pop');
    assert(pop instanceof VerificationError, 'ProofOfPossessionError extends VerificationError');
    assert(pop.name === 'ProofOfPossessionError', 'ProofOfPossessionError.name');
    assert(pop.code === 'POP_FAILED', 'ProofOfPossessionError code');
  }

  // ── verifyEd25519: invalid signature length ───────────────────────
  {
    try {
      await verifyEd25519(Buffer.from('msg'), Buffer.alloc(32), Buffer.alloc(32));
      assert(false, 'should throw on bad sig length');
    } catch (err) {
      assert(err instanceof SignatureValidationError, 'bad sig length throws SignatureValidationError');
      assert((err as SignatureValidationError).message.includes('64'), 'message mentions 64 bytes');
    }
  }

  // ── verifyEd25519: invalid public key length ──────────────────────
  {
    try {
      await verifyEd25519(Buffer.from('msg'), Buffer.alloc(64), Buffer.alloc(16));
      assert(false, 'should throw on bad key length');
    } catch (err) {
      assert(err instanceof PublicKeyValidationError, 'bad key length throws PublicKeyValidationError');
      assert((err as PublicKeyValidationError).message.includes('32'), 'message mentions 32 bytes');
    }
  }

  // ── verifyEd25519: valid round-trip ───────────────────────────────
  {
    const ed = await getEd25519();
    const secretKey = ed.ed25519.utils.randomSecretKey();
    const publicKey = ed.ed25519.getPublicKey(secretKey);
    const message = Buffer.from('hello world');
    const signature = ed.ed25519.sign(message, secretKey);

    const valid = await verifyEd25519(message, signature, publicKey);
    assert(valid === true, 'valid Ed25519 signature verifies');
  }

  // ── verifyEd25519: wrong key fails ────────────────────────────────
  {
    const ed = await getEd25519();
    const sk1 = ed.ed25519.utils.randomSecretKey();
    const pk1 = ed.ed25519.getPublicKey(sk1);
    const sk2 = ed.ed25519.utils.randomSecretKey();
    const pk2 = ed.ed25519.getPublicKey(sk2);
    const message = Buffer.from('hello');
    const signature = ed.ed25519.sign(message, sk1);

    const valid = await verifyEd25519(message, signature, pk2);
    assert(valid === false, 'wrong public key fails verification');
  }

  // ── verifyBatchEd25519: mismatched lengths ────────────────────────
  {
    try {
      await verifyBatchEd25519([Buffer.from('a')], [Buffer.alloc(64)], []);
      assert(false, 'should throw on mismatched lengths');
    } catch (err) {
      assert(err instanceof VerificationError, 'mismatched lengths throws VerificationError');
    }
  }

  // ── verifyBatchEd25519: empty input ───────────────────────────────
  {
    const result = await verifyBatchEd25519([], [], []);
    assert(result === true, 'empty batch returns true');
  }

  // ── verifyBatchEd25519: one valid signature ───────────────────────
  {
    const ed = await getEd25519();
    const sk = ed.ed25519.utils.randomSecretKey();
    const pk = ed.ed25519.getPublicKey(sk);
    const msg = Buffer.from('batch test');
    const sig = ed.ed25519.sign(msg, sk);

    const result = await verifyBatchEd25519([msg], [sig], [pk]);
    assert(result === true, 'single valid message passes batch');
  }

  // ── verifyBatchEd25519: one invalid among valid ───────────────────
  {
    const ed = await getEd25519();
    const sk = ed.ed25519.utils.randomSecretKey();
    const pk = ed.ed25519.getPublicKey(sk);
    const msg = Buffer.from('test');
    const sig = ed.ed25519.sign(msg, sk);

    const wrongSig = Buffer.alloc(64);
    wrongSig[0] = 0xFF;

    const result = await verifyBatchEd25519(
      [msg, msg],
      [sig, wrongSig],
      [pk, pk],
    );
    assert(result === false, 'one invalid signature causes batch to fail');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('signature.test.ts crashed:', err);
  process.exit(1);
});
