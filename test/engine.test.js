import { test, describe } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { xdr, StrKey } from "@stellar/stellar-sdk";

import { TieredDatabase } from "../src/storage/tiered_db.js";
import {
  computeSessionMerkleRoot,
  sha256Hex,
  verifyEdgeSignature,
} from "../src/verifier/crypto_gate.js";
import { syncOnce } from "../src/indexer/rpc_syncer.js";
import { buildApp } from "../src/api/server.js";

const toHex = (bytes) => Buffer.from(bytes).toString("hex");
const HOUR_MS = 3600 * 1000;

describe("tiered_db", () => {
  test("inserts telemetry and returns packets in inbound order", () => {
    const db = new TieredDatabase(":memory:");
    const a = db.insertTelemetry({ sessionId: "s1", nodeId: "n1", payloadJson: "A", checksum: "a" });
    const b = db.insertTelemetry({ sessionId: "s1", nodeId: "n1", payloadJson: "B", checksum: "b" });
    assert.ok(a < b);
    const packets = db.getSessionPackets("s1");
    assert.equal(packets.length, 2);
    assert.deepEqual(packets.map((p) => p.payload_json), ["A", "B"]);
    db.close();
  });

  test("prunes only expired telemetry", () => {
    const db = new TieredDatabase(":memory:");
    db.insertTelemetry({ sessionId: "s1", nodeId: "n1", payloadJson: "old", checksum: "o", createdAt: Date.now() - 48 * HOUR_MS });
    db.insertTelemetry({ sessionId: "s1", nodeId: "n1", payloadJson: "new", checksum: "n" });
    assert.equal(db.pruneExpiredTelemetry(24), 1);
    assert.equal(db.getSessionPackets("s1").length, 1);
    db.close();
  });

  test("recordProof upserts and getAuditTrail lists per node", () => {
    const db = new TieredDatabase(":memory:");
    db.recordProof({ proofHash: "h1", sessionId: "s1", nodeId: "n1", ledgerTxHash: "tx1", anchoredAt: 1 });
    db.recordProof({ proofHash: "h1", sessionId: "s1", nodeId: "n1", ledgerTxHash: "tx1b", anchoredAt: 2 });
    db.recordProof({ proofHash: "h2", nodeId: "n2", anchoredAt: 3 });
    const trail = db.getAuditTrail("n1");
    assert.equal(trail.length, 1);
    assert.equal(trail[0].ledger_tx_hash, "tx1b");
    assert.equal(db.getAuditTrail("n2").length, 1);
    db.close();
  });

  test("cursor round-trips", () => {
    const db = new TieredDatabase(":memory:");
    db.setCursor("k", 42);
    assert.equal(db.getCursor("k"), "42");
    db.close();
  });
});

describe("crypto_gate", () => {
  test("verifies an edge signature", () => {
    const kp = nacl.sign.keyPair();
    const payload = JSON.stringify({ t: 1, v: 2 });
    const sig = toHex(nacl.sign.detached(new TextEncoder().encode(payload), kp.secretKey));
    assert.equal(verifyEdgeSignature(payload, sig, toHex(kp.publicKey)), true);
    assert.equal(verifyEdgeSignature(payload, sig, toHex(kp.publicKey).slice(0, 62) + "00"), false);
  });

  test("rejects tampered payload or wrong key", () => {
    const kp = nacl.sign.keyPair();
    const payload = { t: 1 };
    const canonical = JSON.stringify(payload);
    const sig = toHex(nacl.sign.detached(new TextEncoder().encode(canonical), kp.secretKey));
    assert.equal(verifyEdgeSignature({ t: 2 }, sig, toHex(kp.publicKey)), false);
    const other = nacl.sign.keyPair();
    assert.equal(verifyEdgeSignature(canonical, sig, toHex(other.publicKey)), false);
  });

  test("merkle root is deterministic and changes as packets land", () => {
    const db = new TieredDatabase(":memory:");
    db.insertTelemetry({ sessionId: "s", nodeId: "n", payloadJson: "A", checksum: "a" });
    const r1 = computeSessionMerkleRoot("s", db);
    db.insertTelemetry({ sessionId: "s", nodeId: "n", payloadJson: "B", checksum: "b" });
    const r2 = computeSessionMerkleRoot("s", db);
    assert.equal(r1, sha256Hex("A"));
    assert.equal(r1.length, 64);
    assert.notEqual(r1, r2);
    assert.equal(computeSessionMerkleRoot("missing", db), null);
    db.close();
  });
});

