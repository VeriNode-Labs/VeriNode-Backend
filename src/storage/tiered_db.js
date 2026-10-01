import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ephemeral_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON ephemeral_telemetry (session_id, id);
CREATE INDEX IF NOT EXISTS idx_telemetry_node ON ephemeral_telemetry (node_id, created_at);

CREATE TABLE IF NOT EXISTS anchored_proofs (
  proof_hash TEXT PRIMARY KEY,
  session_id TEXT,
  node_id TEXT NOT NULL,
  ledger_tx_hash TEXT,
  anchored_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proofs_node ON anchored_proofs (node_id);

CREATE TABLE IF NOT EXISTS sync_cursor (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Tiered storage: ephemeral telemetry packets land in `ephemeral_telemetry`,
 * anchored proofs live in `anchored_proofs`, and the indexer's replay cursor
 * in `sync_cursor`.
 */
export class TieredDatabase {
  constructor(dbPath, { retentionHours = 24 } = {}) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.retentionHours = retentionHours;
  }

  /* ------------------------------ telemetry ------------------------------ */

  insertTelemetry({ sessionId, nodeId, payloadJson, checksum, createdAt = Date.now() }) {
    const info = this.db
      .prepare(
        `INSERT INTO ephemeral_telemetry (session_id, node_id, payload_json, checksum, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(sessionId, nodeId, payloadJson, checksum, createdAt);
    return Number(info.lastInsertRowid);
  }

  getSessionPackets(sessionId) {
    return this.db
      .prepare(
        `SELECT id, session_id, node_id, payload_json, checksum, created_at
         FROM ephemeral_telemetry
         WHERE session_id = ?
         ORDER BY id ASC`
      )
      .all(sessionId);
  }

  pruneExpiredTelemetry(hoursAgo = this.retentionHours) {
    const cutoff = Date.now() - hoursAgo * 3600 * 1000;
    const info = this.db.prepare("DELETE FROM ephemeral_telemetry WHERE created_at < ?").run(cutoff);
    return info.changes;
  }

  /* ------------------------------- proofs -------------------------------- */

  recordProof({ proofHash, sessionId, nodeId, ledgerTxHash, anchoredAt }) {
    this.db
      .prepare(
        `INSERT INTO anchored_proofs (proof_hash, session_id, node_id, ledger_tx_hash, anchored_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(proof_hash) DO UPDATE SET
           session_id = excluded.session_id,
           node_id = excluded.node_id,
           ledger_tx_hash = excluded.ledger_tx_hash,
           anchored_at = excluded.anchored_at`
      )
      .run(proofHash, sessionId ?? null, nodeId, ledgerTxHash ?? null, anchoredAt ?? null);
  }

  getAuditTrail(nodeId) {
    return this.db
      .prepare(
        `SELECT proof_hash, session_id, node_id, ledger_tx_hash, anchored_at
         FROM anchored_proofs
         WHERE node_id = ?
         ORDER BY anchored_at ASC`
      )
      .all(nodeId);
  }

  /* ----------------------------- cursor state ---------------------------- */

  getCursor(key) {
    const row = this.db.prepare("SELECT value FROM sync_cursor WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  setCursor(key, value) {
    this.db
      .prepare(
        `INSERT INTO sync_cursor (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, String(value));
  }

  close() {
    this.db.close();
  }
}