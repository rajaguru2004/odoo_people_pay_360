import { Injectable, NestMiddleware } from '@nestjs/common';
import { runWithBranchStore } from './branch-context';

/**
 * Seeds an empty, mutable branch store into AsyncLocalStorage for the whole
 * request. Runs before guards/interceptors; the BranchContextInterceptor fills
 * it once `req.user` is available. Everything downstream (services, the Prisma
 * `$use` middleware) reads the same store via getBranchContext().
 */
@Injectable()
export class BranchContextMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: (err?: unknown) => void): void {
    runWithBranchStore(() => next());
  }
}
