# Database Backup Verification Runbook

## Overview
This runbook covers alerts raised by automated database backup and restore verification checks.

For full disaster recovery, Point-in-Time Recovery (PITR), and cross-region failover SOP, see the primary [Disaster Recovery Runbook](file:///home/ranjeet/VeriNode-Backend/docs/runbooks/disaster_recovery_runbook.md).

## Alert: DatabaseBackupRestoreVerificationFailed
- **Severity**: Critical
- **Description**: The automated backup restore verification runner detected a checksum mismatch, missing tables, query execution timeout, or schema disparity in the restored staging database.
- **Remediation**:
  1. Inspect the verification findings in PostgreSQL table `database_backup_verifications`:
     ```sql
     SELECT * FROM database_backup_verifications ORDER BY checked_at DESC LIMIT 5;
     ```
  2. Inspect the latest backup archive in S3 to verify file integrity and checksum.
  3. Re-trigger the staging restore test manually:
     ```bash
     npx tsx scripts/run_staging_restore_test.ts
     ```

## Alert: DatabaseBackupRestoreVerificationStale
- **Severity**: Critical
- **Description**: No successful restore verification has executed within the last 26 hours.
- **Remediation**:
  1. Check the status of the daily backup cron runner and pgBackRest worker.
  2. Ensure AWS IAM credentials and KMS decryption keys are unexpired.
  3. Verify S3 connectivity and network egress from the backup worker host.
