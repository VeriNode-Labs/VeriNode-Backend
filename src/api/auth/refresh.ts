import { Request, Response } from 'express';
import { NonceStore, hashToken, generateToken } from './nonce_store';
import { JwtManager } from './jwt_manager';
import { AuthConfig } from './config';

export function createRefreshHandler(nonceStore: NonceStore, jwtManager: JwtManager, config: AuthConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = req.body as { refreshToken?: string };

    if (!refreshToken) {
      res.status(400).json({ error: 'Missing required field: refreshToken' });
      return;
    }

    let payload;
    try {
      payload = jwtManager.verifyRefreshToken(refreshToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    const tokenHash = hashToken(refreshToken);
    const hashExists = await nonceStore.hasRefreshTokenHash(tokenHash);
    if (!hashExists) {
      res.status(401).json({ error: 'Refresh token has been revoked or already used' });
      return;
    }

    await nonceStore.deleteRefreshTokenHash(tokenHash);

    const newRefreshJti = generateToken();
    const newAccessToken = jwtManager.signAccessToken(payload.nodeId, payload.sub, config.accessTokenTtlMs);
    const newRefreshToken = jwtManager.signRefreshToken(payload.nodeId, payload.sub, newRefreshJti, config.refreshTokenTtlMs);

    await nonceStore.setRefreshTokenHash(
      hashToken(newRefreshToken),
      config.refreshTokenTtlMs,
    );

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiresAt: Date.now() + config.accessTokenTtlMs,
      refreshTokenExpiresAt: Date.now() + config.refreshTokenTtlMs,
      nodeId: payload.nodeId,
    });
  };
}
