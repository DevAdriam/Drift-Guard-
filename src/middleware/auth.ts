import type { Request, Response, NextFunction } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { adminAuth } from '../lib/firebase-admin.ts';
import { getOrCreateUser } from '../db/users.ts';
import { verifyDemoSessionToken } from '../server/demoWorkspace.ts';

export interface AuthRequest extends Request {
  user?: Pick<DecodedIdToken, 'uid' | 'email'> & { name?: string };
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing bearer token' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Empty bearer token' });
    return;
  }

  // Allow cryptographically verified Demo Workspace sessions (strictly isolated to demo_driftguard_workspace)
  const demoUser = verifyDemoSessionToken(token);
  if (demoUser) {
    req.user = {
      uid: demoUser.uid,
      email: demoUser.email,
      name: demoUser.name,
    };
    await getOrCreateUser(demoUser.uid, demoUser.email, demoUser.name);
    next();
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    req.user = decodedToken;
    await getOrCreateUser(
      decodedToken.uid,
      decodedToken.email ?? `${decodedToken.uid}@users.local`,
      typeof decodedToken.name === 'string' ? decodedToken.name : null
    );
    next();
  } catch (error) {
    console.error('Error verifying Firebase ID token:', error);
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};
