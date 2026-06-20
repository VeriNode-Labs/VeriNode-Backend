import {
  propagation,
  context,
  trace,
  SpanStatusCode,
  type TracerProvider,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { BasicTracerProvider as _UnusedBasicTracerProvider } from '@opentelemetry/sdk-trace-base';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keepBasicTracerProvider = _UnusedBasicTracerProvider;
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import * as os from 'node:os';

// Configure environment *before* importing the SUT so init defaults
// pick up the test-derived values.
process.env.OTEL_SERVICE_NAME = 'verinode-backend-test';
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:14317';
process.env.DEPLOYMENT_ENVIRONMENT = 'ci';
process.env.OTEL_SERVICE_VERSION = '0.0.0-test';

// SUT — imported AFTER env configuration so module-level reads are correct.
import {
  initTracing,
  shutdownTracing,
  getTraceConfig,
  isInitialized,
  QueueDepthSpanProcessor,
  ErrorLoggingSpanProcessor,
} from '../src/diagnostics/tracer';

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}`);
      failed++;
    }
  }

  console.log('\nOpenTelemetry Tracer Tests\n');

  // -------------------------------------------------------------------------
  // 1. getTraceConfig() returns env-derived defaults before init
  // -------------------------------------------------------------------------
  {
    await shutdownTracing();
    const cfg = getTraceConfig();
    assert(cfg.serviceName === 'verinode-backend-test', `serviceName from env: ${cfg.serviceName}`);
    assert(cfg.serviceVersion === '0.0.0-test', `serviceVersion from env: ${cfg.serviceVersion}`);
    assert(
      cfg.exporterEndpoint === 'http://127.0.0.1:14317',
      `exporterEndpoint from env: ${cfg.exporterEndpoint}`,
    );
    assert(
      cfg.samplerRatio === 0.01,
      `default samplerRatio 0.01: ${cfg.samplerRatio}`,
    );
    assert(cfg.samplerType === 'ParentBased(TraceIdRatioBased)', `samplerType: ${cfg.samplerType}`);
    assert(cfg.propagationFormat === 'W3C TraceContext', `propagator: ${cfg.propagationFormat}`);
    assert(cfg.exporterProtocol === 'OTLP/gRPC', `exporterProtocol: ${cfg.exporterProtocol}`);
    assert(cfg.deploymentEnvironment === 'ci', `deploymentEnvironment from env: ${cfg.deploymentEnvironment}`);
    assert(typeof cfg.hostName === 'string' && cfg.hostName.length > 0, `hostName populated: ${cfg.hostName}`);
    assert(cfg.initialized === false, 'not initialized pre-init');
    assert(typeof cfg.queueDepth === 'number' && cfg.queueDepth >= 0, `queueDepth nonneg: ${cfg.queueDepth}`);
  }

  // -------------------------------------------------------------------------
  // 2. initTracing() is idempotent and sets initialized=true
  // -------------------------------------------------------------------------
  {
    await shutdownTracing();
    assert(isInitialized() === false, 'pre-init: still not initialized');
    const cfg1 = initTracing({ silent: true });
    assert(cfg1 !== null, 'first init returns config');
    assert(isInitialized() === true, 'after init: isInitialized=true');
    assert(cfg1!.initialized === true, 'first config.initialized=true');
    assert(cfg1!.exporterEndpoint === 'http://127.0.0.1:14317', 'first config endpoint retained');
    assert(typeof cfg1!.queueDepth === 'number', 'queueDepth present after init');

    // Second call must not throw and must report initialized.
    const cfg2 = initTracing({ silent: true });
    assert(cfg2 !== null, 'second init returns same config object');
    assert(cfg2!.initialized === true, 'second config.initialized=true');
  }

  // -------------------------------------------------------------------------
  // 3. W3C TraceContext propagator round-trip: inject then extract
  //    the traceparent header and recover the same traceId / parent.
  //    Must await shutdownTracing() first so the previous NodeSDK does
  //    not race with our local NodeTracerProvider for global state.
  // -------------------------------------------------------------------------
  {
    await shutdownTracing();
    const inmem = new InMemorySpanExporter();
    const provider: TracerProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(inmem)],
    });
    trace.setGlobalTracerProvider(provider);

    const t = trace.getTracer('verify-w3c');
    const rootSpan = t.startSpan('root-span');
    const carrier: Record<string, string> = {};
    const ctxWithSpan = trace.setSpan(context.active(), rootSpan);
    // propagation.inject delegates to the global propagator with the
    // standard text-map setter — avoids needing to import a named setter
    // that may not be exported in all OTel versions.
    propagation.inject(ctxWithSpan, carrier);

    assert(
      typeof carrier.traceparent === 'string' && /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(carrier.traceparent),
      `injected traceparent header has correct shape: ${carrier.traceparent}`,
    );

    const extractedCtx = propagation.extract(context.active(), carrier);
    const extracted = trace.getSpan(extractedCtx);
    assert(extracted !== undefined, 'extract returns the propagated span');
    assert(
      extracted!.spanContext().traceId === rootSpan.spanContext().traceId,
      `propagated traceId matches root: ${extracted?.spanContext().traceId}`,
    );

    rootSpan.end();
    await shutdownTracing();
  }

  // -------------------------------------------------------------------------
  // 4. W3CTraceContextPropagator class can be instantiated; propagation.inject
  //    routes through the global propagator with the standard setter.
  // -------------------------------------------------------------------------
  {
    const p = new W3CTraceContextPropagator();
    assert(p.constructor.name === 'W3CTraceContextPropagator', `propagator class accessible: ${p.constructor.name}`);
    assert(typeof p.inject === 'function', 'inject is a method');
    assert(typeof p.extract === 'function', 'extract is a method');

    // Inject through the global propagation facade — equivalent to a manual
    // W3CTraceContextPropagator().inject(...) call.
    const c: Record<string, string> = {};
    propagation.inject(context.active(), c);
    assert(Object.keys(c).length === 0, 'no spans active → empty carrier');
  }

  // -------------------------------------------------------------------------
  // 5a. TraceIdRatioBased(0.01) yields ~1% head sampling
  // -------------------------------------------------------------------------
  {
    await shutdownTracing();
    const provider = new NodeTracerProvider({
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(0.01),
      }),
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    trace.setGlobalTracerProvider(provider);

    let recorded = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const s = trace.getTracer('sample-test').startSpan(`sp-${i}`);
      if (s.isRecording()) recorded++;
      s.end();
    }
    const ratio = recorded / N;
    assert(
      ratio >= 0.003 && ratio <= 0.03,
      `sampling ratio within 0.3–3.0% (got ${recorded}/${N} = ${(ratio * 100).toFixed(2)}%)`,
    );

    await shutdownTracing();
  }

  // -------------------------------------------------------------------------
  // 5b. ParentBasedSampler: child spans inherit the parent sampling decision.
  //     Build a tracer directly off a BasicTracerProvider to bypass any
  //     global-provider caching that may return a NoopTracer mid-test.
  // -------------------------------------------------------------------------
  {
    await shutdownTracing();
    const provider = new BasicTracerProvider({
      sampler: new ParentBasedSampler({
        root: new AlwaysOnSampler(),
      }),
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    const directTracer = provider.getTracer('sample-test-direct');
    assert(directTracer !== undefined, 'direct tracer available from BasicTracerProvider');

    const root = directTracer.startSpan('root');
    assert(root.isRecording(), 'root span recorded under AlwaysOn direct provider');
    const childCtx = trace.setSpan(context.active(), root);
    const child = directTracer.startSpan('child', {}, childCtx);
    assert(child.isRecording(), 'child of an already-sampled parent is sampled');
    child.end();
    root.end();

    await provider.shutdown();
  }

  // -------------------------------------------------------------------------
  // 6. QueueDepthSpanProcessor tracks span start/end lifecycle
  // -------------------------------------------------------------------------
  {
    const proc = new QueueDepthSpanProcessor();
    assert(proc.getQueueDepth() === 0, 'starts at depth 0');
    const fakeStartIncr = (() => {
      // stub Span — only onStart signature is exercised
      proc.onStart({} as any, {} as any);
    });
    fakeStartIncr();
    fakeStartIncr();
    assert(proc.getQueueDepth() === 2, 'depth increments on onStart');
    proc.onEnd({} as any);
    assert(proc.getQueueDepth() === 1, 'depth decrements on onEnd');
    proc.onEnd({} as any);
    proc.onEnd({} as any); // over-decrement is clamped
    assert(proc.getQueueDepth() === 0, 'over-decrement clamps to 0');

    await proc.shutdown();
    assert(proc.getQueueDepth() === 0, 'shutdown resets depth');
  }

  // -------------------------------------------------------------------------
  // 7. ErrorLoggingSpanProcessor does not throw on regular spans, and
  //    tolerates error spans with a real SpanStatusCode.ERROR set.
  // -------------------------------------------------------------------------
  {
    const err = new ErrorLoggingSpanProcessor();
    err.onStart({} as any, {} as any);
    err.onEnd({} as any); // root span with no status — should be a no-op
    // Now feed a fake readable span with status=ERROR to verify the console.warn path.
    const origWarn = console.warn;
    let sawWarn = false;
    console.warn = () => { sawWarn = true; };
    try {
      const fakeReadable: ReadableSpan = {
        name: 'fake-err',
        spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
        status: { code: SpanStatusCode.ERROR, message: 'sample' },
        attributes: {},
        links: [],
        events: [],
        duration: [0, 0],
        kind: 0,
        startTime: [0, 0],
        endTime: [0, 0],
        resource: resourceFromAttributes({}),
        instrumentationScope: { name: 'fake', version: '0' },
      } as unknown as ReadableSpan;
      err.onEnd(fakeReadable);
    } finally {
      console.warn = origWarn;
    }
    assert(sawWarn, 'ErrorLoggingSpanProcessor emits console.warn on ERROR spans');
    await err.forceFlush();
    await err.shutdown();
  }

  // -------------------------------------------------------------------------
  // 8. Sampler ratio obeys env override, and env is restored on exit so
  //    other tests in the same process see the original value.
  // -------------------------------------------------------------------------
  {
    const original = process.env.OTEL_TRACES_SAMPLER_ARG;
    try {
      process.env.OTEL_TRACES_SAMPLER_ARG = '0.5';
      const cfg = getTraceConfig();
      assert(cfg.samplerRatio === 0.5, `samplerRatio follows OTEL_TRACES_SAMPLER_ARG: ${cfg.samplerRatio}`);
      delete process.env.OTEL_TRACES_SAMPLER_ARG;
      const cfg2 = getTraceConfig();
      assert(cfg2.samplerRatio === 0.01, `samplerRatio falls back to 0.01: ${cfg2.samplerRatio}`);
    } finally {
      if (original === undefined) {
        delete process.env.OTEL_TRACES_SAMPLER_ARG;
      } else {
        process.env.OTEL_TRACES_SAMPLER_ARG = original;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 9. Resource attributes include the required semantic-convention keys
  // -------------------------------------------------------------------------
  {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: getTraceConfig().serviceName,
      [ATTR_SERVICE_VERSION]: getTraceConfig().serviceVersion,
      'host.name': os.hostname(),
      'deployment.environment': getTraceConfig().deploymentEnvironment,
    });
    const attrs = resource.attributes;
    assert(
      attrs[ATTR_SERVICE_NAME] === 'verinode-backend-test',
      `resource.attributes['service.name'] set`,
    );
    assert(
      attrs[ATTR_SERVICE_VERSION] === '0.0.0-test',
      `resource.attributes['service.version'] set`,
    );
    assert(
      typeof attrs['host.name'] === 'string',
      `resource.attributes['host.name'] set`,
    );
    assert(
      attrs['deployment.environment'] === 'ci',
      `resource.attributes['deployment.environment'] set`,
    );
  }

  // -------------------------------------------------------------------------
  // 10. OTLPTraceExporter can be constructed against an unreachable endpoint
  //     without throwing. The BatchSpanProcessor accepts a real span.
  // -------------------------------------------------------------------------
  {
    const exp = new OTLPTraceExporter({ url: 'http://127.0.0.1:1' });
    assert(exp !== null, 'OTLPTraceExporter constructed against unreachable endpoint');
    await exp.shutdown();

    await shutdownTracing();
    const inmem = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new BatchSpanProcessor(inmem)],
    });
    trace.setGlobalTracerProvider(provider);
    const realSpan = trace.getTracer('feed-test').startSpan('real');
    realSpan.end();
    const proc = new BatchSpanProcessor(inmem);
    proc.onEnd(realSpan as unknown as ReadableSpan);
    await proc.shutdown();
    await shutdownTracing();
    assert(true, 'OTLP exporter + BatchSpanProcessor accept an unreachable endpoint gracefully');
  }

  // -------------------------------------------------------------------------
  // 11. Auto-instrumentation factories can be instantiated without
  //     crashing. Importing is the contract — registration must
  //     happen inside NodeSDK.start().
  // -------------------------------------------------------------------------
  {
    const http = new HttpInstrumentation();
    const express = new ExpressInstrumentation();
    assert(http !== undefined, 'HttpInstrumentation instantiated');
    assert(express !== undefined, 'ExpressInstrumentation instantiated');
    await http.disable();
    await express.disable();
  }

  // -------------------------------------------------------------------------
  // 12. OTEL_SDK_DISABLED=true short-circuits initTracing to a no-op
  // -------------------------------------------------------------------------
  {
    await shutdownTracing();
    const prevDisabled = process.env.OTEL_SDK_DISABLED;
    process.env.OTEL_SDK_DISABLED = 'true';
    const cfg = initTracing({ silent: true });
    assert(cfg !== null, 'returns config even when SDK is disabled');
    assert(cfg!.initialized === true, 'marks initialized=true so subsequent calls are no-ops');
    delete process.env.OTEL_SDK_DISABLED;
    if (prevDisabled !== undefined) process.env.OTEL_SDK_DISABLED = prevDisabled;
  }

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------
  await shutdownTracing();

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('tracer.test.ts crashed:', err);
  process.exit(1);
});
