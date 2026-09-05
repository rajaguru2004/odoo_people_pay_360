import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  getBranchEnforcement,
  runWithBranchBypass,
  setBranchContext,
} from './branch-context';
import { resolveBranchContext } from './branch-scope.util';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Resolves the effective branch context after authentication (per-controller
 * JwtAuthGuard has already set `req.user`) and stores it for the request.
 *
 * Runs as a global interceptor — no change to existing controllers/guards.
 * A branch requested outside the caller's envelope is a cross-branch attempt:
 * logged always, and rejected (403) when enforcement is `on`.
 */
@Injectable()
export class BranchContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger('BranchContext');

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    const user = req?.user;

    // Unauthenticated / public route → no branch scope (fail-open only for
    // routes that carry no principal; scoped models still passthrough safely).
    if (!user) {
      setBranchContext(null);
      return next.handle();
    }

    const header = req.headers?.['x-branch-id'];
    const requested = Array.isArray(header) ? header[0] : header;
    const { ctx, crossBranchAttempt } = resolveBranchContext(user, requested);
    const mode = getBranchEnforcement();

    if (crossBranchAttempt) {
      this.logger.warn(
        `cross-branch attempt user=${user.id ?? '?'} role=${user.role ?? '?'} ` +
          `requested=${crossBranchAttempt.requested} ` +
          `accessible=[${crossBranchAttempt.accessible.join(',')}] ` +
          `path="${req.method} ${req.originalUrl ?? req.url}" mode=${mode}`,
      );
      req.crossBranchAttempt = crossBranchAttempt; // consumed by audit (Phase 5)
      // High-signal security telemetry: persist the denied attempt (best-effort,
      // unscoped, non-blocking) in every enforcement mode.
      void this.recordDenial(req, user, crossBranchAttempt.requested);
      if (mode === 'on') {
        throw new ForbiddenException('You do not have access to the selected branch.');
      }
    }

    setBranchContext(mode === 'off' ? null : ctx);
    req.branchContext = ctx;
    return next.handle();
  }

  /** Persist a cross-branch access attempt as an ACCESS_DENIED audit row. */
  private async recordDenial(
    req: any,
    user: { id?: string },
    requestedBranchId: string,
  ): Promise<void> {
    try {
      await runWithBranchBypass(() =>
        this.prisma.auditLog.create({
          data: {
            userId: user?.id ?? null,
            action: 'ACCESS_DENIED',
            resourceType: 'Branch',
            // requestedBranchId is client-supplied (may be a non-UUID) — keep it
            // out of the UUID columns so the row always persists.
            newData: {
              reason: 'cross-branch-access',
              requestedBranchId,
              path: `${req.method} ${req.originalUrl ?? req.url}`,
            },
            ipAddress: req.ip ?? null,
            userAgent: req.headers?.['user-agent'] ?? null,
          },
        }),
      );
    } catch (err) {
      this.logger.error(`Failed to record branch denial: ${(err as Error).message}`);
    }
  }
}
