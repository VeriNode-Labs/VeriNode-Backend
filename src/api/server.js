import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { computeSessionMerkleRoot, sha256Hex, verifyEdgeSignature } from "../verifier/crypto_gate.js";

/**
 * Build the HTTP + WS surface over a TieredDatabase. Exported separately from
 * the bootstrap path so tests can drive an in-memory instance.
 */
export function buildApp(db) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/stream/telemetry" });

  const broadcast = (payload) => {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  };

  app.post("/api/telemetry/ingest", (req, res) => {
    const { node_id: nodeId, session_id: sessionId, payload, signature, public_key: publicKey } = req.body ?? {};
    if (!nodeId || !sessionId || payload == null || !signature || !publicKey) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const canonical = typeof payload === "string" ? payload : JSON.stringify(payload);
    let valid;
    try {
      valid = verifyEdgeSignature(canonical, signature, publicKey);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_key_format" });
    }
    if (!valid) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    const checksum = sha256Hex(canonical);
    const id = db.insertTelemetry({
      sessionId,
      nodeId,
      payloadJson: canonical,
      checksum,
    });
    broadcast({ event: "ingest", node_id: nodeId, session_id: sessionId, checksum, id });
    return res.status(202).json({ ok: true, id, checksum });
  });

  app.post("/api/sessions/:id/seal", (req, res) => {
    const proofHash = computeSessionMerkleRoot(req.params.id, db);
    if (!proofHash) return res.status(404).json({ ok: false, error: "not_found" });
    const packets = db.getSessionPackets(req.params.id).length;
    return res.json({ ok: true, session_id: req.params.id, proof_hash: proofHash, packets });
  });

  app.get("/api/nodes/:id/audit", (req, res) => {
    return res.json({ ok: true, node_id: req.params.id, proofs: db.getAuditTrail(req.params.id) });
  });

  return { app, server, wss, broadcast };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { TieredDatabase } = await import("../storage/tiered_db.js");
  const db = new TieredDatabase(process.env.DB_PATH ?? "./data/verinode.db", {
    retentionHours: Number(process.env.RETENTION_HOURS ?? 24),
  });
  const { server } = buildApp(db);
  const port = Number(process.env.PORT ?? 4000);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`verinode data-engine listening on :${port}`);
  });
}