import { createHash } from 'node:crypto';
import * as http from 'http';
import express from 'express';

// Load auth modules dynamically after setting env vars
let router: any;
let jwtManager: any;
let createSessionMiddleware: any;
let config: any;

function loadAuth() {
  const mod = require('../src/api/auth');
  const sessionMod = require('../src/api/auth/session');
  router = mod.router;
  jwtManager = mod.jwtManager;
  config = mod.config;
  createSessionMiddleware = sessionMod.createSessionMiddleware;
}

function createTestApp(): express.Express {
  const app = express();
  app.use('/api/v1/auth', express.json(), router);
  return app;
}

async function makeRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const opts: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      };
      const req = http.request(opts, (res) => {
        let bodyStr = '';
        res.on('data', (chunk) => { bodyStr += chunk; });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(bodyStr) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: bodyStr });
          }
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

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

  console.log('\nWallet Auth Flow Tests\n');

  const stellarSdk = require('@stellar/stellar-sdk');
  const keypair = stellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();
  const app = createTestApp();

  // ---- Test 1: Challenge endpoint returns nonce and serverId ----
  {
    const { status, data } = await makeRequest(app, 'POST', '/api/v1/auth/challenge');
    const d = data as Record<string, unknown>;
    assert(status === 200, 'challenge returns 200');
    assert(typeof d.nonce === 'string' && d.nonce.length > 0, 'challenge returns nonce string');
    assert(d.serverId === 'VeriNode-Backend', 'challenge returns correct serverId');
  }

  // ---- Test 2: Challenge -> Verify full flow succeeds ----
  {
    const { data: challengeData } = await makeRequest(app, 'POST', '/api/v1/auth/challenge');
    const { nonce } = challengeData as { nonce: string };

    const rawNonce = Buffer.from(nonce, 'base64');
    const message = createHash('sha256').update(Buffer.concat([rawNonce, Buffer.from('VeriNode-Backend')])).digest();
    const signature = keypair.sign(message);
    const signatureBase64 = signature.toString('base64');

    const { status, data } = await makeRequest(app, 'POST', '/api/v1/auth/verify', {
      nonce,
      publicKey,
      signature: signatureBase64,
    });
    const d = data as Record<string, unknown>;
    assert(status === 200, 'verify returns 200 on valid challenge');
    assert(typeof d.accessToken === 'string', 'verify returns accessToken');
    assert(typeof d.refreshToken === 'string', 'verify returns refreshToken');
    assert(typeof d.nodeId === 'string', 'verify returns nodeId');
    assert(d.nodeId === publicKey, 'nodeId matches publicKey');
  }

  // ---- Test 3: Reusing a nonce fails (replay protection) ----
  {
    const { data: challengeData } = await makeRequest(app, 'POST', '/api/v1/auth/challenge');
    const { nonce } = challengeData as { nonce: string };

    const rawNonce = Buffer.from(nonce, 'base64');
    const message = createHash('sha256').update(Buffer.concat([rawNonce, Buffer.from('VeriNode-Backend')])).digest();
    const signature = keypair.sign(message);
    const signatureBase64 = signature.toString('base64');

    await makeRequest(app, 'POST', '/api/v1/auth/verify', {
      nonce, publicKey, signature: signatureBase64,
    });

    const { status } = await makeRequest(app, 'POST', '/api/v1/auth/verify', {
      nonce, publicKey, signature: signatureBase64,
    });
    assert(status === 401, 'reused nonce returns 401');
  }

  // ---- Test 4: Invalid signature returns 401 ----
  {
    const { data: challengeData } = await makeRequest(app, 'POST', '/api/v1/auth/challenge');
    const { nonce } = challengeData as { nonce: string };

    const { status } = await makeRequest(app, 'POST', '/api/v1/auth/verify', {
      nonce,
      publicKey,
      signature: Buffer.alloc(64).toString('base64'),
    });
    assert(status === 401, 'invalid signature returns 401');
  }

  // ---- Test 5: Missing fields return 400 ----
  {
    const { status } = await makeRequest(app, 'POST', '/api/v1/auth/verify', { nonce: 'test' });
    assert(status === 400, 'missing fields return 400');
  }

  // ---- Test 6: Invalid public key format returns 400 ----
  {
    const { data: challengeData } = await makeRequest(app, 'POST', '/api/v1/auth/challenge');
    const { nonce } = challengeData as { nonce: string };

    const { status } = await makeRequest(app, 'POST', '/api/v1/auth/verify', {
      nonce,
      publicKey: 'GABCDEF123',
      signature: Buffer.alloc(64).toString('base64'),
    });
    assert(status === 400, 'invalid public key returns 400');
  }

  // ---- Test 7: Access token authenticates session middleware ----
  {
    const { data: challengeData } = await makeRequest(app, 'POST', '/api/v1/auth/challenge');
    const { nonce } = challengeData as { nonce: string };

    const rawNonce = Buffer.from(nonce, 'base64');
    const message = createHash('sha256').update(Buffer.concat([rawNonce, Buffer.from('VeriNode-Backend')])).digest();
    const signature = keypair.sign(message);
    const { data: verifyData } = await makeRequest(app, 'POST', '/api/v1/auth/verify', {
      nonce, publicKey, signature: signature.toString('base64'),
    });
    const { accessToken } = verifyData as { accessToken: string };

    const protectedApp = express();
    const sessionMw = createSessionMiddleware(jwtManager);
    protectedApp.get('/protected', sessionMw, (req: any, res: any) => {
      res.json({ nodeId: req.nodeId, ok: true });
    });

    const { status, data } = await makeRequest(protectedApp, 'GET', '/protected', undefined, accessToken);
    const d = data as Record<string, unknown>;
    assert(status === 200, 'authenticated request returns 200');
    assert(d.nodeId === publicKey, 'session middleware extracts correct nodeId');
    assert(d.ok === true, 'session middleware allows request');
  }

  // ---- Test 8: Missing/invalid JWT returns 401 ----
  {
    const protectedApp = express();
    const sessionMw = createSessionMiddleware(jwtManager);
    protectedApp.get('/protected', sessionMw, (req: any, res: any) => {
      res.json({ ok: true });
    });

    const { status: noAuth } = await makeRequest(protectedApp, 'GET', '/protected');
    assert(noAuth === 401, 'no auth header returns 401');

    const { status: badToken } = await makeRequest(protectedApp, 'GET', '/protected', undefined, 'invalid-token');
    assert(badToken === 401, 'invalid token returns 401');
  }

  // ---- Test 9: Refresh token rotation ----
  {
    const { data: challengeData } = await makeRequest(app, 'POST', '/api/v1/auth/challenge');
    const { nonce } = challengeData as { nonce: string };

    const rawNonce = Buffer.from(nonce, 'base64');
    const message = createHash('sha256').update(Buffer.concat([rawNonce, Buffer.from('VeriNode-Backend')])).digest();
    const signature = keypair.sign(message);
    const { data: verifyData } = await makeRequest(app, 'POST', '/api/v1/auth/verify', {
      nonce, publicKey, signature: signature.toString('base64'),
    });
    const { refreshToken: firstRefresh } = verifyData as { refreshToken: string };

    const { status: refreshStatus, data: refreshData } = await makeRequest(app, 'POST', '/api/v1/auth/refresh', {
      refreshToken: firstRefresh,
    });
    const rd = refreshData as Record<string, unknown>;
    assert(refreshStatus === 200, 'refresh returns 200');
    assert(typeof rd.accessToken === 'string', 'refresh returns new accessToken');
    assert(typeof rd.refreshToken === 'string', 'refresh returns new refreshToken');

    const { status: reuseStatus } = await makeRequest(app, 'POST', '/api/v1/auth/refresh', {
      refreshToken: firstRefresh,
    });
    assert(reuseStatus === 401, 'reused refresh token returns 401');
  }

  // ---- Test 10: Missing refresh token returns 400 ----
  {
    const { status } = await makeRequest(app, 'POST', '/api/v1/auth/refresh', {});
    assert(status === 400, 'missing refreshToken returns 400');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

process.env.AUTH_CHALLENGE_RATE_LIMIT = '10000';
process.env.AUTH_VERIFY_RATE_LIMIT = '10000';
loadAuth();
main().catch((err) => {
  console.error('Auth test suite crashed:', err);
  process.exit(1);
});
