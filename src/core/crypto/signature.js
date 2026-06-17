'use strict';

class VerificationError extends Error {
  constructor(message, code = 'VERIFICATION_FAILED') {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
  }
}

class PublicKeyValidationError extends VerificationError {
  constructor(message) {
    super(message, 'INVALID_PUBLIC_KEY');
    this.name = 'PublicKeyValidationError';
  }
}

class SignatureValidationError extends VerificationError {
  constructor(message) {
    super(message, 'INVALID_SIGNATURE');
    this.name = 'SignatureValidationError';
  }
}

class ProofOfPossessionError extends VerificationError {
  constructor(message) {
    super(message, 'POP_FAILED');
    this.name = 'ProofOfPossessionError';
  }
}

async function loadEd25519() {
  return import('@noble/curves/ed25519.js');
}

async function verifyEd25519(message, signature, publicKey) {
  if (signature.length !== 64) {
    throw new SignatureValidationError('Invalid signature length: expected 64 bytes');
  }
  if (publicKey.length !== 32) {
    throw new PublicKeyValidationError('Invalid public key length: expected 32 bytes');
  }
  const mod = await loadEd25519();
  return mod.ed25519.verify(signature, message, publicKey);
}

async function verifyBatchEd25519(messages, signatures, publicKeys) {
  if (messages.length !== signatures.length || messages.length !== publicKeys.length) {
    throw new VerificationError('Mismatched input lengths');
  }
  if (messages.length === 0) return true;

  const results = await Promise.all(
    messages.map((msg, i) =>
      verifyEd25519(msg, signatures[i], publicKeys[i]).catch(() => false),
    ),
  );

  return results.every(Boolean);
}

module.exports = {
  VerificationError,
  PublicKeyValidationError,
  SignatureValidationError,
  ProofOfPossessionError,
  verifyEd25519,
  verifyBatchEd25519,
  loadEd25519,
};
