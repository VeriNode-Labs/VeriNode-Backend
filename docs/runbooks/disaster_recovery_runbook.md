# Disaster Recovery & Point-in-Time Recovery (PITR) Runbook

## 1. Overview & Operational Objectives

This runbook defines standard operating procedures (SOP) for PostgreSQL database backup recovery, Point-in-Time Recovery (PITR), and cross-region disaster recovery for VeriNode-Backend.

| Parameter | Target Objective | Implementation Mechanism |
| :--- | :--- | :--- |
| **RTO (Recovery Time Objective)** | **< 1 hour (3600s)** | Automated pgBackRest parallel restore + staging warm standby |
| **RPO (Recovery Point Objective)** | **< 5 minutes (300s)** | Continuous WAL streaming with `archive_timeout = 300` to S3 |
| **Retention Window** | **30 days daily, 6m weekly, 2y monthly** | S3 Lifecycle policy with IA & Glacier Deep Archive tiering |
| **Encryption Standard** | **AES-256-CBC / AWS KMS** | Separate write (encrypt) vs restore (decrypt) IAM policies |

---

## 2. Incident Declaration & Roles

When database corruption, node failure, or catastrophic loss occurs:
1. **Incident Commander (IC)**: Declares SEV-1 incident, opens incident bridge, coordinates team.
2. **Database DR Lead**: Executes backup recovery, runs PITR validation, performs sanity checks.
3. **Communications Lead**: Updates stakeholders, publishes status page updates every 30 minutes.

---

## 3. Scenario A: Full Restore from Latest Backup

Use this procedure when the primary database cluster is destroyed or unrecoverable.

### Step 1: Assume Restore IAM Role
Restore instances must use the KMS decryption role:
```bash
aws sts assume-role \
  --role-arn arn:aws:iam::123456789012:role/verinode-dr-emergency-restore-role \
  --role-session-name verinode-dr-restore
```

### Step 2: Stop Target PostgreSQL Service & Clean Data Directory
```bash
sudo systemctl stop postgresql
sudo -u postgres rm -rf /var/lib/postgresql/data/*
sudo -u postgres chmod 700 /var/lib/postgresql/data
```

### Step 3: Execute pgBackRest Full Restore
Restore latest backup with 4 parallel threads:
```bash
sudo -u postgres pgbackrest \
  --stanza=verinode \
  --type=default \
  --process-max=4 \
  --log-level-console=info \
  restore
```

### Step 4: Start PostgreSQL & Verify Recovery
```bash
sudo systemctl start postgresql
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"
# Should return 'f' once restore replay completes and database is promoted.
```

---

## 4. Scenario B: Point-in-Time Recovery (PITR)

Use this procedure when recovering from accidental schema deletion, erroneous transaction, or data corruption at known timestamp `T`.

### Step 1: Identify Target Timestamp
Identify exact target timestamp in UTC prior to the corrupted transaction:
```text
Example Target: "2026-09-13 02:15:30+00"
```

### Step 2: Execute pgBackRest Time-Targeted Restore
```bash
sudo systemctl stop postgresql
sudo -u postgres rm -rf /var/lib/postgresql/data/*

sudo -u postgres pgbackrest \
  --stanza=verinode \
  --type=time \
  --target="2026-09-13 02:15:30+00" \
  --target-action=promote \
  --target-timeline=latest \
  --process-max=4 \
  --log-level-console=detail \
  restore
```

### Step 3: Verify Recovery Signal & Signal File
pgBackRest automatically creates `recovery.signal` and configures `postgresql.auto.conf` with:
```ini
restore_command = 'pgbackrest --stanza=verinode archive-get %f "%p"'
recovery_target_time = '2026-09-13 02:15:30+00'
recovery_target_action = 'promote'
recovery_target_timeline = 'latest'
```

### Step 4: Start Server & Monitor WAL Replay
```bash
sudo systemctl start postgresql
sudo tail -f /var/log/postgresql/postgresql.log | grep -E "restored log file|recovery stopping at"
```
Verify promotion message: `database system was not properly shut down; automatic recovery in progress`, followed by `recovery target reached` and `database system is ready to accept connections`.

---

## 5. Scenario C: Cross-Region Disaster Recovery Failover

If the entire primary AWS region (`us-east-1`) experiences an outage:

1. **Verify S3 Cross-Region Replication**:
   Confirm secondary bucket `verinode-backups-dr` in `us-west-2` has latest WAL and full backups replicated.
2. **Point pgBackRest to Secondary Bucket**:
   Update `deploy/backup/pgbackrest.conf`:
   ```ini
   repo1-s3-bucket=verinode-backups-dr
   repo1-s3-region=us-west-2
   repo1-s3-kms-key-id=arn:aws:kms:us-west-2:123456789012:key/verinode-backup-dr-key
   ```
3. **Spin Up Standby Database in DR Region**:
   Execute Scenario A restore on the DR compute instance.
4. **Traffic Cutover**:
   Update DNS / Application environment variable:
   ```bash
   DATABASE_URL=postgres://verinode_app:<PASSWORD>@db.dr.verinode.internal:5432/verinode
   ```
   Restart backend application containers and verify health checks.

---

## 6. Post-Restore Verification Health Checks

Run the automated health check suite against the restored database:
```bash
npx tsx -e "
  import { StagingRestoreTester } from './src/database/disaster_recovery';
  // Runs connectivity, schema checks, and table row assertions
"
```

Manual sanity check queries:
```sql
-- 1. Verify read connectivity
SELECT 1 AS ok;

-- 2. Verify schema migration status
SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 5;

-- 3. Verify core business tables
SELECT count(*) FROM node_status;
SELECT count(*) FROM reputations;

-- 4. Verify read-write capability
CREATE TEMP TABLE dr_smoke_test (id serial, created_at timestamptz DEFAULT now());
INSERT INTO dr_smoke_test DEFAULT VALUES;
DROP TABLE dr_smoke_test;
```

---

## 7. Metrics & Observability

Ensure the following Prometheus metrics return healthy statuses:
- `verinode_backup_age_seconds < 86400`
- `verinode_rpo_lag_seconds < 300`
- `verinode_rto_duration_seconds < 3600`
- `verinode_restore_test_failure_total == 0`
