import {
  generateProofOfPossession,
  verifyProofOfPossession,
  aggregateBLSSignatures,
  aggregateBLSPublicKeys,
  verifyEd25519Batch,
  verifyAggregate,
} from '../../../src/core/crypto/aggregate_sig';
import { loadEd25519, VerificationError } from '../../../src/core/crypto/signature';

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

  console.log('\nCrypto Aggregate Signature Tests\n');

  // ── generateProofOfPossession / verifyProofOfPossession round-trip ─
  {
    const ed = await loadEd25519();
    const secretKey = ed.ed25519.utils.randomSecretKey();
    const publicKey = ed.ed25519.getPublicKey(secretKey);

    const proof = await generateProofOfPossession(secretKey, publicKey);
    assert(proof instanceof Uint8Array, 'POP proof is a Uint8Array');
    assert(proof.length === 64, 'Ed25519 signature is 64 bytes');

    const valid = await verifyProofOfPossession(publicKey, proof);
    assert(valid === true, 'valid POP proof verifies');
  }

  // ── verifyProofOfPossession: invalid proof returns false ──────────
  {
    const ed = await loadEd25519();
    const sk = ed.ed25519.utils.randomSecretKey();
    const pk = ed.ed25519.getPublicKey(sk);
    const fakeProof = Buffer.alloc(64, 0x42);

    const valid = await verifyProofOfPossession(pk, fakeProof);
    assert(valid === false, 'invalid POP proof returns false');
  }

  // ── aggregateBLSSignatures: empty input throws ───────────────────
  {
    try {
      await aggregateBLSSignatures([]);
      assert(false, 'should throw on empty signatures');
    } catch (err) {
      assert(err instanceof VerificationError, 'empty sigs throws VerificationError');
      assert((err as VerificationError).message.includes('empty'), 'message mentions empty');
    }
  }

  // ── aggregateBLSPublicKeys: empty input throws ────────────────────
  {
    try {
      await aggregateBLSPublicKeys([]);
      assert(false, 'should throw on empty keys');
    } catch (err) {
      assert(err instanceof VerificationError, 'empty keys throws VerificationError');
      assert((err as VerificationError).message.includes('empty'), 'message mentions empty');
    }
  }

  // ── verifyEd25519Batch: mismatched lengths ────────────────────────
  {
    try {
      await verifyEd25519Batch([Buffer.from('a')], [Buffer.alloc(64)], []);
      assert(false, 'should throw on mismatched lengths');
    } catch (err) {
      assert(err instanceof VerificationError, 'mismatched batch lengths throws');
    }
  }

  // ── verifyEd25519Batch: empty input ───────────────────────────────
  {
    const result = await verifyEd25519Batch([], [], []);
    assert(result === true, 'empty batch returns true');
  }

  // ── verifyEd25519Batch: valid batch ───────────────────────────────
  {
    const ed = await loadEd25519();
    const sk = ed.ed25519.utils.randomSecretKey();
    const pk = ed.ed25519.getPublicKey(sk);
    const msg = Buffer.from('batch test');
    const sig = ed.ed25519.sign(msg, sk);

    const result = await verifyEd25519Batch([msg], [sig], [pk]);
    assert(result === true, 'valid batch verifies');
  }

  // ── verifyAggregate: unsupported curve ────────────────────────────
  {
    try {
      await verifyAggregate([Buffer.from('m')], [Buffer.alloc(64)], [Buffer.alloc(32)], 'UnknownCurve');
      assert(false, 'should throw on unsupported curve');
    } catch (err) {
      assert(err instanceof VerificationError, 'unsupported curve throws');
      assert((err as VerificationError).message.includes('UnknownCurve'), 'message contains curve name');
    }
  }

  // ── verifyAggregate: Ed25519 dispatch ──────────────────────────────
  {
    const ed = await loadEd25519();
    const sk = ed.ed25519.utils.randomSecretKey();
    const pk = ed.ed25519.getPublicKey(sk);
    const msg = Buffer.from('dispatch test');
    const sig = ed.ed25519.sign(msg, sk);

    const result = await verifyAggregate([msg], [sig], [pk], 'Ed25519');
    assert(result === true, 'verifyAggregate dispatches to Ed25519 batch');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('aggregate_sig.test.ts crashed:', err);
  process.exit(1);
});
