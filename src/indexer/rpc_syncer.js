import { xdr, StrKey } from "@stellar/stellar-sdk";

const PROOF_TOPIC = "proof";
const DEFAULT_PAGE = 100;

function scvalSymbol(scval) {
  return scval?.sym ? scval.sym.toString() : null;
}

function addressToString(hashBytes) {
  const bytes = hashBytes.value ?? hashBytes;
  try {
    return StrKey.encodeEd25519PublicKey(bytes);
  } catch {
    return Buffer.from(bytes).toString("hex");
  }
}

function decodeAddress(scval) {
  const scAddress = scval?.address;
  if (!scAddress) return null;
  if (scAddress.accountId) {
    return addressToString(scAddress.accountId.ed25519);
  }
  if (scAddress.contractId) {
    return StrKey.encodeContract(scAddress.contractId.value ?? scAddress.contractId);
  }
  return null;
}

function decodeValue(scval) {
  const elements = scval?.vec;
  if (!elements || elements.length < 2) return null;
  const hv = elements[0].bytes;
  if (!hv) return null;
  const proofHash = Buffer.from(hv.value ?? hv).toString("hex");
  const anchoredAt = Number(elements[1].u64);
  return { proofHash, anchoredAt };
}

/**
 * Broadcast `proof` events feed a node_id, decrypt proof data and persist it
 * into the anchored tier. Cursor (`contract:<address>:ledger`) books a replay
 * position per contract.
 */
export async function syncOnce(db, { rpcUrl, contractId, startLedger: givenStart = null, limit = DEFAULT_PAGE, fetchImpl = fetch }) {
  const cursorKey = `contract:${contractId}:ledger`;
  const startLedger = givenStart ?? Number(db.getCursor(cursorKey) ?? 0);

  const topicFilter = [xdr.ScVal.scvSymbol(PROOF_TOPIC).toXDR("base64")];
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getEvents",
    params: {
      startLedger,
      filters: [{ type: "contract", contractIds: [contractId], topics: [topicFilter] }],
      pagination: { limit },
    },
  };

  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`soroban rpc error: ${res.status}`);

  const json = await res.json();
  const latestLedger = Number(json.result?.latestLedger ?? startLedger);
  let processed = 0;

  for (const event of json.result?.events ?? []) {
    if (event.inSuccessfulContractCall === false) continue;
    try {
      const topic = (event.topic ?? []).map((t) => xdr.ScVal.fromXDR(Buffer.from(t, "base64")));
      if (scvalSymbol(topic[0]) !== PROOF_TOPIC) continue;
      const nodeId = decodeAddress(topic[1]);
      const { proofHash, anchoredAt } = decodeValue(xdr.ScVal.fromXDR(Buffer.from(event.value, "base64"))) ?? {};
      if (!proofHash || !nodeId) continue;

      db.recordProof({
        proofHash,
        sessionId: null,
        nodeId,
        ledgerTxHash: event.id ?? null,
        anchoredAt: anchoredAt ?? (Date.parse(event.ledgerClosedAt ?? 0) || null),
      });
      processed += 1;
    } catch {
      /* skip malformed events and keep the cursor moving */
    }
  }

  db.setCursor(cursorKey, latestLedger + 1);
  return { processed, latestLedger };
}

export function buildIndexer({ rpcUrl, contractId, pollMs = 5000 }) {
  let timer = null;
  const start = () => {
    if (timer) return;
    timer = setInterval(() => {
      syncOnce({ rpcUrl, contractId }).catch(() => {});
    }, pollMs);
  };
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  return { start, stop };
}