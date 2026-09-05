import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  message?: string;
  meta?: unknown;
}

/**
 * Wraps every successful response in the one envelope the frontend unwraps.
 *
 * Two shapes pass through untouched:
 *   • a handler that already returned `{ success, data }` — paginated list
 *     endpoints build their own envelope so they can attach `meta`;
 *   • a StreamableFile or anything non-JSON, which must not be re-serialised.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiEnvelope<T> | T
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiEnvelope<T> | T> {
    return next.handle().pipe(
      map((data) => {
        if (data && typeof data === 'object' && 'success' in (data as object)) {
          return data;
        }
        return { success: true as const, data };
      }),
    );
  }
}
