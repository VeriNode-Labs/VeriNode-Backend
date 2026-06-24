import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import type { Algorithm, VerifyOptions, SignOptions } from 'jsonwebtoken';

export interface AccessTokenPayload {
  sub: string;
  nodeId: string;
  type: 'access';
  iat: number;
  exp: number;
}

export interface RefreshTokenPayload {
  sub: string;
  nodeId: string;
  type: 'refresh';
  iat: number;
  exp: number;
  jti: string;
}

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
};

const ALGORITHM: Algorithm = 'RS256';

export class JwtManager {
  private privateKeyPem: string;
  public publicKeyPem: string;

  constructor(privateKeyPem?: string, publicKeyPem?: string) {
    if (privateKeyPem && publicKeyPem) {
      this.privateKeyPem = privateKeyPem;
      this.publicKeyPem = publicKeyPem;
    } else {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      this.privateKeyPem = privateKey;
      this.publicKeyPem = publicKey;
    }
  }

  signAccessToken(nodeId: string, sub: string, ttlMs: number): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: AccessTokenPayload = {
      sub,
      nodeId,
      type: 'access',
      iat: now,
      exp: now + Math.floor(ttlMs / 1000),
    };
    const opts: SignOptions = { algorithm: ALGORITHM };
    return jwt.sign(payload as object, this.privateKeyPem, opts);
  }

  signRefreshToken(nodeId: string, sub: string, jti: string, ttlMs: number): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: RefreshTokenPayload = {
      sub,
      nodeId,
      type: 'refresh',
      iat: now,
      exp: now + Math.floor(ttlMs / 1000),
      jti,
    };
    const opts: SignOptions = { algorithm: ALGORITHM };
    return jwt.sign(payload as object, this.privateKeyPem, opts);
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    const opts: VerifyOptions = { algorithms: [ALGORITHM] };
    const payload = jwt.verify(token, this.publicKeyPem, opts) as jwt.JwtPayload;
    if (payload.type !== 'access') {
      throw new jwt.JsonWebTokenError('Invalid token type');
    }
    return payload as unknown as AccessTokenPayload;
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    const opts: VerifyOptions = { algorithms: [ALGORITHM] };
    const payload = jwt.verify(token, this.publicKeyPem, opts) as jwt.JwtPayload;
    if (payload.type !== 'refresh') {
      throw new jwt.JsonWebTokenError('Invalid token type');
    }
    return payload as unknown as RefreshTokenPayload;
  }
}
