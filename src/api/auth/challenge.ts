import { Request, Response } from 'express';
import { NonceStore } from './nonce_store';
import { AuthConfig, generateServerNonce } from './config';

export function createChallengeHandler(nonceStore: NonceStore, config: AuthConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const nonce = generateServerNonce();
    const nonceHex = nonce.toString('hex');
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const userAgent = (req.headers['user-agent'] ?? 'unknown') as string;

    await nonceStore.setChallenge(nonceHex, {
      nonceHex,
      ip,
      userAgent,
      expiresAt: Date.now() + config.challengeTtlMs,
    }, config.challengeTtlMs);

    res.json({
      nonce: nonce.toString('base64'),
      serverId: config.serverId,
    });
  };
}
