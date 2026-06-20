/**
 * VeriNode Backend — OpenTelemetry Tracing Bootstrap
 *
 * Initializes a global OpenTelemetry TracerProvider that satisfies the
 * tracing-requirements of issue #15:
 *   - OTLP/gRPC export to OTEL_EXPORTER_OTLP_ENDPOINT
 *     (default http://otel-collector:4317)
 *   - ParentBasedSampler wrapping TraceIdRatioBased(0.01)
 *     (1% head-based sampling, child spans inherit parent decision)
 *   - W3C TraceContext propagation (traceparent / tracestate)
 *   - Resource attributes on every span:
 *       service.name, service.version, host.name, deployment.environment
 *   - /debug/traces/config endpoint exposes sampler + exporter + queue depth
 *
 * Design notes:
 *   - initTracing() is idempotent: safe to call multiple times
 *     (NodeSDK / TraceIdRatioBased / ParentBasedSampler are global singletons;
 *      we guard with a module-level flag).
 *   - Initialization is best-effort: if the OTLP endpoint is unreachable
 *     or the SDK throws, initTracing() returns null and logs a warning,
 *     never crashing the host process.
 *   - Honors OTEL_SDK_DISABLED=true: a no-op fast path for tests that
 *     want to exercise unrelated code without spinning up the SDK.
 *   - ErrorLoggingSpanProcessor marks spans whose status === ERROR to
 *     stderr so on-call engineers can grep for failures even when the
 *     collector is unreachable. It does NOT alter sampling decisions;
 *     the 1% head sample still applies, and any caller wanting
 *     force-sample-on-error must add a custom Sampler.
 */

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  SpanProcessor,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Defaults (can be overridden by env)
// ---------------------------------------------------------------------------

const DEFAULT_SERVICE_NAME = 'verinode-backend';
const DEFAULT_EXPORTER_ENDPOINT = 'http://otel-collector:4317';
const DEFAULT_SAMPLER_RATIO = 0.01;
const DEPLOYMENT_ENV_FALLBACK = 'development';

// ---------------------------------------------------------------------------
// QueueDepthSpanProcessor — tracks in-flight span count for the
// /debug/traces/config endpoint. Span lifecycle:
//   onStart  → depth++   (before span attributes are written)
//   onEnd    → depth--   (after span is sealed)
// ---------------------------------------------------------------------------

export class QueueDepthSpanProcessor implements SpanProcessor {
  private _depth = 0;

  onStart(_span: Span, _parentContext: unknown): void {
    this._depth++;
  }

  onEnd(_span: ReadableSpan): void {
    this._depth = Math.max(0, this._depth - 1);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this._depth = 0;
    return Promise.resolve();
  }

  getQueueDepth(): number {
    return this._depth;
  }
}

// ---------------------------------------------------------------------------
// ErrorLoggingSpanProcessor — emits a single stderr line per span whose
// status becomes ERROR, so on-call engineers can grep for failures even
// when the OTLP collector is unreachable. It does NOT change the
// sampling decision; the configured head sampler still applies.
//
// To force-sample error spans, callers should attach ErrorLoggingSpanProcessor
// AND extend the Sampler to return RecordAndSample on a marker attribute,
// which is left as future work for issue #43.
// ---------------------------------------------------------------------------

