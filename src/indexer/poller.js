import { rpc, xdr, scValToNative } from "@stellar/stellar-sdk";

export const EVENT_TOPICS = Object.freeze({
  IP_ANCHOR: "ip_anchor",
  ESCROW_NEW: "escrow_new",
  PAY_REL: "pay_rel",
});

export const SYNC_CURSOR_KEY = "poller_cursor";

export const TOPIC_B64 = Object.freeze(
  Object.values(EVENT_TOPICS).map((t) => xdr.ScVal.scvSymbol(t).toXDR("base64")),
);

export const MERIT_DELTAS = Object.freeze({
  asset_registered: 5,
  escrow_created: 10,
  escrow_settled: 25,
});

const bigintOf = (v) => (typeof v === "bigint" ? v : v == null ? undefined : BigInt(v));
const numOf = (v) => {
  if (typeof v === "bigint") return Number(v);
  return v == null ? undefined : Number(v);
};

const isScVal = (v) => v != null && typeof v === "object" && typeof v.toXDR === "function";
const toNative = (v) => (isScVal(v) ? scValToNative(v) : v);
const toNativeArr = (v) => {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v.map(toNative) : toNative(v);
  return Array.isArray(arr) ? arr : [arr];
};

export function decodeEvent(event) {
  if (!event || event.inSuccessfulContractCall === false) return null;
  const topic = toNativeArr(event.topic);
  const data = toNativeArr(event.value);
  const name = topic[0] == null ? null : String(topic[0]);
  const base = {
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    txHash: event.txHash,
    id: event.id,
  };

  switch (name) {
    case EVENT_TOPICS.IP_ANCHOR: {
      const creator = topic[1] == null ? null : String(topic[1]);
      const fingerprint = Buffer.from(data[1] ?? Buffer.alloc(0)).toString("hex");
      return {
        ...base,
        topic: name,
        payload: {
          asset_id: String(bigintOf(data[0]) ?? 0n),
          creator,
          fingerprint,
          metadata_uri: data[3] != null ? String(data[3]) : "",
          licensing_fee: "0",
          registered_at: numOf(data[2]) ?? Date.now(),
        },
      };
    }
    case EVENT_TOPICS.ESCROW_NEW: {
      const client = topic[1] == null ? null : String(topic[1]);
      const totalAmount = bigintOf(data[2]);
      return {
        ...base,
        topic: name,
        payload: {
          onchain_id: String(bigintOf(data[0]) ?? 0n),
          client,
          creator: data[1] == null ? null : String(data[1]),
          total_amount: String(totalAmount ?? 0n),
          total_milestones: numOf(data[3]) ?? 0,
        },
      };
    }
    case EVENT_TOPICS.PAY_REL: {
      const escrowId = topic[1] == null ? null : String(bigintOf(topic[1]) ?? 0n);
      return {
        ...base,
        topic: name,
        payload: {
          onchain_id: escrowId,
          payout_amount: bigintOf(data[0]),
          completed_milestones: numOf(data[1]) ?? 0,
        },
      };
    }
    default:
      return null;
  }
}

