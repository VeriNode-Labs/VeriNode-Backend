import test from "node:test";
import assert from "node:assert/strict";
import { xdr } from "@stellar/stellar-sdk";

import { createDb } from "../src/db/schema.js";
import {
  applyEventBatch,
  decodeEvent,
  EVENT_TOPICS,
  MERIT_DELTAS,
  SYNC_CURSOR_KEY,
} from "../src/indexer/poller.js";

const s = (v) => xdr.ScVal.scvSymbol(v);
const u64 = (v) => xdr.ScVal.scvU64(BigInt(v));
const i128 = (v) =>
  xdr.ScVal.scvI128(
    new xdr.Int128Parts({ lo: xdr.Uint64.fromString(String(BigInt.asUintN(64, BigInt(v)))), hi: xdr.Int64.fromString("0") }),
  );
const bytes = (buf) => xdr.ScVal.scvBytes(buf);
const addrC = (byte) =>
  xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeContract(xdr.Hash.fromXDR(Buffer.alloc(32, byte))));
const vec = (...vals) => xdr.ScVal.scvVec(vals);

const makeEvent = (topic, value, extra = {}) => ({
  inSuccessfulContractCall: true,
  ledger: 500,
  ledgerClosedAt: "2026-01-01T00:00:00Z",
  txHash: "abc123",
  id: "42",
  ...extra,
  topic,
  value,
});

const ipAnchor = () =>
  makeEvent(
    [s(EVENT_TOPICS.IP_ANCHOR), addrC(1)],
    vec(u64(7), bytes(Buffer.alloc(32, 0xab)), u64(1_900_000_000)),
  );

const escrowNew = () =>
  makeEvent(
    [s(EVENT_TOPICS.ESCROW_NEW), addrC(2)],
    vec(u64(9), addrC(3), i128(5_000_000)),
  );

const payRel = (payout) =>
  makeEvent([s(EVENT_TOPICS.PAY_REL), u64(9)], vec(i128(payout), u64(1)));

test("decodeEvent maps ip_anchor topics and value", () => {
  const evt = ipAnchor();
  const decoded = decodeEvent(evt);
  assert.ok(decoded);
  assert.equal(decoded.topic, EVENT_TOPICS.IP_ANCHOR);
  assert.equal(decoded.payload.asset_id, "7");
  assert.match(decoded.payload.creator, /^C/);
  assert.match(decoded.payload.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(decoded.payload.registered_at, 1_900_000_000);
  assert.equal(decoded.ledger, 500);
});

test("decodeEvent maps escrow_new topics and value", () => {
  const decoded = decodeEvent(escrowNew());
  assert.equal(decoded.topic, EVENT_TOPICS.ESCROW_NEW);
  assert.equal(decoded.payload.onchain_id, "9");
  assert.match(decoded.payload.client, /^C/);
  assert.match(decoded.payload.creator, /^C/);
  assert.equal(decoded.payload.total_amount, "5000000");
});

test("decodeEvent maps pay_rel and ignores failed calls", () => {
  const decoded = decodeEvent(payRel(1_000_000));
  assert.equal(decoded.topic, EVENT_TOPICS.PAY_REL);
  assert.equal(decoded.payload.onchain_id, "9");
  assert.equal(decoded.payload.completed_milestones, 1);

  const failed = decodeEvent(makeEvent([s("pay_rel"), u64(9)], vec(i128(1), u64(0)), { inSuccessfulContractCall: false }));
  assert.equal(failed, null);
});

test("decodeEvent returns null for unknown topics", () => {
  const unknown = decodeEvent(makeEvent([s("something_else")], vec(u64(1))));
  assert.equal(unknown, null);
});

test("applyEventBatch ingests ip_anchor + escrow_new atomically", () => {
  const db = createDb(":memory:");
  const broadcasts = [];
  const applied = applyEventBatch(db, [decodeEvent(ipAnchor()), decodeEvent(escrowNew())], {
    broadcaster: (m) => broadcasts.push(m),
  });

  assert.equal(applied.length, 2);
  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[0].type, "asset.registered");
  assert.equal(broadcasts[1].type, "escrow.created");

  const assets = db.getAssets();
  assert.equal(assets.length, 1);
  assert.equal(assets[0].onchain_id, "7");
  assert.equal(assets[0].fingerprint, "ab".repeat(32));

  const escrow = db.getEscrowByOnchainId("9");
  assert.ok(escrow);
  assert.equal(escrow.total_amount, "5000000");
  assert.equal(escrow.remaining_balance, "5000000");
  assert.equal(escrow.status, "active");

  const creator = db.getCreator(assets[0].creator);
  assert.equal(creator.merit_score, 100 + MERIT_DELTAS.asset_registered);
  assert.equal(db.getCreator(escrow.creator).merit_score, 100 + MERIT_DELTAS.escrow_created);
});

test("applyEventBatch is idempotent per onchain id", () => {
  const db = createDb(":memory:");
  const first = applyEventBatch(db, [decodeEvent(ipAnchor())]);
  const replays = applyEventBatch(db, [decodeEvent(ipAnchor())]);
  assert.equal(first[0].applied, true);
  assert.equal(replays.length, 0);
  assert.equal(db.getAssets().length, 1);
});

test("pay_rel settles escrow and updates creator", () => {
  const db = createDb(":memory:");
  applyEventBatch(db, [decodeEvent(escrowNew())]);
  const creatorBefore = db.getCreator(String(decodeEvent(escrowNew()).payload.creator));

  const broadcasts = [];
  applyEventBatch(db, [decodeEvent(payRel(5_000_000))], { broadcaster: (m) => broadcasts.push(m) });

  const escrow = db.getEscrowByOnchainId("9");
  assert.equal(escrow.remaining_balance, "0");
  assert.equal(escrow.completed_milestones, 1);
  assert.equal(escrow.status, "settled");

  assert.equal(broadcasts[0].type, "escrow.payment");
  assert.equal(broadcasts[0].data.status, "settled");

  const creator = db.getCreator(creatorBefore.address);
  assert.equal(creator.total_escrows_completed, 1);
  assert.equal(creator.merit_score, creatorBefore.merit_score + MERIT_DELTAS.escrow_settled);
});

test("partial pay_rel does not settle and defers merit", () => {
  const db = createDb(":memory:");
  applyEventBatch(db, [decodeEvent(escrowNew())]);
  const creatorBefore = db.getCreator(String(decodeEvent(escrowNew()).payload.creator));

  applyEventBatch(db, [decodeEvent(payRel(2_000_000))]);
  const escrow = db.getEscrowByOnchainId("9");
  assert.equal(escrow.remaining_balance, "3000000");
  assert.equal(escrow.status, "active");
  assert.equal(db.getCreator(creatorBefore.address).total_escrows_completed, 0);
});

test("populated events are skipped, but others still apply in the same batch", () => {
  const db = createDb(":memory:");
  applyEventBatch(db, [decodeEvent(ipAnchor())]);
  const broadcasts = [];
  const applied = applyEventBatch(db, [decodeEvent(ipAnchor()), decodeEvent(escrowNew())], {
    broadcaster: (m) => broadcasts.push(m),
  });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].type, "escrow.created");
  assert.equal(broadcasts.length, 1);
});

test("sync state cursor survives apply flow", () => {
  const db = createDb(":memory:");
  db.setSyncState(SYNC_CURSOR_KEY, "500-7");
  assert.equal(db.getSyncState(SYNC_CURSOR_KEY), "500-7");
  db.setSyncState(SYNC_CURSOR_KEY, "501-3");
  assert.equal(db.getSyncState(SYNC_CURSOR_KEY), "501-3");
});