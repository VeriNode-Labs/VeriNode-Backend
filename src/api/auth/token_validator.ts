import { Request, Response, NextFunction } from 'express';

export function validateNodeToken(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    const nodeIdHeader = req.headers['x-node-id'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    if (!nodeIdHeader || typeof nodeIdHeader !== 'string') {
        return res.status(403).json({ error: 'Missing hardware node identity header from gateway' });
    }

    const token = authHeader.split(' ')[1];

    try {
        // Example mock verification logic (would normally use jsonwebtoken and a shared secret or public key)
        // const decoded = jwt.verify(token, process.env.JWT_SECRET);
        // if (decoded.nodeId !== nodeIdHeader) { ... }
        
        // For demonstration, assuming token verification logic is handled and we ensure 
        // the node identity claimed in the token matches the mTLS validated X-Node-ID.
        req.user = {
            nodeId: nodeIdHeader,
            // ...other token claims
        };
        
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
