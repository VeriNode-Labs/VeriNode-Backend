/**
 * VeriNode Backend — Runtime Config Audit: HMAC Utility
 *
 * Provides tamper-evident HMAC-SHA-256 computation for AuditEntry records.
 * The secret is read once at startup from VERINODE_AUDIT_HMAC_SECRET (base64)
 * and must be at least 32 bytes when decoded.
 *
 * SECURITY: The raw secret value is NEVER logged, returned in API responses,
 * or recorded as a span attribute.
 */

import { createHmac } from 'crypto';
import type { AuditEntry } from './types';

/**
 * Load and validate the HMAC secret from the environment.
 * Throws at module import time if the variable is absent or too short,
 * giving a clear startup failure rather than a silent integrity bypass.
 */
export function loadHmacSecret(): Buffer {
  const raw = process.env.VERINODE_AUDIT_HMAC_SECRET;
  if (!raw) {
    throw new Error(
      '[ConfigAudit] VERINODE_AUDIT_HMAC_SECRET environment variable is required ' +
      'but was not set. Provide a base64-encoded value of at least 32 bytes.',
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length < 32) {
    throw new Error(
      `[ConfigAudit] VERINODE_AUDIT_HMAC_SECRET decoded to only ${decoded.length} byte(s). ` +
      'A minimum of 32 bytes is required.',
    );
  }
  return decoded;
}

/**
 * Compute HMAC-SHA-256 over the canonical pipe-delimited payload of an
 * AuditEntry and return the lowercase hex digest (64 characters).
 *
 * Canonical field order:
 *   entry_id | config_path | previous_value | new_value |
 *   actor | source_ip | changed_at | change_source
 *
 * - JSON values are stringified with no indentation.
 * - source_ip is the empty string when null.
 * - changed_at is the ISO-8601 string representation.
 */
export function computeHmac(entry: AuditEntry, secret: Buffer): string {
  const payload = [
    entry.entryId,
    entry.configPath,
    JSON.stringify(entry.previousValue ?? null),
    JSON.stringify(entry.newValue ?? null),
    entry.actor,
    entry.sourceIp ?? '',
    entry.changedAt.toISOString(),
    entry.changeSource,
  ].join('|');

  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}
