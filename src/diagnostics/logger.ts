/**
 * VeriNode Backend — Structured Logging (OpenTelemetry Semantic Conventions)
 *
 * Replaces ad-hoc console.log/warn/error with structured JSON log entries
 * that carry trace_id, span_id, service.name, and OTel severity_number.
 *
 * Dual-write mode (VERINODE_LOG_DUAL_WRITE=true) emits the legacy text
 * format alongside structured JSON to support zero-downtime migration.
 *
 * Design:
 *   - Every log entry is a JSON object written to stdout (one per line,
 *     NDJSON format) compatible with the OTel log data model.
 *   - Trace context is captured from the active OpenTelemetry span at
 *     log-emission time, so every entry is automatically correlated with
 *     the current distributed trace.
 *   - The .log() / .warn() / .error() methods match the Console signature
 *     so the logger can be injected anywhere the codebase expects a
 *     Console-compatible logger (e.g. AcmeRenewalManager options.log).
 *   - Module-level loggers carry a "module" attribute for routing.
 */

import { context, trace } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// OTel Severity numbers (1-24, matching the specification)
// ---------------------------------------------------------------------------

export const SeverityNumber = {
  TRACE: 1,
  TRACE2: 2,
  TRACE3: 3,
  TRACE4: 4,
  DEBUG: 5,
  DEBUG2: 6,
  DEBUG3: 7,
  DEBUG4: 8,
  INFO: 9,
  INFO2: 10,
  INFO3: 11,
  INFO4: 12,
  WARN: 13,
  WARN2: 14,
  WARN3: 15,
  WARN4: 16,
  ERROR: 17,
  ERROR2: 18,
  ERROR3: 19,
  ERROR4: 20,
  FATAL: 21,
  FATAL2: 22,
  FATAL3: 23,
  FATAL4: 24,
} as const;

export type SeverityNumber = (typeof SeverityNumber)[keyof typeof SeverityNumber];

const SEVERITY_TEXT: Record<number, string> = {
  [SeverityNumber.TRACE]: 'TRACE',
  [SeverityNumber.DEBUG]: 'DEBUG',
  [SeverityNumber.INFO]: 'INFO',
  [SeverityNumber.WARN]: 'WARN',
  [SeverityNumber.ERROR]: 'ERROR',
  [SeverityNumber.FATAL]: 'FATAL',
};

// ---------------------------------------------------------------------------
// LogEntry data model (OTel-compatible)
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  severity_number: number;
  severity_text: string;
  body: string;
  resource: {
    'service.name': string;
    'service.version'?: string;
  };
  attributes: Record<string, string | number | boolean | undefined>;
  trace_id?: string;
  span_id?: string;
  trace_flags?: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _serviceName: string | null = null;
let _serviceVersion: string | null = null;

const DUAL_WRITE_ENABLED = (): boolean =>
  process.env.VERINODE_LOG_DUAL_WRITE === 'true' ||
  process.env.VERINODE_LOG_DUAL_WRITE === '1';

/** Resolved once and cached. */
function resolveServiceName(): string {
  if (_serviceName) return _serviceName;
  return process.env.OTEL_SERVICE_NAME?.trim() || 'verinode-backend';
}

function resolveServiceVersion(): string {
  if (_serviceVersion) return _serviceVersion;
  try {
    const pkg = require('../../package.json') as { version?: string };
    _serviceVersion = pkg.version ?? 'unknown';
  } catch {
    _serviceVersion = 'unknown';
  }
  return _serviceVersion;
}

/**
 * Override the service name used in log entries.
 * Called by initTracing() so the logger stays in sync with the tracer.
 */
export function setLoggerServiceName(name: string): void {
  _serviceName = name;
}

// ---------------------------------------------------------------------------
// Active span context helper
// ---------------------------------------------------------------------------

function getActiveSpanContext(): {
  trace_id?: string;
  span_id?: string;
  trace_flags?: string;
} {
  try {
    const span = trace.getSpan(context.active());
    if (span?.spanContext()) {
      const sc = span.spanContext();
      return {
        trace_id: sc.traceId,
        span_id: sc.spanId,
        trace_flags: sc.traceFlags.toString(16),
      };
    }
  } catch {
    // OTel API not available or not initialized — proceed without trace context
  }
  return {};
}

// ---------------------------------------------------------------------------
// Entry builder
// ---------------------------------------------------------------------------

