# Quick Start Guide - Reputation System

## Prerequisites

- PostgreSQL 12+ installed and running
- Node.js 16+ with npm
- TypeScript knowledge
- Git configured

## 1. Fix PowerShell Execution Policy (Windows Only)

Open PowerShell as Administrator:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## 2. Setup Database

### Option A: Windows
```cmd
scripts\setup-reputation-db.bat
```

### Option B: Linux/Mac
```bash
chmod +x scripts/setup-reputation-db.sh
./scripts/setup-reputation-db.sh
```

### Option C: Manual
```bash
# Create database
createdb verinode_test

# Run migration
psql -d verinode_test < src/database/migrations/005_reputation_schema.sql
```

## 3. Install Dependencies (if needed)

```bash
npm install
```

## 4. Run Tests

```bash
npm run test:reputation
```

Expected output:
```
================================================================================
VeriNode Reputation Score Service Tests
================================================================================
Database: localhost:5432/verinode_test

1. Basic Operations
--------------------------------------------------------------------------------
✓ should start with score 0 for new node
✓ should apply single reward correctly
✓ should apply single slashing correctly

2. Race Condition Prevention (CRITICAL)
--------------------------------------------------------------------------------
✓ CRITICAL: concurrent reward and slashing - slash must always be applied
  Race result: 750 -> 250
✓ should serialize concurrent slashings (no write-skew)

3. Boundary Conditions
--------------------------------------------------------------------------------
✓ should not exceed maximum score (1000)
✓ should not go below minimum score (-1000)

4. Slashing Priority
--------------------------------------------------------------------------------
✓ should maintain slash_version monotonicity

================================================================================
Test Summary
================================================================================
Total:  8
Passed: 8 ✓
Failed: 0 ✗

All tests passed! ✓
```

## 5. Run Example

```bash
npx ts-node examples/reputation-usage.ts
```

This will demonstrate:
- Applying rewards
- Applying slashings
- Checking reputation
- Viewing event history
- Concurrent operations

## 6. Integrate Into Your Code

```typescript
import { Pool } from 'pg';
import { ReputationStore } from './src/reputation/store';
import { ReputationScoreService, RewardReason, SlashingReason } from './src/reputation/scoreService';

// Setup
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'verinode',
});

const store = new ReputationStore(pool);
const service = new ReputationScoreService(store);

// Apply reward
await service.applyReward({
  nodeId: 'validator-001',
  reason: RewardReason.SUCCESSFUL_ATTESTATION,
  metadata: { blockHeight: 12345 }
});

// Apply slashing
await service.applySlashing({
  nodeId: 'validator-002',
  reason: SlashingReason.PROVEN_FRAUD,
  metadata: { evidenceHash: '0xabc123' }
});

// Check score
const score = await service.getReputationScore('validator-001');
console.log(`Score: ${score}`);
```

## 7. Verify Everything Works

Run all tests:
```bash
npm test
```

## Troubleshooting

### "Cannot load scripts" error
Run as Administrator:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Database connection error
Check PostgreSQL is running:
```bash
pg_isready
```

Set environment variables:
```bash
export TEST_DB_HOST=localhost
export TEST_DB_PORT=5432
export TEST_DB_USER=postgres
export TEST_DB_PASSWORD=postgres
export TEST_DB_NAME=verinode_test
```

### Tables not created
Run migration manually:
```bash
psql -d verinode_test < src/database/migrations/005_reputation_schema.sql
```

## Configuration

Edit these constants in `src/reputation/scoreService.ts`:

```typescript
export const REPUTATION_CONFIG = {
  REWARD_DELTA: 10,        // Points per reward
  SLASHING_DELTA: -500,    // Points per slashing
  MIN_SCORE: -1000,        // Minimum allowed score
  MAX_SCORE: 1000,         // Maximum allowed score
};
```

## Documentation

- **System Overview:** `src/reputation/README.md`
- **Implementation Details:** `RACE_CONDITION_FIX_SUMMARY.md`
- **Full Checklist:** `IMPLEMENTATION_CHECKLIST.md`

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review the documentation files
3. Check the test output for specific errors
4. Review the example code in `examples/reputation-usage.ts`

## Success!

If all tests pass, you've successfully implemented the race-condition-free reputation system! 🎉

The system now guarantees that:
- ✅ Slashing events are NEVER lost
- ✅ Concurrent operations are handled correctly
- ✅ Score constraints are enforced
- ✅ All events are logged for audit

## Next Steps

1. Review the code in `src/reputation/`
2. Run the example: `npx ts-node examples/reputation-usage.ts`
3. Integrate into your application
4. Monitor `reputation_events` table for activity
5. Set up alerts for unusual `slash_version` changes

Happy coding! 🚀