export class ErrorLoggingSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: unknown): void {
    // no-op
  }

  onEnd(span: ReadableSpan): void {
    const status = span.status;
    if (status && status.code === SpanStatusCode.ERROR) {
      const traceId = span.spanContext().traceId;
      const spanId = span.spanContext().spanId;
      const name = span.name;
      const messages = (span.events ?? [])
        .map((e) => (e.name ?? '').toString())
        .join(',');
      console.warn(
        `[tracer.error] trace=${traceId} span=${spanId} name=${name} events=${messages}`,
      );
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

export interface TraceConfig {
  serviceName: string;
  serviceVersion: string;
  hostName: string;
  deploymentEnvironment: string;
  exporterEndpoint: string;
  exporterProtocol: string;
  samplerType: string;
  samplerRatio: number;
  propagationFormat: string;
  queueDepth: number;
  initialized: boolean;
}

let sdk: NodeSDK | null = null;
let queueProcessor: QueueDepthSpanProcessor | null = null;
let initialized = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveEndpoint(): string {
  return (
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    DEFAULT_EXPORTER_ENDPOINT
  );
}

function resolveServiceName(): string {
  return process.env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
}

function resolveServiceVersion(): string {
  return (
    process.env.OTEL_SERVICE_VERSION?.trim() || readPackageVersion()
  );
}

function resolveSamplerRatio(): number {
  const raw =
    process.env.OTEL_TRACES_SAMPLER_ARG?.trim() ||
    process.env.OTEL_SAMPLING_RATIO?.trim();
  if (raw === undefined || raw === '') return DEFAULT_SAMPLER_RATIO;
  const f = parseFloat(raw);
  if (!Number.isFinite(f)) return DEFAULT_SAMPLER_RATIO;
  return Math.min(1, Math.max(0, f));
}

function resolveDeploymentEnv(): string {
  return (
    process.env.DEPLOYMENT_ENVIRONMENT?.trim() ||
    process.env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() ||
    process.env.NODE_ENV?.trim() ||
    DEPLOYMENT_ENV_FALLBACK
  );
}

function buildResource() {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: resolveServiceName(),
    [ATTR_SERVICE_VERSION]: resolveServiceVersion(),
    'host.name': os.hostname(),
    'deployment.environment': resolveDeploymentEnv(),
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitOptions {
  /**
   * Suppress the diagnostic console logger and the "OpenTelemetry
   * initialized" log line. Defaults to false.
   */
  silent?: boolean;
  /**
   * Skip initialization entirely. Equivalent to setting
   * `OTEL_SDK_DISABLED=true` in the environment. Defaults to false.
   */
  disabled?: boolean;
}

/**
 * Initialize the global OpenTelemetry TracerProvider exactly once.
 *
 * Returns the resolved TraceConfig on success, or null if startup failed.
 * Subsequent calls are a no-op and return the existing config.
 */
export function initTracing(options: InitOptions = {}): TraceConfig | null {
  if (initialized) {
    return getTraceConfig();
  }

  // Honor the standard OTEL_SDK_DISABLED env. Tests can flip this on
  // before importing the module to skip SDK startup entirely.
  if (process.env.OTEL_SDK_DISABLED === 'true' || options.disabled === true) {
    if (!options.silent) {
      console.log('[tracer] OTEL_SDK_DISABLED=true — skipping initializer');
    }
    initialized = true; // mark so subsequent calls are a no-op
    return getTraceConfig();
  }

  if (!options.silent) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  }

  const endpoint = resolveEndpoint();
  const samplerRatio = resolveSamplerRatio();
  const serviceName = resolveServiceName();

  try {
    const exporter = new OTLPTraceExporter({ url: endpoint });
    queueProcessor = new QueueDepthSpanProcessor();

    sdk = new NodeSDK({
      resource: buildResource(),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(samplerRatio),
      }),
      spanProcessors: [
        new BatchSpanProcessor(exporter),
        queueProcessor,
        new ErrorLoggingSpanProcessor(),
      ],
      instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
    });

    sdk.start();
    initialized = true;

    if (!options.silent) {
      console.log(
        `[tracer] OpenTelemetry initialized service=${serviceName} ` +
          `endpoint=${endpoint} sampler=${samplerRatio}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!options.silent) {
      console.warn('[tracer] Failed to initialize OpenTelemetry SDK:', msg);
    }
    sdk = null;
    queueProcessor = null;
    initialized = false;
    return null;
  }

  return getTraceConfig();
}

/**
 * Shut the SDK down gracefully. Always resolves — never throws.
 * Idempotent: safe to call when nothing is initialized.
 */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) {
    initialized = false;
    queueProcessor = null;
    return;
  }
  try {
    await sdk.shutdown();
  } catch (err) {
    if (process.env.OTEL_DEBUG === 'true') {
      console.warn('[tracer] shutdown error:', err);
    }
  } finally {
    sdk = null;
    queueProcessor = null;
    initialized = false;
  }
}

/**
 * Return the current trace configuration snapshot. Does not require
 * initialization — returns env-derived defaults if init has not run.
 */
export function getTraceConfig(): TraceConfig {
  return {
    serviceName: resolveServiceName(),
    serviceVersion: resolveServiceVersion(),
    hostName: os.hostname(),
    deploymentEnvironment: resolveDeploymentEnv(),
    exporterEndpoint: resolveEndpoint(),
    exporterProtocol: 'OTLP/gRPC',
    samplerType: 'ParentBased(TraceIdRatioBased)',
    samplerRatio: resolveSamplerRatio(),
    propagationFormat: 'W3C TraceContext',
    queueDepth: queueProcessor?.getQueueDepth() ?? 0,
    initialized,
  };
}

export function isInitialized(): boolean {
  return initialized;
}

/**
 * Convenience: a no-op fallback processor list, useful for tests that
 * want to swap in InMemorySpanExporter without spinning up NodeSDK.
 */
export function makeTestProcessorList(exporter: import('@opentelemetry/sdk-trace-base').SpanExporter): SpanProcessor[] {
  return [new SimpleSpanProcessor(exporter), new QueueDepthSpanProcessor()];
}

// Suppress unused-import lint for SimpleSpanProcessor when this file
// is imported by tests that don't exercise the helper.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ensureSimpleSpanProcessorIsReachable = SimpleSpanProcessor;
