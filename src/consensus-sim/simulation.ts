import { SimulationConfig, ValidatorId, Message, FaultSpec } from './faults';

type ValidatorState = {
  id: ValidatorId;
  active: boolean; // not timed out
  decided: Map<number, any>;
};

export class Simulation {
  validators: ValidatorState[];
  maxRounds: number;
  faultSpec?: FaultSpec | null;

  constructor(cfg: SimulationConfig) {
    this.validators = cfg.validators.map((id) => ({ id, active: true, decided: new Map() }));
    this.maxRounds = cfg.maxRounds ?? 20;
    this.faultSpec = cfg.faultSpec ?? null;
  }

  private getValidator(id: ValidatorId) {
    return this.validators.find((v) => v.id === id)!;
  }

  // decides whether message between a->b in a given round should be delivered
  private shouldDeliver(from: ValidatorId, to: ValidatorId, round: number): boolean {
    const p = this.faultSpec?.partition;
    if (p && p.groups && p.groups.length > 1) {
      const groupIndex = (id: ValidatorId) => p.groups.findIndex((g) => g.includes(id));
      const gi = groupIndex(from);
      const gj = groupIndex(to);
      if (gi !== gj && gi >= 0 && gj >= 0) {
        // if durationRounds is set, only drop for those rounds
        if (!p.durationRounds || round <= p.durationRounds) return false;
      }
    }
    // timeout faults: if sender is timed out during this round, don't send
    const toff = this.faultSpec?.timeout;
    if (toff && toff.by && toff.by.includes(from)) {
      if (!toff.durationRounds || round <= toff.durationRounds) return false;
    }
    // otherwise deliver
    return true;
  }

  // simulate a single round; returns true if consensus achieved
  private async runRound(round: number): Promise<boolean> {
    // Each validator generates a proposal. For simplicity, their proposal is `${id}-v${round}`
    const proposals: Map<ValidatorId, any> = new Map();
    for (const v of this.validators) {
      // if timeout and in timeout duration, do not propose
      const toff = this.faultSpec?.timeout;
      if (toff && toff.by && toff.by.includes(v.id) && (!toff.durationRounds || round <= toff.durationRounds)) {
        continue;
      }
      proposals.set(v.id, `${v.id}-v${round}`);
    }

    // Build message deliveries respecting partition/delay/equivocation
    const deliveries: Promise<Message | null>[] = [];
    for (const [from, payload] of proposals.entries()) {
      for (const dest of this.validators.map((x) => x.id)) {
        if (dest === from) continue;
        if (!this.shouldDeliver(from, dest, round)) {
          deliveries.push(Promise.resolve(null));
          continue;
        }

        // equivocation: if configured and this sender is in equivocation list, send different payloads to different peers
        const eq = this.faultSpec?.equivocation;
        let pl = payload;
        if (eq && eq.by && eq.by.includes(from)) {
          // craft an alternate value per dest
          pl = `${payload}-alt-${dest}`;
        }

        // delay injection
        const delay = this.faultSpec?.delay;
        if (delay && Math.random() < (delay.probability ?? 1)) {
          const jitter = delay.jitter ? (Math.random() - 0.5) * delay.jitter : 0;
          const ms = Math.max(0, delay.ms + jitter);
          deliveries.push(new Promise((res) => setTimeout(() => res({ from, to: dest, round, payload: pl }), ms)));
        } else {
          deliveries.push(Promise.resolve({ from, to: dest, round, payload: pl }));
        }
      }
    }

    const msgs = (await Promise.all(deliveries)).filter((m): m is Message => m !== null);

    // Tally per-recipient
    const perRecipient = new Map<ValidatorId, Map<any, number>>();
    for (const v of this.validators) perRecipient.set(v.id, new Map());
    for (const m of msgs) {
      const map = perRecipient.get(m.to)!;
      map.set(m.payload, (map.get(m.payload) ?? 0) + 1);
    }

    // For each validator, see if they observe a 2/3+ majority on a value
    const n = this.validators.length;
    let anyDecided = false;
    for (const [vid, tally] of perRecipient.entries()) {
      for (const [val, count] of tally.entries()) {
        if (count >= Math.floor((2 * n) / 3) + 1) {
          this.getValidator(vid).decided.set(round, val);
          anyDecided = true;
          break;
        }
      }
    }

    return anyDecided;
  }

  // run the simulation and return an object summarizing rounds and whether recovery achieved
  async run(): Promise<{ rounds: number; recovered: boolean }> {
    for (let r = 1; r <= this.maxRounds; r++) {
      const ok = await this.runRound(r);
      if (ok) {
        return { rounds: r, recovered: true };
      }
    }
    return { rounds: this.maxRounds, recovered: false };
  }
}

export default Simulation;
