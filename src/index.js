import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { createDb } from "./db/schema.js";
import { createApp } from "./api/routes.js";
import { attachWebSocket } from "./api/websocket.js";
import { Poller } from "./indexer/poller.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "lumina.db");
const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.LUMINA_CONTRACT_ID;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 10_000;
const START_LEDGER = process.env.LUMINA_START_LEDGER ? Number(process.env.LUMINA_START_LEDGER) : undefined;

const db = createDb(DB_PATH);
const app = createApp(db);
const server = http.createServer(app);
const streams = attachWebSocket(server);

if (CONTRACT_ID) {
  const poller = new Poller({
    rpcUrl: RPC_URL,
    contractId: CONTRACT_ID,
    db,
    intervalMs: POLL_INTERVAL_MS,
    broadcaster: (outcome) => streams.broadcast(outcome),
    startLedger: START_LEDGER,
  });
  poller.start().catch(() => {});
}

server.listen(PORT, HOST, () => {
  console.log(`[lumina] api listening on http://${HOST}:${PORT}`);
  console.log(`[lumina] ws stream on /stream${CONTRACT_ID ? "" : " (indexer disabled: set LUMINA_CONTRACT_ID)"}`);
});

async function shutdown() {
  server.close(() => {
    streams.close();
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);