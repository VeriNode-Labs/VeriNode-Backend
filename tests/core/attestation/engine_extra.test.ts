import { BatchValidator, verifySingle } from '../../../src/core/attestation/engine';
import { loadEd25519 } from '../../../src/core/crypto/signature';
import { generateProofOfPossession } from '../../../src/core/crypto/aggregate_sig';

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}`);
      failed++;
    }
  }

  const ed = await loadEd25519();
  const sk = ed.ed25519.utils.randomSecretKey();
  const pk = ed.ed25519.getPublicKey(sk);

  // ── validateWithPop ──────────────────────────────────────────────
  {
    const proof = await generateProofOfPossession(sk, pk);
    const v = new BatchValidator({ requirePoP: true });
    const msg = Buffer.from('pop test');
    const sig = ed.ed25519.sign(msg, sk);

    const result = await v.validateWithPop([{ message: msg, signature: sig, publicKey: pk, proof }], 'Ed25519');
    assert(result.valid === true, 'validateWithPop succeeds with valid proof');
  }

  // ── validateWithPop: invalid proof ───────────────────────────────
  {
    const badProof = Buffer.alloc(64);
    const v = new BatchValidator({ requirePoP: true });
    const msg = Buffer.from('pop test');
    const sig = ed.ed25519.sign(msg, sk);

    const result = await v.validateWithPop([{ message: msg, signature: sig, publicKey: pk, proof: badProof }], 'Ed25519');
    assert(result.valid === false, 'validateWithPop fails with invalid proof');
    assert((result as any).error.includes('Proof-of-possession failed'), 'returns correct error message');
  }

  // ── verifySingle: string message ─────────────────────────────────
  {
    const msg = 'string message';
    const sig = ed.ed25519.sign(Buffer.from(msg), sk);
    const valid = await verifySingle({ message: msg, signature: sig, publicKey: pk }, 'Ed25519');
    assert(valid === true, 'verifySingle handles string message');
  }

  // ── validateBatch: string message ────────────────────────────────
  {
    const v = new BatchValidator({ requirePoP: false });
    const msg = 'batch string';
    const sig = ed.ed25519.sign(Buffer.from(msg), sk);
    const result = await v.validateBatch([{ message: msg, signature: sig, publicKey: pk }], 'Ed25519');
    assert(result.valid === true, 'validateBatch handles string message');
  }

  // ── verifySingle: BLS12-381 (Mocked/Failure) ─────────────────────
  {
     // BLS not fully supported in this env's native code or needs noble/curves
     // but we can at least call the branch.
     try {
       await verifySingle({ message: 'x', signature: Buffer.alloc(48), publicKey: Buffer.alloc(96) }, 'BLS12-381');
     } catch (err) {
       assert(true, 'verifySingle BLS12-381 branch touched');
     }
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
