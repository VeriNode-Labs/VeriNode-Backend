import { createHash } from 'crypto';

export type IncidentSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface IncidentSignal {
  service: string;
  summary: string;
  severity: IncidentSeverity;
  metric: string;
  value: number;
  threshold: number;
  observedAt?: Date;
  labels?: Record<string, string>;
}

export interface RunbookStep {
  id: string;
  description: string;
  command?: string;
  expectedOutcome: string;
  timeoutMs: number;
  rollbackCommand?: string;
}

export interface RunbookDefinition {
  id: string;
  title: string;
  servicePattern: RegExp;
  metricPattern: RegExp;
  dashboardUrl: string;
  escalationPolicy: string;
  steps: RunbookStep[];
}

export interface PagerDutyIncidentEvent {
  routing_key: string;
  event_action: 'trigger';
  dedup_key: string;
  payload: {
    summary: string;
    source: string;
    severity: IncidentSeverity;
    component: string;
    group: string;
    class: string;
    timestamp: string;
    custom_details: Record<string, unknown>;
  };
  links: Array<{ href: string; text: string }>;
}

export interface PagerDutyIncidentClient {
  trigger(event: PagerDutyIncidentEvent): Promise<void>;
}

export interface IncidentAutomationOptions {
  pagerDutyRoutingKey: string;
  runbooks: RunbookDefinition[];
  now?: () => Date;
}

export interface AutomationPlan {
  incidentId: string;
  runbook: RunbookDefinition;
  pagerDutyEvent: PagerDutyIncidentEvent;
  canary: {
    analysisWindowMinutes: number;
    successCriteria: string[];
    rollbackCriteria: string[];
  };
}

export class HttpPagerDutyIncidentClient implements PagerDutyIncidentClient {
  constructor(private readonly endpoint = 'https://events.pagerduty.com/v2/enqueue') {}

  async trigger(event: PagerDutyIncidentEvent): Promise<void> {
    const fetchFn: typeof fetch = (global as any).fetch;
    if (!fetchFn) {
      throw new Error('Global fetch is not available in this Node runtime');
    }

    const res = await fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    } as any);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PagerDuty incident trigger failed: ${res.status} ${res.statusText} ${text}`);
    }
  }
}

export class IncidentRunbookAutomation {
  constructor(
    private readonly opts: IncidentAutomationOptions,
    private readonly pagerDuty: PagerDutyIncidentClient,
  ) {}

  plan(signal: IncidentSignal): AutomationPlan {
    const runbook = this.matchRunbook(signal);
    const observedAt = signal.observedAt ?? this.opts.now?.() ?? new Date();
    const incidentId = incidentIdFor(signal, runbook.id);
    const pagerDutyEvent = buildPagerDutyEvent({
      routingKey: this.opts.pagerDutyRoutingKey,
      incidentId,
      runbook,
      signal,
      observedAt,
    });

    return {
      incidentId,
      runbook,
      pagerDutyEvent,
      canary: {
        analysisWindowMinutes: 15,
        successCriteria: [
          'critical path P99 latency remains below 100ms',
          'error rate does not increase above the pre-incident baseline',
          'automated remediation completes every runbook step or halts safely',
        ],
        rollbackCriteria: [
          'P99 latency exceeds 100ms for two consecutive analysis windows',
          'PagerDuty deduplication key receives a second critical trigger',
          'any runbook rollback command reports failure',
        ],
      },
    };
  }

  async trigger(signal: IncidentSignal): Promise<AutomationPlan> {
    const plan = this.plan(signal);
    await this.pagerDuty.trigger(plan.pagerDutyEvent);
    return plan;
  }

  private matchRunbook(signal: IncidentSignal): RunbookDefinition {
    const runbook = this.opts.runbooks.find(
      (candidate) =>
        candidate.servicePattern.test(signal.service) &&
        candidate.metricPattern.test(signal.metric),
    );
    if (!runbook) {
      throw new Error(
        `No incident runbook matches service=${signal.service} metric=${signal.metric}`,
      );
    }
    return runbook;
  }
}

export function incidentIdFor(signal: IncidentSignal, runbookId: string): string {
  const digest = createHash('sha256')
    .update(
      [
        signal.service,
        signal.metric,
        signal.severity,
        runbookId,
        signal.labels?.region ?? 'global',
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 32);
  return `incident:${digest}`;
}

export function buildPagerDutyEvent(args: {
  routingKey: string;
  incidentId: string;
  runbook: RunbookDefinition;
  signal: IncidentSignal;
  observedAt: Date;
}): PagerDutyIncidentEvent {
  const { routingKey, incidentId, runbook, signal, observedAt } = args;
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: incidentId,
    payload: {
      summary: `${signal.service}: ${signal.summary}`,
      source: 'verinode-incident-automation',
      severity: signal.severity,
      component: signal.service,
      group: runbook.escalationPolicy,
      class: signal.metric,
      timestamp: observedAt.toISOString(),
      custom_details: {
        runbookId: runbook.id,
        runbookTitle: runbook.title,
        metric: signal.metric,
        value: signal.value,
        threshold: signal.threshold,
        labels: signal.labels ?? {},
        automationStepCount: runbook.steps.length,
        performanceTarget: 'P99 < 100ms',
        availabilityTarget: '99.99%',
      },
    },
    links: [{ href: runbook.dashboardUrl, text: `${runbook.title} dashboard` }],
  };
}

export const defaultIncidentRunbooks: RunbookDefinition[] = [
  {
    id: 'critical-path-latency',
    title: 'Critical path latency remediation',
    servicePattern: /.*/,
    metricPattern: /latency|duration|p99/i,
    dashboardUrl: 'https://grafana.example.com/d/verinode-critical-paths',
    escalationPolicy: 'platform-primary',
    steps: [
      {
        id: 'confirm-slo-breach',
        description: 'Confirm the P99 latency breach across the active and canary stacks.',
        command: 'verinodectl slo latency --window=5m --percentile=99',
        expectedOutcome:
          'The alert is confirmed or marked as a false positive before remediation begins.',
        timeoutMs: 30000,
      },
      {
        id: 'shift-traffic-blue-green',
        description: 'Shift traffic away from the degraded color using the blue-green controller.',
        command: 'verinodectl deploy traffic-shift --from=degraded --to=healthy --step=25',
        expectedOutcome:
          'Traffic moves in bounded increments while canary analysis remains healthy.',
        timeoutMs: 60000,
        rollbackCommand: 'verinodectl deploy traffic-shift --rollback',
      },
    ],
  },
];
