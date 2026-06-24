import { BatchValidator, verifySingle } from '../../../src/core/attestation/engine';
import { loadEd25519 } from '../../../src/core/crypto/signature';

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

  console.log('\nAttestation Engine Tests\n');

  // ── BatchValidator constructor defaults ──────────────────────────
  {
    const v = new BatchValidator();
    assert(v instanceof BatchValidator, 'constructs without arguments');
    assert(v['options'].maxBatchSize === 512, 'default maxBatchSize is 512');
    assert(v['options'].requirePoP === true, 'default requirePoP is true');
  }

  // ── BatchValidator constructor custom options ────────────────────
  {
    const v = new BatchValidator({ maxBatchSize: 100, requirePoP: false });
    assert(v['options'].maxBatchSize === 100, 'custom maxBatchSize');
    assert(v['options'].requirePoP === false, 'custom requirePoP false');
  }

  // ── validateBatch: empty batch ───────────────────────────────────
  {
    const v = new BatchValidator({ requirePoP: false });
    const result = await v.validateBatch([], 'Ed25519');
    assert(result.valid === true, 'empty batch is valid');
    assert(result.verified === 0, 'empty batch verified count 0');
    assert(result.failed === 0, 'empty batch failed count 0');
  }

  // ── validateBatch: single valid Ed25519 message ──────────────────
  {
    const ed = await loadEd25519();
    const sk = ed.ed25519.utils.randomSecretKey();
    const pk = ed.ed25519.getPublicKey(sk);
    const msg = Buffer.from('engine test');
    const sig = ed.ed25519.sign(msg, sk);

    const v = new BatchValidator({ requirePoP: false });
    const result = await v.validateBatch(
      [{ message: msg, signature: sig, publicKey: pk }],
      'Ed25519',
    );
    assert(result.valid === true, 'single valid message passes batch');
    assert(result.verified === 1, 'verified count is 1');
    assert(result.failed === 0, 'failed count is 0');
  }

  // ── validateBatch: batch larger than maxBatchSize partitions ─────
  {
    const ed = await loadEd25519();
    const items = [];
    for (let i = 0; i < 5; i++) {
      const sk = ed.ed25519.utils.randomSecretKey();
      const pk = ed.ed25519.getPublicKey(sk);
      const msg = Buffer.from(`partition-msg-${i}`);
      const sig = ed.ed25519.sign(msg, sk);
      items.push({ message: msg, signature: sig, publicKey: pk });
    }

    const v = new BatchValidator({ maxBatchSize: 2, requirePoP: false });
    const result = await v.validateBatch(items, 'Ed25519');
    assert(result.valid === true, 'partitioned batch is valid');
    assert(result.verified === 5, 'all 5 messages verified');
  }

  // ── partitionBatch: divides correctly ────────────────────────────
  {
    const v = new BatchValidator({ requirePoP: false });
    const items = [1, 2, 3, 4, 5, 6, 7];
    const partitions = v['partitionBatch'](items, 3);
    assert(partitions.length === 3, '3 partitions for 7 items with 3-way split');
    assert(partitions[0].length === 3, 'first partition chunk size 3');
    assert(partitions[1].length === 3, 'second partition chunk size 3');
    assert(partitions[2].length === 1, 'third partition has remainder 1');
    assert(partitions.flat().length === 7, 'all items distributed');
  }

  // ── partitionBatch: more partitions than items ────────────────────
  {
    const v = new BatchValidator({ requirePoP: false });
    const items = [1, 2, 3];
    const partitions = v['partitionBatch'](items, 10);
    assert(partitions.length === 3, '10 partitions for 3 items -> 3 partitions');
    assert(partitions.every(p => p.length === 1), 'each partition gets 1 item');
  }

  // ── verifySingle: Ed25519 valid ──────────────────────────────────
  {
    const ed = await loadEd25519();
    const sk = ed.ed25519.utils.randomSecretKey();
    const pk = ed.ed25519.getPublicKey(sk);
    const msg = Buffer.from('verify-single');
    const sig = ed.ed25519.sign(msg, sk);

    const valid = await verifySingle(
      { message: msg, signature: sig, publicKey: pk },
      'Ed25519',
    );
    assert(valid === true, 'verifySingle Ed25519 succeeds');
  }

  // ── verifySingle: unsupported curve throws ───────────────────────
  {
    try {
      await verifySingle(
        { message: Buffer.from('x'), signature: Buffer.alloc(64), publicKey: Buffer.alloc(32) },
        'BadCurve',
      );
      assert(false, 'should throw on unsupported curve');
    } catch (err) {
      assert((err as Error).message.includes('BadCurve'), 'unsupported curve error message');
    }
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('engine.test.ts crashed:', err);
  process.exit(1);
});
