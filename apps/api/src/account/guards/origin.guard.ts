import {
  HttpException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../../tokens.js';

/**
 * Origin check for state-changing account requests (task book §7).
 *
 * SameSite=Lax already stops cross-site cookies from being sent on most
 * requests, but the Origin header is the authoritative cross-origin signal:
 * when a browser sends one that is not in the configured allow-list the
 * request is rejected with 403 FORBIDDEN. Requests WITHOUT an Origin header
 * (CLI, curl, server-to-server) are not browser-origin requests and pass —
 * they carry no ambient credentials.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const origin = request.headers['origin'];
    if (origin === undefined) {
      return true;
    }
    if (typeof origin === 'string' && this.config.corsOrigins.includes(origin)) {
      return true;
    }
    throw new HttpException({ code: 'FORBIDDEN', message: 'Origin not allowed' }, 403);
  }
}
