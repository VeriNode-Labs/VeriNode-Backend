'use strict';

const assert = require('node:assert');
const { describe, it, before } = require('node:test');
const crypto = require('node:crypto');

let bls;
let ed;

const {
  generateProofOfPossession,
  verifyProofOfPossession,
  aggregateBLSSignatures,
  aggregateBLSPublicKeys,
  verifyBLSAggregate,
  verifyEd25519Batch,
  verifyAggregate,
} = require('../../src/core/crypto/aggregate_sig');

const { verifyEd25519 } = require('../../src/core/crypto/signature');

before(async () => {
  const blsMod = await import('@noble/curves/bls12-381.js');
  bls = blsMod.bls12_381;
  const edMod = await import('@noble/curves/ed25519.js');
  ed = edMod.ed25519;
});

describe('Aggregate Signature Verification', () => {
  describe('Ed25519 Batch Verification', () => {
    it('should verify a batch of individually valid signatures', async () => {
      const message = Buffer.from('batch-test-message');
      const sk1 = ed.utils.randomSecretKey();
      const sk2 = ed.utils.randomSecretKey();

      const pub1 = ed.getPublicKey(sk1);
      const pub2 = ed.getPublicKey(sk2);

      const sig1 = ed.sign(message, sk1);
      const sig2 = ed.sign(message, sk2);

      const valid = await verifyEd25519Batch(
        [message, message],
        [sig1, sig2],
        [pub1, pub2],
      );
      assert.ok(valid);
    });

    it('should reject batch with a single invalid signature', async () => {
      const message = Buffer.from('batch-test-invalid');

      const sk1 = ed.utils.randomSecretKey();
      const pub1 = ed.getPublicKey(sk1);
      const sig1 = ed.sign(message, sk1);
      const sig2 = crypto.randomBytes(64);

      const valid = await verifyEd25519Batch(
        [message, message],
        [sig1, sig2],
        [pub1, pub1],
      );
      assert.ok(!valid);
    });

    it('should not reveal which signature failed (privacy property)', async () => {
      const message = Buffer.from('privacy-test');
      const sk = ed.utils.randomSecretKey();
      const pub = ed.getPublicKey(sk);
      const sigValid = ed.sign(message, sk);
      const sigInvalid = crypto.randomBytes(64);

      const result1 = await verifyEd25519Batch(
        [message, message],
        [sigValid, sigInvalid],
        [pub, pub],
      );

      const result2 = await verifyEd25519Batch(
        [message, message],
        [sigInvalid, sigValid],
        [pub, pub],
      );

      assert.strictEqual(result1, result2);
    });
  });

  describe('verifyAggregate entry point', () => {
    it('should verify Ed25519 batch via unified entry point', async () => {
      const message = Buffer.from('entry-point');
      const sk = ed.utils.randomSecretKey();
      const pk = ed.getPublicKey(sk);
      const sig = ed.sign(message, sk);

      const valid = await verifyAggregate(
        [message],
        [sig],
        [pk],
        'Ed25519',
      );
      assert.ok(valid);
    });

    it('should reject unsupported curve', async () => {
      const message = Buffer.from('bad-curve');
      await assert.rejects(
        () => verifyAggregate([message], [Buffer.alloc(64)], [Buffer.alloc(32)], 'UnknownCurve'),
      );
    });

    it('should handle empty batch', async () => {
      const valid = await verifyAggregate([], [], [], 'Ed25519');
      assert.ok(valid);
    });
  });

  describe('Proof of Possession', () => {
    it('should verify a valid proof-of-possession', async () => {
      const sk = ed.utils.randomSecretKey();
      const pub = ed.getPublicKey(sk);
      const proof = await generateProofOfPossession(sk, pub);
      const valid = await verifyProofOfPossession(pub, proof);
      assert.ok(valid);
    });

    it('should reject proof for wrong public key', async () => {
      const sk = ed.utils.randomSecretKey();
      const pub = ed.getPublicKey(sk);
      const proof = await generateProofOfPossession(sk, pub);

      const wrongSk = ed.utils.randomSecretKey();
      const wrongPub = ed.getPublicKey(wrongSk);

      const valid = await verifyProofOfPossession(wrongPub, proof);
      assert.ok(!valid);
    });
  });

  describe('Individual verify', () => {
    it('should verify a single Ed25519 signature', async () => {
      const message = Buffer.from('single-verify');
      const sk = ed.utils.randomSecretKey();
      const pub = ed.getPublicKey(sk);
      const sig = ed.sign(message, sk);

      const valid = await verifyEd25519(message, sig, pub);
      assert.ok(valid);
    });

    it('should reject invalid signature with wrong key', async () => {
      const message = Buffer.from('wrong-key');
      const sk = ed.utils.randomSecretKey();
      const wrongSk = ed.utils.randomSecretKey();
      const pub = ed.getPublicKey(wrongSk);
      const sig = ed.sign(message, sk);

      const valid = await verifyEd25519(message, sig, pub);
      assert.ok(!valid);
    });

    it('should reject invalid signature length', async () => {
      const message = Buffer.from('bad-len');
      const sk = ed.utils.randomSecretKey();
      const pub = ed.getPublicKey(sk);

      await assert.rejects(
        () => verifyEd25519(message, Buffer.alloc(10), pub),
      );
    });
  });
});
