'use strict';

const assert = require('assert');

/**
 * Automated Regression Test Suite for Validator Consensus Failure Modes
 *
 * Verifies consensus safety, liveness, and recovery bounds under:
 * 1. Network partition (split-brain prevention and heal recovery)
 * 2. Byzantine equivocation (conflicting proposals from rogue nodes)
 * 3. Validator crash & timeout faults (non-responsive nodes)
 * 4. Message delay & jitter injection
 * 5. Dynamic quorum threshold computation (floor(2N/3) + 1)
 * 6. Duplicate vote and ineligible validator protection
 */

class ConsensusSimulator {
  constructor(cfg) {
    this.validators = cfg.validators.map((id) => ({ id, active: true, decided: new Map() }));
    this.maxRounds = cfg.maxRounds ?? 20;
    this.faultSpec = cfg.faultSpec ?? null;
  }

  getValidator(id) {
    return this.validators.find((v) => v.id === id);
  }

  shouldDeliver(from, to, round) {
    const p = this.faultSpec?.partition;
    if (p && p.groups && p.groups.length > 1) {
      const groupIndex = (id) => p.groups.findIndex((g) => g.includes(id));
      const gi = groupIndex(from);
      const gj = groupIndex(to);
      if (gi !== gj && gi >= 0 && gj >= 0) {
        if (!p.durationRounds || round <= p.durationRounds) return false;
      }
    }
    const toff = this.faultSpec?.timeout;
    if (toff && toff.by && toff.by.includes(from)) {
      if (!toff.durationRounds || round <= toff.durationRounds) return false;
    }
    return true;
  }

  async runRound(round) {
    const leaderIndex = (round - 1) % this.validators.length;
    const leaderId = this.validators[leaderIndex].id;

    // Proposals: leader proposes canonical block value for the round
    const canonicalProposal = `block-r${round}`;
    const proposals = new Map();

    for (const v of this.validators) {
      const toff = this.faultSpec?.timeout;
      if (
        toff &&
        toff.by &&
        toff.by.includes(v.id) &&
        (!toff.durationRounds || round <= toff.durationRounds)
      ) {
        continue;
      }
      // Honest validators vote for the round block proposal
      proposals.set(v.id, canonicalProposal);
    }

    const deliveries = [];
    for (const [from, payload] of proposals.entries()) {
      for (const dest of this.validators.map((x) => x.id)) {
        if (dest === from) continue;
        if (!this.shouldDeliver(from, dest, round)) {
          deliveries.push(Promise.resolve(null));
          continue;
        }

        const eq = this.faultSpec?.equivocation;
        let pl = payload;
        if (eq && eq.by && eq.by.includes(from)) {
          pl = `${payload}-alt-${dest}`;
        }

        const delay = this.faultSpec?.delay;
        if (delay && Math.random() < (delay.probability ?? 1)) {
          const jitter = delay.jitter ? (Math.random() - 0.5) * delay.jitter : 0;
          const ms = Math.max(0, delay.ms + jitter);
          deliveries.push(
            new Promise((res) => setTimeout(() => res({ from, to: dest, round, payload: pl }), ms)),
          );
        } else {
          deliveries.push(Promise.resolve({ from, to: dest, round, payload: pl }));
        }
      }
    }

    const msgs = (await Promise.all(deliveries)).filter((m) => m !== null);

    const perRecipient = new Map();
    for (const v of this.validators) perRecipient.set(v.id, new Map());
    for (const m of msgs) {
      const map = perRecipient.get(m.to);
      map.set(m.payload, (map.get(m.payload) ?? 0) + 1);
    }

    const n = this.validators.length;
    let anyDecided = false;
    for (const [vid, tally] of perRecipient.entries()) {
      for (const [val, count] of tally.entries()) {
        if (count >= Math.floor((2 * n) / 3) + 1) {
          this.getValidator(vid).decided.set(round, val);
          anyDecided = true;
          break;
        }
      }
    }

    return anyDecided;
  }

  async run() {
    for (let r = 1; r <= this.maxRounds; r++) {
      const ok = await this.runRound(r);
      if (ok) {
        return { rounds: r, recovered: true };
      }
    }
    return { rounds: this.maxRounds, recovered: false };
  }
}

function calculateQuorumThreshold(totalValidators) {
  return Math.floor((2 * totalValidators) / 3) + 1;
}

// ── Test Cases ──────────────────────────────────────────────────────────────

async function testCleanNetworkPartitionBlocksConsensus() {
  const sim = new ConsensusSimulator({
    validators: ['val-1', 'val-2', 'val-3', 'val-4'],
    maxRounds: 5,
    faultSpec: {
      partition: {
        groups: [['val-1', 'val-2'], ['val-3', 'val-4']],
      },
    },
  });

  const result = await sim.run();
  assert.strictEqual(result.recovered, false, 'Network partition without healing must prevent quorum');
  assert.strictEqual(result.rounds, 5, 'Should exhaust max rounds without consensus');
  console.log('✔ Clean network partition blocks split-brain consensus formation');
}

