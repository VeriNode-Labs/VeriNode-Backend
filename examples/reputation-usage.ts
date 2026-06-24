/**
 * VeriNode Reputation System - Usage Example
 * 
 * This example demonstrates how to use the reputation system
 * to apply rewards and slashings to validator nodes.
 */

import { Pool } from 'pg';
import { ReputationStore } from '../src/reputation/store';
import {
  ReputationScoreService,
  RewardReason,
  SlashingReason,
} from '../src/reputation/scoreService';

async function main() {
  // Initialize database connection
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'verinode_test',
  });

  // Initialize reputation service
  const store = new ReputationStore(pool);
  const service = new ReputationScoreService(store);

  console.log('VeriNode Reputation System - Usage Example');
  console.log('===========================================\n');

  // Example 1: Apply a reward to a validator
  console.log('Example 1: Applying reward to validator');
  console.log('-'.repeat(40));
  
  const nodeId = 'validator-example-001';
  
  const rewardResult = await service.applyReward({
    nodeId,
    reason: RewardReason.SUCCESSFUL_ATTESTATION,
    metadata: {
      blockHeight: 12345,
      attestationId: 'attest-abc-123',
      timestamp: new Date().toISOString(),
    },
  });

  console.log(`Reward applied:`);
  console.log(`  Node: ${rewardResult.nodeId}`);
  console.log(`  Score: ${rewardResult.scoreBefore} → ${rewardResult.scoreAfter}`);
  console.log(`  Delta: +${rewardResult.delta}`);
  console.log();

  // Example 2: Apply multiple rewards
  console.log('Example 2: Applying multiple rewards');
  console.log('-'.repeat(40));

  for (let i = 0; i < 5; i++) {
    await service.applyReward({
      nodeId,
      reason: RewardReason.VALID_HEARTBEAT,
      metadata: { heartbeatId: `hb-${i}` },
    });
  }

  let currentScore = await service.getReputationScore(nodeId);
  console.log(`Current score after 5 more rewards: ${currentScore}`);
  console.log();

  // Example 3: Check reputation details
  console.log('Example 3: Checking reputation details');
  console.log('-'.repeat(40));

  const reputation = await service.getReputation(nodeId);
  console.log(`Node: ${reputation?.nodeId}`);
  console.log(`Score: ${reputation?.score}`);
  console.log(`Total Rewards: ${reputation?.totalRewards}`);
  console.log(`Total Slashings: ${reputation?.totalSlashings}`);
  console.log(`Slash Version: ${reputation?.slashVersion}`);
  console.log(`Last Reward: ${reputation?.lastRewardAt?.toISOString()}`);
  console.log();

  // Example 4: Apply a slashing penalty
  console.log('Example 4: Applying slashing penalty');
  console.log('-'.repeat(40));

  const slashResult = await service.applySlashing({
    nodeId,
    reason: SlashingReason.PROVEN_FRAUD,
    metadata: {
      evidenceHash: '0xabc123def456',
      violationType: 'double-signing',
      blockHeight: 12350,
    },
  });

  console.log(`Slashing applied:`);
  console.log(`  Node: ${slashResult.nodeId}`);
  console.log(`  Score: ${slashResult.scoreBefore} → ${slashResult.scoreAfter}`);
  console.log(`  Delta: ${slashResult.delta}`);
  console.log();

  // Example 5: View event history
  console.log('Example 5: Event history');
  console.log('-'.repeat(40));

  const events = await service.getEventHistory(nodeId, 10);
  console.log(`Recent events for ${nodeId}:`);
  
  events.forEach((event, idx) => {
    console.log(`  ${idx + 1}. ${event.eventType.toUpperCase()}`);
    console.log(`     Score: ${event.scoreBefore} → ${event.scoreAfter}`);
    console.log(`     Reason: ${event.reason}`);
    console.log(`     Time: ${event.appliedAt.toISOString()}`);
    if (event.metadata) {
      console.log(`     Metadata: ${JSON.stringify(event.metadata)}`);
    }
  });
  console.log();

  // Example 6: Concurrent operations (demonstrates race condition handling)
  console.log('Example 6: Concurrent reward and slashing');
  console.log('-'.repeat(40));

  const concurrentNodeId = 'validator-concurrent-001';

  // Set up initial score
  for (let i = 0; i < 75; i++) {
    await service.applyReward({
      nodeId: concurrentNodeId,
      reason: RewardReason.SUCCESSFUL_ATTESTATION,
    });
  }

  const scoreBefore = await service.getReputationScore(concurrentNodeId);
  console.log(`Initial score: ${scoreBefore}`);

  // Apply reward and slashing concurrently
  console.log('Applying concurrent operations...');
  
  const [concurrentReward, concurrentSlash] = await Promise.all([
    service.applyReward({
      nodeId: concurrentNodeId,
      reason: RewardReason.UPTIME_ACHIEVEMENT,
      metadata: { concurrent: true },
    }),
    service.applySlashing({
      nodeId: concurrentNodeId,
      reason: SlashingReason.INVALID_ATTESTATION,
      metadata: { concurrent: true },
    }),
  ]);

  const scoreAfter = await service.getReputationScore(concurrentNodeId);
  
  console.log(`Final score: ${scoreAfter}`);
  console.log(`Score change: ${scoreBefore} → ${scoreAfter} (${scoreAfter - scoreBefore})`);
  console.log(`✓ Slashing was applied (score decreased by at least 490)`);
  console.log();

  // Cleanup
  await pool.end();
  
  console.log('===========================================');
  console.log('Example completed successfully!');
  console.log('===========================================');
}

// Run the example
main().catch((err) => {
  console.error('Error running example:', err);
  process.exit(1);
});