function buildEntry(
  severityNumber: number,
  body: string,
  attrs: Record<string, string | number | boolean | undefined>,
): LogEntry {
  const spanCtx = getActiveSpanContext();
  return {
    timestamp: new Date().toISOString(),
    severity_number: severityNumber,
    severity_text: SEVERITY_TEXT[severityNumber] ?? 'INFO',
    body,
    resource: {
      'service.name': resolveServiceName(),
      'service.version': resolveServiceVersion(),
    },
    attributes: attrs,
    ...spanCtx,
  };
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------

function writeStructured(entry: LogEntry): void {
  try {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } catch {
    // Last-resort fallback — should never throw under normal conditions
  }
}

/** Legacy text format for dual-write migration. */
function writeLegacy(entry: LogEntry): void {
  const mod = (entry.attributes.module as string) ?? 'app';
  let line = `[${mod}] ${entry.body}`;
  if (entry.trace_id && entry.span_id) {
    line += ` (trace=${entry.trace_id} span=${entry.span_id})`;
  }
  try {
    process.stderr.write(line + '\n');
  } catch {
    // noop
  }
}

function emit(entry: LogEntry): void {
  writeStructured(entry);
  if (DUAL_WRITE_ENABLED()) {
    writeLegacy(entry);
  }
}

// ---------------------------------------------------------------------------
// StructuredLogger class
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  module?: string;
  attributes?: Record<string, string | number | boolean>;
}

export class StructuredLogger {
  private readonly _module: string;
  private readonly _baseAttrs: Record<string, string | number | boolean>;

  constructor(options: LoggerOptions = {}) {
    this._module = options.module ?? 'app';
    this._baseAttrs = { ...options.attributes, module: this._module };
  }

  /**
   * Create a child logger scoped to a sub-module.
   * The child inherits the parent's base attributes merged with the new ones.
   */
  child(
    module: string,
    attrs?: Record<string, string | number | boolean>,
  ): StructuredLogger {
    return new StructuredLogger({
      module,
      attributes: { ...this._baseAttrs, ...attrs },
    });
  }

  private _resolveArgs(
    message: unknown,
    args: unknown[],
  ): { body: string; attrs: Record<string, string | number | boolean | undefined> } {
    const body = typeof message === 'string' ? message : String(message ?? '');
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
      return { body, attrs: args[0] as Record<string, string | number | boolean | undefined> };
    }
    let attrs: Record<string, string | number | boolean | undefined> = {};
    for (const arg of args) {
      if (arg instanceof Error) {
        attrs['error.message'] = arg.message;
        attrs['error.type'] = arg.name;
        attrs['error.stack'] = arg.stack ?? '';
      }
    }
    return { body, attrs };
  }

  /** Console-compatible .log() — maps to INFO severity. */
  log(message?: unknown, ...args: unknown[]): void {
    const { body, attrs } = this._resolveArgs(message, args);
    this._emit(SeverityNumber.INFO, body, attrs);
  }

  /** Console-compatible .warn() — maps to WARN severity. */
  warn(message?: unknown, ...args: unknown[]): void {
    const { body, attrs } = this._resolveArgs(message, args);
    this._emit(SeverityNumber.WARN, body, attrs);
  }

  /** Console-compatible .error() — maps to ERROR severity. */
  error(message?: unknown, ...args: unknown[]): void {
    const { body, attrs } = this._resolveArgs(message, args);
    this._emit(SeverityNumber.ERROR, body, attrs);
  }

  /** Structured severity methods. */
  debug(msg: string, attrs?: Record<string, string | number | boolean>): void {
    this._emit(SeverityNumber.DEBUG, msg, attrs);
  }

  info(msg: string, attrs?: Record<string, string | number | boolean>): void {
    this._emit(SeverityNumber.INFO, msg, attrs);
  }

  private _emit(
    severity: number,
    body: string,
    extraAttrs?: Record<string, string | number | boolean | undefined>,
  ): void {
    const entry = buildEntry(severity, body, {
      ...this._baseAttrs,
      ...extraAttrs,
    });
    emit(entry);
  }
}

// ---------------------------------------------------------------------------
// Default logger instance (registered on global for CJS consumers)
// ---------------------------------------------------------------------------

const defaultLogger = new StructuredLogger({ module: 'app' });

export function getDefaultLogger(): StructuredLogger {
  return defaultLogger;
}

export function createLogger(
  module: string,
  attrs?: Record<string, string | number | boolean>,
): StructuredLogger {
  return new StructuredLogger({ module, attributes: attrs });
}

// Register on global so CJS modules (index.js, etc.) can find it
// using the same pattern as __verinode_tracing / __verinode_pools.
Object.defineProperty(global, '__verinode_logger', {
  value: defaultLogger,
  writable: false,
  configurable: false,
});
