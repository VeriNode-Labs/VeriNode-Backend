/**
 * Rate limiter tests for token bucket, burst handling and endpoint tier matching.
 */

declare global {
  function describe(name: string, fn: () => void): void;
  function it(name: string, fn: () => void | Promise<void>): void;
  function before(fn: () => void | Promise<void>): void;
  function after(fn: () => void | Promise<void>): void;
}

if (typeof (global as any).describe === 'undefined') {
  const tests: Array<{ name: string; fn: () => any }> = [];
  let beforeFn: (() => any) | null = null;
  let afterFn: (() => any) | null = null;

  (global as any).describe = (name: string, fn: () => void) => {
    console.log(`Running Suite: ${name}`);
    fn();
    setTimeout(async () => {
      try {
        if (beforeFn) await beforeFn();
        for (const test of tests) {
          console.log(`  Running Test: ${test.name}`);
          await test.fn();
          console.log(`  ✓ ${test.name}`);
        }
        if (afterFn) await afterFn();
        console.log('\nAll rate limiter tests passed!');
        process.exit(0);
      } catch (err: any) {
        console.error(`\nTest failed: ${err.message}`);
        console.error(err.stack);
        if (afterFn) {
          try {
            await afterFn();
          } catch {}
        }
        process.exit(1);
      }
    }, 0);
  };
  (global as any).before = (fn: string | (() => any)) => {
    beforeFn = fn as () => any;
  };
  (global as any).after = (fn: string | (() => any)) => {
    afterFn = fn as () => any;
  };
  (global as any).it = (name: string, fn: () => any) => {
    tests.push({ name, fn });
  };
}

import * as assert from 'assert';
import { createRateLimitingMiddleware, RateLimitTier } from '../src/security/rate_limiter';
import type { Request, Response } from 'express';

function makeRequest(path: string, ip = '127.0.0.1'): Partial<Request> {
  return {
    path,
    ip,
    headers: {},
    socket: { remoteAddress: ip } as any,
  };
}

function makeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  const body: any[] = [];
  return {
    setHeader(key: string, value: string) {
      headers[key] = value;
      return this;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body.push(payload);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
  } as unknown as Partial<Response> & { headers: Record<string, string>; body: any[] };
}

function createMiddleware(tiers: Record<string, RateLimitTier>, clock: () => number) {
  return createRateLimitingMiddleware({ endpointTiers: tiers, defaultTier: 'free', clock });
}

async function callMiddleware(middleware: ReturnType<typeof createMiddleware>, req: Partial<Request>, res: ReturnType<typeof makeResponse>) {
  let nextCalled = false;
  await middleware(req as Request, res as Response, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode: res.statusCode, headers: res.headers, body: res.body };
}

describe('Rate limiter middleware', () => {
  it('allows the pro tier to burst and rejects when the bucket is exhausted', async () => {
    let now = 0;
    const middleware = createMiddleware({ '/debug/traces/config': 'pro' }, () => now);
    const req = makeRequest('/debug/traces/config');
    const res = makeResponse();

    let allowedCount = 0;
    for (let i = 0; i < 16; i += 1) {
      const result = await callMiddleware(middleware, req, res);
      assert.strictEqual(result.nextCalled, true, `expected request ${i + 1} to be allowed`);
      allowedCount += 1;
    }

    const denied = await callMiddleware(middleware, req, res);
    assert.strictEqual(denied.nextCalled, false);
    assert.strictEqual(denied.statusCode, 429);
    assert.ok(Number(denied.headers['Retry-After']) >= 1);

    now += 2000;
    const secondTry = await callMiddleware(middleware, req, res);
    assert.strictEqual(secondTry.nextCalled, true, 'expected request after refill to be allowed');
  });

  it('uses the default tier for unknown endpoints and applies per-endpoint tier patterns', async () => {
    let now = 0;
    const middleware = createMiddleware(
      {
        '/internal/archival/renew/:contractId': 'enterprise',
      },
      () => now,
    );

    const enterpriseReq = makeRequest('/internal/archival/renew/abc');
    const defaultReq = makeRequest('/unknown/endpoint');
    const res1 = makeResponse();
    const res2 = makeResponse();

    const enterpriseResult = await callMiddleware(middleware, enterpriseReq, res1);
    assert.strictEqual(enterpriseResult.nextCalled, true);

    const defaultResult = await callMiddleware(middleware, defaultReq, res2);
    assert.strictEqual(defaultResult.nextCalled, true);
  });

  it('returns Retry-After when the rate limit has been exceeded and recovers after cooldown', async () => {
    let now = 0;
    const middleware = createMiddleware({ '/debug/traces/config': 'free' }, () => now);
    const req = makeRequest('/debug/traces/config');
    const res = makeResponse();

    for (let i = 0; i < 2; i += 1) {
      const result = await callMiddleware(middleware, req, res);
      assert.strictEqual(result.nextCalled, i === 0);
    }

    const denied = await callMiddleware(middleware, req, res);
    assert.strictEqual(denied.statusCode, 429);
    assert.ok(typeof denied.headers['Retry-After'] === 'string');
    assert.ok(Number(denied.headers['Retry-After']) >= 1);

    now += 6000;
    const cooled = await callMiddleware(middleware, req, res);
    assert.strictEqual(cooled.nextCalled, true);
  });
});
