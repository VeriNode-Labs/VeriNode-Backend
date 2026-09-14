import Database from "better-sqlite3";
import { createHash } from "node:crypto";

const DEFAULT_MERIT_SCORE = 100;

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    onchain_id TEXT NOT NULL UNIQUE,
    creator TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    metadata_uri TEXT NOT NULL DEFAULT '',
    licensing_fee TEXT NOT NULL DEFAULT '0',
    registered_at INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS creators (
    address TEXT PRIMARY KEY,
    merit_score INTEGER NOT NULL DEFAULT ${DEFAULT_MERIT_SCORE},
    verified_skills TEXT NOT NULL DEFAULT '',
    total_escrows_completed INTEGER NOT NULL DEFAULT 0,
    completion_ratio REAL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS escrows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    onchain_id TEXT NOT NULL UNIQUE,
    client TEXT NOT NULL,
    creator TEXT NOT NULL,
    total_amount TEXT NOT NULL,
    remaining_balance TEXT NOT NULL,
    completed_milestones INTEGER NOT NULL DEFAULT 0,
    total_milestones INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'settled')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_assets_creator ON assets(creator);
  CREATE INDEX IF NOT EXISTS idx_escrows_creator ON escrows(creator);
  CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows(status);

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export class LuminaDb {
  constructor(dbPath = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.txApply = this.db.transaction((fn) => fn());
  }

  withTransaction(fn) {
    return this.txApply(fn);
  }

  close() {
    this.db.close();
  }

  upsertCreator({ address, verifiedSkills, meritDelta = 0, escrowIncrement = 0, completionRatio }) {
    const skills = verifiedSkills ?? "";
    if (completionRatio !== undefined) {
      this.db
        .prepare(
          `INSERT INTO creators (address, verified_skills, completion_ratio)
           VALUES (?, ?, ?)
           ON CONFLICT(address) DO UPDATE SET
             verified_skills = CASE
               WHEN excluded.verified_skills != '' AND (
                 creators.verified_skills = '' OR
                 instr(',' || creators.verified_skills || ',', ',' || excluded.verified_skills || ',') = 0
               )
               THEN CASE
                 WHEN creators.verified_skills = '' THEN excluded.verified_skills
                 ELSE creators.verified_skills || ',' || excluded.verified_skills
               END
               ELSE creators.verified_skills
             END,
             completion_ratio = excluded.completion_ratio,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .run(address, skills, completionRatio);
    } else {
      this.db
        .prepare(
          `INSERT INTO creators (address, verified_skills)
           VALUES (?, ?)
           ON CONFLICT(address) DO UPDATE SET
             verified_skills = CASE
               WHEN excluded.verified_skills != '' AND (
                 creators.verified_skills = '' OR
                 instr(',' || creators.verified_skills || ',', ',' || excluded.verified_skills || ',') = 0
               )
               THEN CASE
                 WHEN creators.verified_skills = '' THEN excluded.verified_skills
                 ELSE creators.verified_skills || ',' || excluded.verified_skills
               END
               ELSE creators.verified_skills
             END,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .run(address, skills);
    }
    this.db
      .prepare(
        `UPDATE creators
         SET merit_score = merit_score + ?,
             total_escrows_completed = total_escrows_completed + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE address = ?`,
      )
      .run(meritDelta, escrowIncrement, address);
  }

  getCreator(address) {
    return this.db.prepare(`SELECT * FROM creators WHERE address = ?`).get(address);
  }

  listCreators() {
    return this.db.prepare(`SELECT * FROM creators ORDER BY merit_score DESC`).all();
  }

  setCreatorVerifiedSkills(address, skills) {
    this.db
      .prepare(
        `UPDATE creators
         SET verified_skills = ?, updated_at = CURRENT_TIMESTAMP
         WHERE address = ?`,
      )
      .run(skills, address);
  }

  insertAsset({ onchain_id, creator, fingerprint, metadata_uri = "", licensing_fee = "0", registered_at }) {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO assets
           (onchain_id, creator, fingerprint, metadata_uri, licensing_fee, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(onchain_id, creator, fingerprint, metadata_uri, licensing_fee, registered_at);
    return info.changes > 0;
  }

  getAssets({ limit = 50, offset = 0 } = {}) {
    return this.db
      .prepare(`SELECT * FROM assets ORDER BY registered_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset);
  }

  getAssetByOnchainId(onchain_id) {
    return this.db.prepare(`SELECT * FROM assets WHERE onchain_id = ?`).get(onchain_id);
  }

  insertEscrow({ onchain_id, client, creator, total_amount, remaining_balance, completed_milestones = 0, total_milestones = 0, status = "active" }) {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO escrows
           (onchain_id, client, creator, total_amount, remaining_balance, completed_milestones, total_milestones, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(onchain_id, client, creator, String(total_amount), String(remaining_balance), completed_milestones, total_milestones, status);
    return info.changes > 0;
  }

  getEscrowByOnchainId(onchain_id) {
    return this.db.prepare(`SELECT * FROM escrows WHERE onchain_id = ?`).get(onchain_id);
  }

  updateEscrowPayout({ onchain_id, remaining_balance, completed_milestones, total_milestones, status }) {
    this.db
      .prepare(
        `UPDATE escrows
         SET remaining_balance = ?, completed_milestones = ?, total_milestones = ?, status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE onchain_id = ?`,
      )
      .run(String(remaining_balance), completed_milestones, total_milestones ?? 0, status, onchain_id);
  }

  listEscrows({ limit = 50, offset = 0 } = {}) {
    return this.db.prepare(`SELECT * FROM escrows ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }

  setSyncState(key, value) {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  }

  getSyncState(key) {
    const row = this.db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key);
    return row ? row.value : undefined;
  }
}

export function createDb(dbPath = ":memory:") {
  return new LuminaDb(dbPath);
}

export function blindIdFor(address) {
  return createHash("sha256").update(String(address)).digest("hex").slice(0, 16);
}