describe("rpc_syncer", () => {
  test("ingests contract proof events and advances the cursor", async () => {
    const kp = nacl.sign.keyPair();
    const key = new xdr.Uint256Bytes(kp.publicKey);
    const accountId = xdr.AccountId.publicKeyTypeEd25519(key);
    const scAddress = xdr.ScAddress.scAddressTypeAccount(accountId);
    const proofBytes = new Uint8Array(32).fill(7);
    const value = xdr.ScVal.scvVec([xdr.ScVal.scvBytes(proofBytes), xdr.ScVal.scvU64(1700000000n)]);

    const event = {
      id: "0000000000-000000001",
      ledger: "12345",
      type: "contract",
      topic: [
        xdr.ScVal.scvSymbol("proof").toXDR("base64"),
        xdr.ScVal.scvAddress(scAddress).toXDR("base64"),
      ],
      value: value.toXDR("base64"),
      inSuccessfulContractCall: true,
    };

    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: { events: [event], latestLedger: 12345 } }),
    });

    const db = new TieredDatabase(":memory:");
    const out = await syncOnce(db, {
      rpcUrl: "https://rpc.example",
      contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      startLedger: 1,
      fetchImpl,
    });

    assert.equal(out.processed, 1);
    const nodeId = StrKey.encodeEd25519PublicKey(kp.publicKey);
    const trail = db.getAuditTrail(nodeId);
    assert.equal(trail.length, 1);
    assert.equal(trail[0].proof_hash, toHex(proofBytes));
    assert.equal(trail[0].anchored_at, 1700000000);
    assert.equal(trail[0].node_id, nodeId);
    assert.equal(db.getCursor("contract:CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:ledger"), "12346");
    db.close();
  });
});

describe("api", () => {
  test("ingest validates signatures, seals merkle proofs, and serves audits", async () => {
    const db = new TieredDatabase(":memory:");
    const { app, server } = buildApp(db);
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const kp = nacl.sign.keyPair();
    const payload = { metric: "cpu", value: 0.42 };
    const canonical = JSON.stringify(payload);
    const sig = toHex(nacl.sign.detached(new TextEncoder().encode(canonical), kp.secretKey));

    const ingest = async (overrides = {}) =>
      fetch(`${base}/api/telemetry/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: toHex(kp.publicKey),
          session_id: "sess-1",
          payload,
          signature: sig,
          public_key: toHex(kp.publicKey),
          ...overrides,
        }),
      });

    const ok = await ingest();
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).ok, true);

    const tampered = await ingest({ payload: { metric: "cpu", value: 0.99 } });
    assert.equal(tampered.status, 401);

    const missing = await ingest({ public_key: undefined });
    assert.equal(missing.status, 400);

    // two packets → a two-leaf merkle root
    const payload2 = { metric: "cpu", value: 0.5 };
    const canonical2 = JSON.stringify(payload2);
    const sig2 = toHex(nacl.sign.detached(new TextEncoder().encode(canonical2), kp.secretKey));
    await ingest({ payload: payload2, signature: sig2 });

    const seal = await fetch(`${base}/api/sessions/sess-1/seal`, { method: "POST" });
    assert.equal(seal.status, 200);
    const sealed = await seal.json();
    assert.equal(sealed.proof_hash, sha256Hex(sha256Hex(canonical) + sha256Hex(canonical2)));
    assert.equal(sealed.packets, 2);

    db.recordProof({ proofHash: sealed.proof_hash, sessionId: "sess-1", nodeId: toHex(kp.publicKey), anchoredAt: 999 });
    const audit = await (await fetch(`${base}/api/nodes/${toHex(kp.publicKey)}/audit`)).json();
    assert.deepEqual(audit.proofs.map((p) => p.proof_hash), [sealed.proof_hash]);

    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
});