/**
 * Session resolution helper used by all authenticated routes.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { hashToken } from './auth.js';

const COOKIE_NAME = 'tw_session';

export interface SessionInfo {
  userId: string;
  orgId: string;
}

export function resolveSession(
  db: DatabaseSync,
  req: FastifyRequest,
  reply: FastifyReply,
): SessionInfo | null {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    reply.status(401).send({ error: 'Not authenticated' });
    return null;
  }
  const tokenHash = hashToken(token);
  const session = db
    .prepare('SELECT userId, orgId FROM sessions WHERE tokenHash = ? AND expiresAt > ?')
    .get(tokenHash, Date.now()) as SessionInfo | undefined;

  if (!session) {
    reply.status(401).send({ error: 'Session expired or invalid' });
    return null;
  }
  return session;
}
