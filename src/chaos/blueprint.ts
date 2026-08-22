export type ChaosFaultType =
  'latency' | 'packet-loss' | 'pod-kill' | 'dependency-error' | 'cpu-pressure' | 'clock-skew';

export interface ChaosScenario {
  name: string;
  service: string;
  fault: ChaosFaultType;
  blastRadiusPercent: number;
  durationSeconds: number;
  steadyStateProbe: string;
  rollbackTrigger: string;
}

export interface ChaosBlueprint {
  environment: 'staging';
  availabilityTargetPercent: number;
  criticalPathP99LatencyMs: number;
  maxBlastRadiusPercent: number;
  scenarios: ChaosScenario[];
}

export interface ValidationFinding {
  scenario: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  findings: ValidationFinding[];
}

export const DEFAULT_STAGING_CHAOS_BLUEPRINT: ChaosBlueprint = {
  environment: 'staging',
  availabilityTargetPercent: 99.99,
  criticalPathP99LatencyMs: 100,
  maxBlastRadiusPercent: 10,
  scenarios: [
    {
      name: 'gateway-critical-path-latency',
      service: 'api-gateway',
      fault: 'latency',
      blastRadiusPercent: 5,
      durationSeconds: 300,
      steadyStateProbe: 'p99 latency remains below 100ms and HTTP 5xx rate stays below 0.1%',
      rollbackTrigger: 'p99 latency breaches 100ms for 3 consecutive minutes',
    },
    {
      name: 'kafka-consumer-pod-kill',
      service: 'queue-workers',
      fault: 'pod-kill',
      blastRadiusPercent: 10,
      durationSeconds: 180,
      steadyStateProbe: 'consumer lag recovers without lost messages',
      rollbackTrigger: 'critical consumer lag alert fires or DLQ growth exceeds baseline',
    },
    {
      name: 'postgres-dependency-errors',
      service: 'database-clients',
      fault: 'dependency-error',
      blastRadiusPercent: 5,
      durationSeconds: 120,
      steadyStateProbe: 'readiness gates reject failed dependencies and retries stay bounded',
      rollbackTrigger: 'availability drops below 99.99% or error budget burn exceeds 2x',
    },
  ],
};

export function validateChaosBlueprint(blueprint: ChaosBlueprint): ValidationResult {
  const findings: ValidationFinding[] = [];

  if (blueprint.environment !== 'staging') {
    findings.push({ scenario: 'blueprint', message: 'chaos experiments must target staging only' });
  }

  if (blueprint.availabilityTargetPercent < 99.99) {
    findings.push({
      scenario: 'blueprint',
      message: 'availability target must be at least 99.99%',
    });
  }

  if (blueprint.criticalPathP99LatencyMs > 100) {
    findings.push({
      scenario: 'blueprint',
      message: 'critical path P99 latency target must be <= 100ms',
    });
  }

  for (const scenario of blueprint.scenarios) {
    if (
      scenario.blastRadiusPercent <= 0 ||
      scenario.blastRadiusPercent > blueprint.maxBlastRadiusPercent
    ) {
      findings.push({
        scenario: scenario.name,
        message: 'blast radius exceeds the approved staging guardrail',
      });
    }

    if (scenario.durationSeconds <= 0 || scenario.durationSeconds > 900) {
      findings.push({
        scenario: scenario.name,
        message: 'duration must be between 1 and 900 seconds',
      });
    }

    if (!scenario.steadyStateProbe.trim()) {
      findings.push({ scenario: scenario.name, message: 'steady-state probe is required' });
    }

    if (!scenario.rollbackTrigger.trim()) {
      findings.push({ scenario: scenario.name, message: 'rollback trigger is required' });
    }
  }

  return { valid: findings.length === 0, findings };
}

export function summarizeChaosReadiness(blueprint: ChaosBlueprint): string[] {
  const validation = validateChaosBlueprint(blueprint);
  if (!validation.valid) {
    return validation.findings.map((finding) => `${finding.scenario}: ${finding.message}`);
  }

  return blueprint.scenarios.map(
    (scenario) =>
      `${scenario.name} targets ${scenario.service} with ${scenario.fault} at ${scenario.blastRadiusPercent}% blast radius for ${scenario.durationSeconds}s`,
  );
}