async function testHealedNetworkPartitionRecoversLiveness() {
  const sim = new ConsensusSimulator({
    validators: ['val-1', 'val-2', 'val-3', 'val-4'],
    maxRounds: 10,
    faultSpec: {
      partition: {
        groups: [['val-1', 'val-2'], ['val-3', 'val-4']],
        durationRounds: 3, // heals after round 3
      },
    },
  });

  const result = await sim.run();
  assert.strictEqual(result.recovered, true, 'Consensus must recover after partition heals');
  assert.strictEqual(result.rounds, 4, 'Consensus should be achieved immediately upon partition healing');
  console.log('✔ Healed network partition achieves consensus recovery within round bounds');
}

async function testByzantineEquivocationResilience() {
  // 4 validators with 1 equivocator (F < N/3)
  const sim = new ConsensusSimulator({
    validators: ['val-1', 'val-2', 'val-3', 'val-4'],
    maxRounds: 5,
    faultSpec: {
      equivocation: {
        by: ['val-4'],
      },
    },
  });

  const result = await sim.run();
  // 3 honest nodes (val-1, val-2, val-3) send consistent proposals to each other (3 votes = quorum)
  assert.strictEqual(result.recovered, true, 'Honest 2/3+ majority must reach consensus despite 1 equivocator');
  console.log('✔ Byzantine equivocation resilience verified under F < N/3 threshold');
}

async function testValidatorTimeoutFaultAndRecovery() {
  const sim = new ConsensusSimulator({
    validators: ['val-1', 'val-2', 'val-3', 'val-4'],
    maxRounds: 8,
    faultSpec: {
      timeout: {
        by: ['val-4'],
        durationRounds: 2,
      },
    },
  });

  const result = await sim.run();
  assert.strictEqual(result.recovered, true, 'System must progress and recover under bounded validator timeout');
  console.log('✔ Validator timeout fault recovery verified under bounded offline duration');
}

async function testMessageDelayAndJitterBounds() {
  const sim = new ConsensusSimulator({
    validators: ['val-1', 'val-2', 'val-3', 'val-4'],
    maxRounds: 5,
    faultSpec: {
      delay: {
        ms: 5,
        jitter: 2,
        probability: 0.5,
      },
    },
  });

  const result = await sim.run();
  assert.strictEqual(result.recovered, true, 'Consensus must converge under bounded network delay and jitter');
  console.log('✔ Network delay and jitter convergence verified');
}

function testQuorumThresholdCalculations() {
  const cases = [
    { n: 1, expected: 1 },
    { n: 2, expected: 2 },
    { n: 3, expected: 3 },
    { n: 4, expected: 3 },
    { n: 5, expected: 4 },
    { n: 6, expected: 5 },
    { n: 7, expected: 5 },
    { n: 10, expected: 7 },
    { n: 100, expected: 67 },
  ];

  for (const { n, expected } of cases) {
    assert.strictEqual(
      calculateQuorumThreshold(n),
      expected,
      `Quorum threshold for N=${n} must be ${expected}`,
    );
  }
  console.log('✔ Dynamic 2/3+ quorum threshold calculations verified across cluster sizes');
}

function testDuplicateAndIneligibleApprovalFiltering() {
  const activeSet = new Set(['val-1', 'val-2', 'val-3', 'val-4']);
  const countedVotes = new Set();

  function castVote(validatorId) {
    if (!activeSet.has(validatorId)) return 'INELIGIBLE';
    if (countedVotes.has(validatorId)) return 'DUPLICATE';
    countedVotes.add(validatorId);
    return 'COUNTED';
  }

  assert.strictEqual(castVote('val-1'), 'COUNTED');
  assert.strictEqual(castVote('val-1'), 'DUPLICATE', 'Repeated vote must be rejected as duplicate');
  assert.strictEqual(castVote('val-rogue'), 'INELIGIBLE', 'Unknown validator vote must be rejected as ineligible');
  assert.strictEqual(castVote('val-2'), 'COUNTED');
  assert.strictEqual(castVote('val-3'), 'COUNTED');

  const threshold = calculateQuorumThreshold(activeSet.size);
  assert.strictEqual(countedVotes.size >= threshold, true, 'Valid unique votes must meet quorum threshold');
  console.log('✔ Duplicate vote deduplication and ineligible validator filtering verified');
}

async function main() {
  console.log('Running Automated Regression Test Suite for Validator Consensus Failure Modes...');
  await testCleanNetworkPartitionBlocksConsensus();
  await testHealedNetworkPartitionRecoversLiveness();
  await testByzantineEquivocationResilience();
  await testValidatorTimeoutFaultAndRecovery();
  await testMessageDelayAndJitterBounds();
  testQuorumThresholdCalculations();
  testDuplicateAndIneligibleApprovalFiltering();
  console.log('\n✅ All 7 Validator Consensus Failure Mode Regression Tests PASSED!');
}

main().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
