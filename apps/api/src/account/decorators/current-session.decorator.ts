import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedSession } from '../services/session.service.js';

/**
 * Parameter decorator for the session the SessionAuthGuard resolved — usable
 * only on routes behind that guard. The guard attached the session to the
 * request; this reads it back, keeping controllers free of cookie/digest
 * plumbing.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedSession => {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { currentSession?: AuthenticatedSession }>();
    const session = request.currentSession;
    if (session === undefined) {
      throw new Error('CurrentSession used outside a SessionAuthGuard-protected route');
    }
    return session;
  },
);
