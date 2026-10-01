import nacl from "tweetnacl";
import { createHash } from "node:crypto";

const encoder = new TextEncoder();

/**
 * Decode a 32-byte key / 64-byte signature accepted as hex, base64, or bytes.
 */
function decodeField(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string") {
    throw new TypeError("expected hex, base64, or Uint8Array");
  }
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    const bytes = value.length / 2;
    if (bytes === 32 || bytes === 64) {
      const out = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i += 1) {
        out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
  }
  const b64 = Buffer.from(value, "base64");
  if (b64.length !== 64 && b64.length !== 32) {
    throw new TypeError("key/signature has invalid length");
  }
  return new Uint8Array(b64);
}

/**
 * Verify an Ed25519 detached signature over the payload. Payload may be a
 * string (the exact canonical message that was signed) or an object, in which
 * case it is canonicalized with JSON.stringify.
 */
export function verifyEdgeSignature(payload, signature, publicKey) {
  const msg =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const sig = decodeField(signature);
  const pub = decodeField(publicKey);
  return nacl.sign.detached.verify(encoder.encode(msg), sig, pub);
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

const MERKLE_LEAF = (payloadJson) => sha256Hex(payloadJson);

/**
 * Compute the Merkle root for every packet of a session, ordered by inbound id.
 * Odd levels are completed by duplicating the final node (standard Soroban
 * assembly convention); a single packet hashes to its own root.
 */
export function computeSessionMerkleRoot(sessionId, db) {
  const packets = db.getSessionPackets(sessionId);
  if (packets.length === 0) return null;

  let level = packets.map((p) => MERKLE_LEAF(p.payload_json));
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(level[i] + level[i + 1]));
    }
    level = next;
  }
  return level[0];
}