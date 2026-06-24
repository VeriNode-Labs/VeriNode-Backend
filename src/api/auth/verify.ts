import { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { NonceStore, hashToken, generateToken } from './nonce_store';
import { JwtManager } from './jwt_manager';
import { AuthConfig } from './config';
import * as stellarSdk from '@stellar/stellar-sdk';

export function createVerifyHandler(nonceStore: NonceStore, jwtManager: JwtManager, config: AuthConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const { nonce, publicKey, signature } = req.body as {
      nonce?: string;
      publicKey?: string;
      signature?: string;
    };

    if (!nonce || !publicKey || !signature) {
      res.status(400).json({ error: 'Missing required fields: nonce, publicKey, signature' });
      return;
    }

    const nonceHex = Buffer.from(nonce, 'base64').toString('hex');
    const challenge = await nonceStore.getChallenge(nonceHex);
    if (!challenge) {
      res.status(401).json({ error: 'Invalid or expired nonce' });
      return;
    }

    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (challenge.ip !== clientIp) {
      res.status(401).json({ error: 'IP address mismatch' });
      return;
    }

    if (!stellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      res.status(400).json({ error: 'Invalid Stellar public key format' });
      return;
    }

    const message = createHash('sha256')
      .update(Buffer.concat([Buffer.from(nonceHex, 'hex'), Buffer.from(config.serverId)]))
      .digest();

    const signatureBuf = Buffer.from(signature, 'base64');
    if (signatureBuf.length !== 64) {
      res.status(400).json({ error: 'Invalid signature length' });
      return;
    }

    const keypair = stellarSdk.Keypair.fromPublicKey(publicKey);
    const isValid = keypair.verify(message, signatureBuf);

    if (!isValid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    await nonceStore.deleteChallenge(nonceHex);

    const nodeId = publicKey;
    const refreshJti = generateToken();
    const accessToken = jwtManager.signAccessToken(nodeId, publicKey, config.accessTokenTtlMs);
    const refreshToken = jwtManager.signRefreshToken(nodeId, publicKey, refreshJti, config.refreshTokenTtlMs);

    await nonceStore.setRefreshTokenHash(
      hashToken(refreshToken),
      config.refreshTokenTtlMs,
    );

    res.json({
      accessToken,
      refreshToken,
      accessTokenExpiresAt: Date.now() + config.accessTokenTtlMs,
      refreshTokenExpiresAt: Date.now() + config.refreshTokenTtlMs,
      nodeId,
    });
  };
}
