export interface ValidatorMembership {
  validatorId: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ValidatorRegistryQueryResult<Row = unknown> {
  rows: Row[];
}

export interface ValidatorRegistryDatabase {
  query<Row = unknown>(sql: string, params?: unknown[]): Promise<ValidatorRegistryQueryResult<Row>>;
}

interface ValidatorMembershipRow {
  validator_id: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface CountRow {
  count: string | number | bigint;
}

function requireValidatorId(validatorId: string): void {
  if (typeof validatorId !== 'string' || validatorId.trim().length === 0) {
    throw new TypeError('validatorId must be a non-empty string');
  }
}

function mapMembership(row: ValidatorMembershipRow): ValidatorMembership {
  return {
    validatorId: row.validator_id,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseCount(value: string | number | bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('database returned an invalid validator count');
  }
  return count;
}

/** PostgreSQL-backed authority for validator active-set membership. */
export class ValidatorRegistry {
  constructor(private readonly database: ValidatorRegistryDatabase) {}

  async registerValidator(validatorId: string, active: boolean = true): Promise<ValidatorMembership> {
    requireValidatorId(validatorId);
    if (typeof active !== 'boolean') {
      throw new TypeError('active must be a boolean');
    }

    const result = await this.database.query<ValidatorMembershipRow>(
      `INSERT INTO validator_registry (validator_id, active)
       VALUES ($1, $2)
       ON CONFLICT (validator_id) DO UPDATE
       SET active = EXCLUDED.active, updated_at = NOW()
       RETURNING validator_id, active, created_at, updated_at`,
      [validatorId, active],
    );
    return mapMembership(result.rows[0]);
  }

  async addValidator(validatorId: string, active: boolean = true): Promise<ValidatorMembership> {
    return this.registerValidator(validatorId, active);
  }

  async activateValidator(validatorId: string): Promise<ValidatorMembership> {
    return this.setActive(validatorId, true);
  }

  async deactivateValidator(validatorId: string): Promise<ValidatorMembership> {
    return this.setActive(validatorId, false);
  }

  /** Removing a validator means removing it from the active set, not erasing its identity. */
  async removeValidator(validatorId: string): Promise<ValidatorMembership> {
    return this.deactivateValidator(validatorId);
  }

  async getActiveValidatorIds(): Promise<string[]> {
    const result = await this.database.query<{ validator_id: string }>(
      'SELECT validator_id FROM active_validators ORDER BY validator_id',
    );
    return result.rows.map((row) => row.validator_id);
  }

  async getActiveValidatorCount(): Promise<number> {
    const result = await this.database.query<CountRow>('SELECT COUNT(*) AS count FROM active_validators');
    if (!result.rows[0]) {
      throw new Error('active validator count query returned no row');
    }
    return parseCount(result.rows[0].count);
  }

  private async setActive(validatorId: string, active: boolean): Promise<ValidatorMembership> {
    requireValidatorId(validatorId);
    const result = await this.database.query<ValidatorMembershipRow>(
      `UPDATE validator_registry
       SET active = $2, updated_at = NOW()
       WHERE validator_id = $1
       RETURNING validator_id, active, created_at, updated_at`,
      [validatorId, active],
    );
    if (!result.rows[0]) {
      throw new Error(`Validator ${validatorId} is not registered`);
    }
    return mapMembership(result.rows[0]);
  }
}