function applyEvent(db, evt) {
  switch (evt.topic) {
    case EVENT_TOPICS.IP_ANCHOR: {
      const p = evt.payload;
      if (!p.creator) return null;
      const inserted = db.insertAsset({
        onchain_id: p.asset_id,
        creator: p.creator,
        fingerprint: p.fingerprint,
        metadata_uri: p.metadata_uri,
        licensing_fee: p.licensing_fee,
        registered_at: p.registered_at,
      });
      if (!inserted) return null;
      db.upsertCreator({ address: p.creator, meritDelta: MERIT_DELTAS.asset_registered });
      return { type: "asset.registered", ledger: evt.ledger, tx_hash: evt.txHash, data: p, applied: true };
    }
    case EVENT_TOPICS.ESCROW_NEW: {
      const p = evt.payload;
      if (!p.client || !p.creator) return null;
      const inserted = db.insertEscrow({
        onchain_id: p.onchain_id,
        client: p.client,
        creator: p.creator,
        total_amount: p.total_amount,
        remaining_balance: p.total_amount,
        total_milestones: p.total_milestones,
        status: "active",
      });
      if (!inserted) return null;
      db.upsertCreator({ address: p.creator, meritDelta: MERIT_DELTAS.escrow_created });
      db.upsertCreator({ address: p.client });
      return { type: "escrow.created", ledger: evt.ledger, tx_hash: evt.txHash, data: p, applied: true };
    }
    case EVENT_TOPICS.PAY_REL: {
      const p = evt.payload;
      const escrow = db.getEscrowByOnchainId(p.onchain_id);
      if (!escrow) return null;
      const payout = p.payout_amount;
      const remaining = bigintOf(escrow.remaining_balance ?? "0");
      const nextRemaining = typeof payout === "bigint" ? (remaining - payout < 0n ? 0n : remaining - payout) : remaining;
      const completed = Math.max(p.completed_milestones, escrow.completed_milestones ?? 0);
      const settled = nextRemaining === 0n;
      const status = settled && escrow.status !== "settled" ? "settled" : escrow.status;
      db.updateEscrowPayout({
        onchain_id: escrow.onchain_id,
        remaining_balance: String(nextRemaining),
        completed_milestones: completed,
        total_milestones: Math.max(escrow.total_milestones ?? 0, completed),
        status,
      });
      if (settled && escrow.status !== "settled") {
        db.upsertCreator({ address: escrow.creator, meritDelta: MERIT_DELTAS.escrow_settled, escrowIncrement: 1 });
      }
      return {
        type: "escrow.payment",
        ledger: evt.ledger,
        tx_hash: evt.txHash,
        data: {
          onchain_id: escrow.onchain_id,
          payout_amount: String(payout ?? 0n),
          completed_milestones: completed,
          remaining_balance: String(nextRemaining),
          status,
        },
        applied: true,
      };
    }
    default:
      return null;
  }
}

export function applyEventBatch(db, decodedEvents, { broadcaster = () => {} } = {}) {
  const applied = db.withTransaction(() =>
    decodedEvents
      .map((evt) => applyEvent(db, evt))
      .filter(Boolean),
  );
  for (const outcome of applied) broadcaster(outcome);
  return applied;
}

export class Poller {
  #running = false;
  #timer = null;

  constructor({ rpcUrl, contractId, db, intervalMs = 10_000, limit = 100, broadcaster = () => {}, startLedger, maxBatchIterations = 5, logger = console }) {
    if (!rpcUrl) throw new Error("rpcUrl is required");
    if (!contractId) throw new Error("contractId is required");
    this.rpcUrl = rpcUrl;
    this.contractId = contractId;
    this.db = db;
    this.intervalMs = intervalMs;
    this.limit = limit;
    this.broadcaster = broadcaster;
    this.startLedger = startLedger;
    this.maxBatchIterations = maxBatchIterations;
    this.logger = logger;
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.filters = [
      { type: "contract", contractIds: [contractId], topics: TOPIC_B64.map((t) => [t]) },
    ];
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    await this.poll();
    this.#timer = setInterval(() => this.poll(), this.intervalMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async poll() {
    try {
      await this.#pollOnce();
    } catch (err) {
      this.logger.error?.("[poller] poll failed", err);
    }
  }

  async #pollOnce() {
    const stored = this.db.getSyncState(SYNC_CURSOR_KEY);
    let request;
    if (stored) {
      request = { filters: this.filters, cursor: stored, limit: this.limit };
    } else {
      const start = this.startLedger ?? (await this.server.getLatestLedger()).sequence;
      request = { filters: this.filters, startLedger: start, limit: this.limit };
    }

    for (let i = 0; i < this.maxBatchIterations; i++) {
      const res = await this.server.getEvents(request);
      const decoded = (res.events ?? []).map(decodeEvent).filter(Boolean);
      if (decoded.length) {
        applyEventBatch(this.db, decoded, { broadcaster: this.broadcaster });
      }
      this.db.setSyncState(SYNC_CURSOR_KEY, res.cursor);
      if ((res.events?.length ?? 0) < this.limit) break;
      request = { filters: this.filters, cursor: res.cursor, limit: this.limit };
    }
  }
}