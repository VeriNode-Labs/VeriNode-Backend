'use strict';

const crypto = require('node:crypto');
const { VerificationError, ProofOfPossessionError, verifyEd25519 } = require('./signature');

const POP_DOMAIN = Buffer.from('VERINODE_POP_V1');

async function loadBLS() {
  return import('@noble/curves/bls12-381.js');
}

async function loadEd25519Curve() {
  return import('@noble/curves/ed25519.js');
}

async function generateProofOfPossession(secretKey, publicKey) {
  const mod = await loadEd25519Curve();
  const message = Buffer.concat([POP_DOMAIN, publicKey]);
  return mod.ed25519.sign(message, secretKey);
}

async function verifyProofOfPossession(publicKey, proof) {
  const message = Buffer.concat([POP_DOMAIN, publicKey]);
  try {
    const mod = await loadEd25519Curve();
    return mod.ed25519.verify(proof, message, publicKey);
  } catch {
    return false;
  }
}

async function aggregateBLSSignatures(signatures) {
  if (signatures.length === 0) {
    throw new VerificationError('Cannot aggregate empty signature set');
  }

  const bls = await loadBLS();
  let aggregated = signatures[0];
  for (let i = 1; i < signatures.length; i++) {
    aggregated = bls.bls12_381.G1.add(aggregated, signatures[i]);
  }
  return aggregated;
}

async function aggregateBLSPublicKeys(publicKeys, proofs) {
  if (publicKeys.length === 0) {
    throw new VerificationError('Cannot aggregate empty public key set');
  }

  if (proofs) {
    for (let i = 0; i < publicKeys.length; i++) {
      const valid = await verifyProofOfPossession(publicKeys[i], proofs[i]);
      if (!valid) {
        throw new ProofOfPossessionError(
          `Proof-of-possession failed for public key at index ${i}`,
        );
      }
    }
  }

  const bls = await loadBLS();
  let aggregated = publicKeys[0];
  for (let i = 1; i < publicKeys.length; i++) {
    aggregated = bls.bls12_381.G1.add(aggregated, publicKeys[i]);
  }
  return aggregated;
}

async function verifyBLSAggregate(message, aggregatedSignature, aggregatedPublicKey) {
  const bls = await loadBLS();
  return bls.bls12_381.verifyShort(aggregatedSignature, aggregatedPublicKey, message);
}

async function verifyEd25519Batch(messages, signatures, publicKeys) {
  if (messages.length !== signatures.length || messages.length !== publicKeys.length) {
    throw new VerificationError('Mismatched input lengths');
  }
  if (messages.length === 0) return true;

  const mod = await loadEd25519Curve();
  const results = messages.map((msg, i) => {
    try {
      return mod.ed25519.verify(signatures[i], msg, publicKeys[i]);
    } catch {
      return false;
    }
  });

  return results.every(Boolean);
}

async function verifyAggregate(messages, signatures, publicKeys, curve = 'BLS12-381') {
  if (curve === 'BLS12-381') {
    const aggSig = await aggregateBLSSignatures(signatures);
    const aggPub = await aggregateBLSPublicKeys(publicKeys);
    return verifyBLSAggregate(messages[0], aggSig, aggPub);
  }

  if (curve === 'Ed25519') {
    return verifyEd25519Batch(messages, signatures, publicKeys);
  }

  throw new VerificationError(`Unsupported curve: ${curve}`);
}

module.exports = {
  generateProofOfPossession,
  verifyProofOfPossession,
  aggregateBLSSignatures,
  aggregateBLSPublicKeys,
  verifyBLSAggregate,
  verifyEd25519Batch,
  verifyAggregate,
};
