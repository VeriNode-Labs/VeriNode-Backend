'use strict';

const { verifyAggregate, verifyProofOfPossession } = require('../crypto/aggregate_sig');
const { verifyEd25519 } = require('../crypto/signature');
const crypto = require('node:crypto');
const os = require('node:os');

const metrics = {
  crypto_aggregate_verify_duration_seconds: { buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5, 1] },
  crypto_batch_size_total: {},
};

let histogramDuration = null;
let counterBatchSize = null;

function initMetrics() {
  try {
    const client = require('prom-client');
    if (!histogramDuration) {
      histogramDuration = new client.Histogram({
        name: 'crypto_aggregate_verify_duration_seconds',
        help: 'Duration of aggregate signature verification in seconds',
        buckets: metrics.crypto_aggregate_verify_duration_seconds.buckets,
        labelNames: ['curve'],
      });
    }
    if (!counterBatchSize) {
      counterBatchSize = new client.Counter({
        name: 'crypto_batch_size_total',
        help: 'Total number of signatures processed in batch verifications',
        labelNames: ['curve'],
      });
    }
  } catch {
    // prom-client not available
  }
}

class BatchValidator {
  constructor(options = {}) {
    this.options = {
      maxBatchSize: options.maxBatchSize || 512,
      parallelism: options.parallelism || os.cpus().length,
      requirePoP: options.requirePoP !== false,
      ...options,
    };
    initMetrics();
  }

  async validateBatch(signedMessages, curve = 'BLS12-381') {
    const startTime = performance.now();
    const batchSize = signedMessages.length;

    if (batchSize === 0) {
      return { valid: true, verified: 0, failed: 0 };
    }

    if (batchSize > this.options.maxBatchSize) {
      const partitions = this.partitionBatch(signedMessages, this.options.parallelism);
      const results = await Promise.all(
        partitions.map((p) => this.validateBatch(p, curve)),
      );

      const duration = (performance.now() - startTime) / 1000;
      if (histogramDuration) histogramDuration.observe({ curve }, duration);
      if (counterBatchSize) counterBatchSize.inc({ curve }, batchSize);

      return {
        valid: results.every((r) => r.valid),
        verified: results.reduce((s, r) => s + r.verified, 0),
        failed: results.reduce((s, r) => s + r.failed, 0),
      };
    }

    const messages = signedMessages.map((sm) =>
      typeof sm.message === 'string' ? Buffer.from(sm.message) : sm.message,
    );
    const signatures = signedMessages.map((sm) => sm.signature);
    const publicKeys = signedMessages.map((sm) => sm.publicKey);

    let valid = false;
    try {
      valid = await verifyAggregate(messages, signatures, publicKeys, curve);
    } catch {
      valid = false;
    }

    const duration = (performance.now() - startTime) / 1000;
    if (histogramDuration) histogramDuration.observe({ curve }, duration);
    if (counterBatchSize) counterBatchSize.inc({ curve }, batchSize);

    return {
      valid,
      verified: valid ? batchSize : 0,
      failed: valid ? 0 : batchSize,
    };
  }

  async validateWithPop(signedMessagesWithPop, curve = 'BLS12-381') {
    if (this.options.requirePoP) {
      for (let i = 0; i < signedMessagesWithPop.length; i++) {
        const { publicKey, proof } = signedMessagesWithPop[i];
        const popValid = await verifyProofOfPossession(publicKey, proof);
        if (!popValid) {
          return {
            valid: false,
            verified: 0,
            failed: signedMessagesWithPop.length,
            error: `Proof-of-possession failed at index ${i}`,
          };
        }
      }
    }

    return this.validateBatch(signedMessagesWithPop, curve);
  }

  partitionBatch(signedMessages, numPartitions) {
    const partitions = [];
    const chunkSize = Math.ceil(signedMessages.length / numPartitions);
    for (let i = 0; i < signedMessages.length; i += chunkSize) {
      partitions.push(signedMessages.slice(i, i + chunkSize));
    }
    return partitions;
  }
}

async function verifySingle(signedMessage, curve = 'Ed25519') {
  const { message, signature, publicKey } = signedMessage;
  const msgBuf = typeof message === 'string' ? Buffer.from(message) : message;

  if (curve === 'Ed25519') {
    return verifyEd25519(msgBuf, signature, publicKey);
  }

  if (curve === 'BLS12-381') {
    return verifyAggregate([msgBuf], [signature], [publicKey], 'BLS12-381');
  }

  throw new Error(`Unsupported curve: ${curve}`);
}

module.exports = {
  BatchValidator,
  verifySingle,
};
