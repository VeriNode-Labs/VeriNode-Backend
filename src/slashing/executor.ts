import {
  BASE_SLASHING_PENALTY,
  calculatePenalty,
  type PenaltyCalculation,
} from './penaltyCalculator';

export interface SlashingQueryResult<Row = unknown> {
  rows: Row[];
}

export interface SlashingDatabaseClient {
  query<Row = unknown>(sql: string, params?: unknown[]): Promise<SlashingQueryResult<Row>>;
  release(): void;
}

export interface SlashingDatabasePool {
  connect(): Promise<SlashingDatabaseClient>;
}

export interface ExecuteSlashingInput {
  validatorId: string;
  misbehaviorType: string;
  totalValidators: number;
}

export interface SlashingEvent extends PenaltyCalculation {
  eventId: string;
  validatorId: string;
  misbehaviorType: string;
  validatorCountAtSlashing: number;
  createdAt: Date;
}

interface CountRow {
  count: string | number | bigint;
}

interface SlashingEventRow {
  event_id: string | number | bigint;
  validator_id: string;
  misbehavior_type: string;
  penalty_amount: string | number;
  base_penalty: string | number;
  total_validator_count: string | number | bigint;
  validator_count_at_slashing: string | number | bigint;
  created_at: Date;
}

function requireText(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function parseActiveCount(row: CountRow | undefined): number {
  if (!row) {
    throw new Error('active validator count query returned no row');
  }
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('database returned an invalid active validator count');
  }
  return count;
}

/**
 * Atomically snapshots active membership, calculates the penalty, and records
 * the immutable event. No RPC or other external work occurs in this class.
 */
export class SlashingExecutor {
  constructor(private readonly pool: SlashingDatabasePool) {}

  async execute(input: ExecuteSlashingInput): Promise<SlashingEvent> {
    requireText(input.validatorId, 'validatorId');
    requireText(input.misbehaviorType, 'misbehaviorType');

    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      transactionStarted = true;
      await client.query('LOCK TABLE validator_registry IN SHARE ROW EXCLUSIVE MODE');

      const countResult = await client.query<CountRow>(
        'SELECT COUNT(*) AS count FROM active_validators',
      );
      const validatorCountAtSlashing = parseActiveCount(countResult.rows[0]);
      const calculation = calculatePenalty({
        activeValidators: validatorCountAtSlashing,
        totalValidators: input.totalValidators,
        basePenalty: BASE_SLASHING_PENALTY,
      });

      const eventResult = await client.query<SlashingEventRow>(
        `INSERT INTO slashing_events (
           validator_id,
           misbehavior_type,
           penalty_amount,
           base_penalty,
           total_validator_count,
           validator_count_at_slashing
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING event_id, validator_id, misbehavior_type, penalty_amount,
                   base_penalty, total_validator_count,
                   validator_count_at_slashing, created_at`,
        [
          input.validatorId,
          input.misbehaviorType,
          calculation.penalty,
          calculation.basePenalty,
          calculation.totalValidators,
          validatorCountAtSlashing,
        ],
      );
      if (!eventResult.rows[0]) {
        throw new Error('slashing event insert returned no row');
      }

      await client.query('COMMIT');
      transactionStarted = false;
      return this.mapEvent(eventResult.rows[0], calculation);
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original transaction/commit failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async slash(input: ExecuteSlashingInput): Promise<SlashingEvent> {
    return this.execute(input);
  }

  async executeSlashing(input: ExecuteSlashingInput): Promise<SlashingEvent> {
    return this.execute(input);
  }

  private mapEvent(row: SlashingEventRow, calculation: PenaltyCalculation): SlashingEvent {
    return {
      eventId: String(row.event_id),
      validatorId: row.validator_id,
      misbehaviorType: row.misbehavior_type,
      penalty: Number(row.penalty_amount),
      multiplier: calculation.multiplier,
      activeValidators: Number(row.validator_count_at_slashing),
      totalValidators: Number(row.total_validator_count),
      basePenalty: Number(row.base_penalty),
      validatorCountAtSlashing: Number(row.validator_count_at_slashing),
      createdAt: row.created_at,
    };
  }
}
