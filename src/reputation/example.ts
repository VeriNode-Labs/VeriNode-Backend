/**
 * Example Usage of Reputation Service
 *
 * This file demonstrates how to use the ReputationScoreService
 * to manage node reputation scores with race condition protection.
 */

import { Database } from '../config/database';
import { ReputationScoreService } from './scoreService';

async function main() {
  // Initialize database connection
  const db = new Database({
    host: 'localhost',
    port: 5432,
    user: 'verinode',
    password: 'your_password',
    database: 'verinode',
  });

  // Create reputation service
  const service = new ReputationScoreService(db);

  // Initialize schema (run once during application setup)
  await service.initializeSchema();

  console.log('=== Example 1: Basic Node Initialization ===');

  // Initialize a new node with default score (0)
  await service.initializeNode('node-alice');
  console.log('Node alice initialized');

  // Initialize a node with custom initial score
  await service.initializeNode('node-bob', 500);
  console.log('Node bob initialized with score 500');

  console.log('\n=== Example 2: Applying Rewards ===');

  // Apply reward (default +10)
  const reward1 = await service.applyReward('node-alice');
  console.log(`Reward applied to alice: ${reward1.previousScore} → ${reward1.newScore}`);

  // Apply custom reward amount
  const reward2 = await service.applyReward('node-bob', 50);
  console.log(`Custom reward applied to bob: ${reward2.previousScore} → ${reward2.newScore}`);

  console.log('\n=== Example 3: Applying Slashing ===');

  // Apply slashing penalty (default -500)
  const slash1 = await service.applySlashing('node-bob');
  console.log(`Slashing applied to bob: ${slash1.previousScore} → ${slash1.newScore}`);
  console.log(`Slash version: ${slash1.slashVersion}`);

  // Apply custom slashing amount
  const slash2 = await service.applySlashing('node-alice', 5);
  console.log(`Custom slashing applied to alice: ${slash2.previousScore} → ${slash2.newScore}`);

  console.log('\n=== Example 4: Querying Reputation ===');

  // Get current reputation score
  const aliceScore = await service.getReputationScore('node-alice');
  console.log('Alice reputation:', {
    nodeId: aliceScore?.nodeId,
    score: aliceScore?.score,
    slashVersion: aliceScore?.slashVersion,
    updatedAt: aliceScore?.updatedAt,
  });

  console.log('\n=== Example 5: Concurrent Operations (Race Condition Protected) ===');

  // Initialize a node for concurrent testing
  await service.initializeNode('node-charlie', 750);

  // Apply reward and slashing concurrently - NO RACE CONDITION!
  // Both operations will be applied atomically
  const [concurrentReward, concurrentSlash] = await Promise.all([
    service.applyReward('node-charlie', 10),
    service.applySlashing('node-charlie', 500),
  ]);

  console.log(
    `Concurrent reward: ${concurrentReward.previousScore} → ${concurrentReward.newScore}`,
  );
  console.log(
    `Concurrent slashing: ${concurrentSlash.previousScore} → ${concurrentSlash.newScore}`,
  );

  const charlieScore = await service.getReputationScore('node-charlie');
  console.log(`Final score for charlie: ${charlieScore?.score}`);
  console.log(`Expected: 750 + 10 - 500 = 260`);
  console.log(`Actual: ${charlieScore?.score} ✓`);

  console.log('\n=== Example 6: Transactional Operations ===');

  await service.initializeNode('node-dave', 600);

  // Use transactional methods when you need explicit transaction control
  const transReward = await service.applyRewardTransactional('node-dave', 100);
  console.log(`Transactional reward: ${transReward.previousScore} → ${transReward.newScore}`);

  const transSlash = await service.applySlashingTransactional('node-dave', 200);
  console.log(`Transactional slashing: ${transSlash.previousScore} → ${transSlash.newScore}`);

  console.log('\n=== Example 7: Multiple Nodes, Many Operations ===');

  // Initialize multiple nodes
  const nodeIds = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'];
  for (const nodeId of nodeIds) {
    await service.initializeNode(nodeId, 500);
  }

  // Apply operations to multiple nodes concurrently
  const operations = [];

  // Apply rewards to all nodes
  for (const nodeId of nodeIds) {
    operations.push(service.applyReward(nodeId, 20));
  }

  // Apply slashing to some nodes
  operations.push(service.applySlashing('node-2', 100));
  operations.push(service.applySlashing('node-4', 150));

  await Promise.all(operations);
  console.log('Applied operations to multiple nodes concurrently');

  // Query all nodes
  for (const nodeId of nodeIds) {
    const score = await service.getReputationScore(nodeId);
    console.log(`${nodeId}: score=${score?.score}, slashVersion=${score?.slashVersion}`);
  }

  console.log('\n=== Example 8: Error Handling ===');

  try {
    // Attempting to apply reward to non-existent node
    await service.applyReward('node-nonexistent');
  } catch (error) {
    console.log('Error caught (expected):', (error as Error).message);
  }

  console.log('\n=== Example 9: Score Bounds Enforcement ===');

  // Test upper bound
  await service.initializeNode('node-max', 995);
  await service.applyReward('node-max', 20);
  const maxScore = await service.getReputationScore('node-max');
  console.log(`Score capped at max: ${maxScore?.score} (max is 1000)`);

  // Test lower bound
  await service.initializeNode('node-min', -995);
  await service.applySlashing('node-min', 20);
  const minScore = await service.getReputationScore('node-min');
  console.log(`Score capped at min: ${minScore?.score} (min is -1000)`);

  console.log('\n=== Example 10: Monitoring Slash Events ===');

  // Track nodes with slashing events
  await service.initializeNode('node-monitor-1', 800);
  await service.initializeNode('node-monitor-2', 700);

  await service.applySlashing('node-monitor-1', 100);
  await service.applySlashing('node-monitor-1', 100); // Second slash
  await service.applySlashing('node-monitor-2', 200);

  const monitor1 = await service.getReputationScore('node-monitor-1');
  const monitor2 = await service.getReputationScore('node-monitor-2');

  console.log(`node-monitor-1: score=${monitor1?.score}, slashVersion=${monitor1?.slashVersion}`);
  console.log(`node-monitor-2: score=${monitor2?.score}, slashVersion=${monitor2?.slashVersion}`);

  // Close database connection
  await db.close();
  console.log('\n=== Examples Complete ===');
}

// Run examples
if (require.main === module) {
  main().catch((error) => {
    console.error('Example failed:', error);
    process.exit(1);
  });
}

export { main };
