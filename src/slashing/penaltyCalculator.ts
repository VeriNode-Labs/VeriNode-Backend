export const BASE_SLASHING_PENALTY = 500;

export interface PenaltyInputs {
  activeValidators: number;
  totalValidators: number;
  basePenalty?: number;
}

export interface PenaltyCalculation {
  penalty: number;
  multiplier: number;
  activeValidators: number;
  totalValidators: number;
  basePenalty: number;
}

function assertValidatorCount(value: number, name: string, allowZero: boolean): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a finite, safe integer`);
  }
  if (allowZero ? value < 0 : value <= 0) {
    throw new RangeError(`${name} must be ${allowZero ? 'non-negative' : 'greater than zero'}`);
  }
}

/**
 * Calculate the monetary penalty from the validator-set snapshot.
 *
 * The positional form is (activeValidators, totalValidators, basePenalty?).
 * The object form is also supported to keep call sites self-documenting.
 */
export function calculatePenalty(inputs: PenaltyInputs): PenaltyCalculation;
export function calculatePenalty(
  activeValidators: number,
  totalValidators: number,
  basePenalty?: number,
): PenaltyCalculation;
export function calculatePenalty(
  inputsOrActive: PenaltyInputs | number,
  positionalTotal?: number,
  positionalBase: number = BASE_SLASHING_PENALTY,
): PenaltyCalculation {
  const inputs: PenaltyInputs =
    typeof inputsOrActive === 'number'
      ? {
          activeValidators: inputsOrActive,
          totalValidators: positionalTotal as number,
          basePenalty: positionalBase,
        }
      : inputsOrActive;

  const {
    activeValidators,
    totalValidators,
    basePenalty = BASE_SLASHING_PENALTY,
  } = inputs;

  assertValidatorCount(totalValidators, 'totalValidators', false);
  assertValidatorCount(activeValidators, 'activeValidators', true);
  if (activeValidators > totalValidators) {
    throw new RangeError('activeValidators must not exceed totalValidators');
  }
  if (!Number.isFinite(basePenalty) || basePenalty <= 0) {
    throw new RangeError('basePenalty must be finite and greater than zero');
  }

  const multiplier = 1 + (totalValidators - activeValidators) / totalValidators;
  const penalty = basePenalty * multiplier;
  if (!Number.isFinite(penalty)) {
    throw new RangeError('calculated penalty must be finite');
  }

  return {
    penalty,
    multiplier,
    activeValidators,
    totalValidators,
    basePenalty,
  };
}
