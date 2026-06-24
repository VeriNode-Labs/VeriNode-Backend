import { NonceWindow } from '../../src/staking/slashing_sequencer';

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

  console.log('\nSlashing Sequencer Tests\n');

  // ── NonceWindow: claim returns nonces sequentially ────────────────
  {
    const nw = new NonceWindow(10);
    const n1 = nw.claim();
    assert(n1 !== null, 'first claim returns non-null');
    assert(n1 === 0n, 'first nonce is 0');

    const n2 = nw.claim();
    assert(n2 === 1n, 'second nonce is 1');
  }

  // ── NonceWindow: claim returns null when full ─────────────────────
  {
    const nw = new NonceWindow(3);
    assert(nw.claim() !== null, 'slot 0 claimed');
    assert(nw.claim() !== null, 'slot 1 claimed');
    assert(nw.claim() !== null, 'slot 2 claimed');
    assert(nw.claim() === null, 'full window returns null');
  }

  // ── NonceWindow: release frees a slot ────────────────────────────
  {
    const nw = new NonceWindow(3);
    const n1 = nw.claim()!;
    const n2 = nw.claim()!;
    const n3 = nw.claim()!;
    assert(n3 !== null, 'all three claimed');

    nw.release(n1);
    const n4 = nw.claim();
    assert(n4 !== null, 'claim succeeds after release');
  }

  // ── NonceWindow: release non-claimed nonce is a no-op ────────────
  {
    const nw = new NonceWindow(5);
    nw.claim(); // 0
    nw.release(999n); // not claimed, no-op
    const n = nw.claim();
    assert(n === 1n, 'release of unknown nonce is no-op');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('slashing_sequencer.test.ts crashed:', err);
  process.exit(1);
});
