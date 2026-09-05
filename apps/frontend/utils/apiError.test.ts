/**
 * Reading the server's explanation out of a rejected request.
 *
 * This is the regression guard for a whole CLASS of production bug, not a
 * single incident. `lib/axios.ts` rejects with a FLAT object — `{ success,
 * statusCode, message, errors, details }` — and NOT an AxiosError. So the
 * natural-looking `err.response?.data?.message` that reads correctly in every
 * axios tutorial evaluates to `undefined` here, the caller's fallback string
 * wins, and a precise backend refusal reaches the user as a shrug.
 *
 * That is exactly how "This payroll run is locked and can no longer be changed"
 * was shown in production as "The operation could not be completed". The backend
 * was right, had a test for it, and returned a good sentence; the frontend threw
 * it away.
 *
 * The first test below is written as the counter-example on purpose: it asserts
 * that the WRONG access path is undefined on the shape we really produce. If
 * someone ever changes the interceptor to reject with a real AxiosError, that
 * test fails and tells them to go and simplify the callers, rather than leaving
 * two shapes in play forever.
 */
import { describe, it, expect } from 'vitest';
import { apiErrorMessage, apiErrorStatus, apiErrorBody, apiFieldErrors } from './apiError';

/** Exactly what `lib/axios.ts` puts on the rejection path. */
function interceptorRejection(
  statusCode: number,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    success: false,
    statusCode,
    message: body.message ?? 'An error occurred',
    timestamp: new Date().toISOString(),
    path: '/payrolls/abc/items/def',
    errors: body.errors ?? null,
    details: body,
  };
}

describe('the shape our interceptor actually rejects with', () => {
  it('has no `.response`, which is why the tutorial access path silently fails', () => {
    const err: any = interceptorRejection(404, {
      message: 'Payroll item not found on this run',
    });

    // The bug, pinned. This is what the payroll screen used to read.
    expect(err?.response?.data?.message).toBeUndefined();

    // And this is what it reads now.
    expect(apiErrorMessage(err, 'The operation could not be completed')).toBe(
      'Payroll item not found on this run',
    );
  });
});

describe('apiErrorMessage', () => {
  it('surfaces the backend sentence instead of the fallback', () => {
    const cases: Array<[number, string]> = [
      [404, 'Payroll item not found on this run'],
      [400, 'This run is locked and cannot be recalculated'],
      [400, 'This request has not been approved yet'],
      [400, 'This termination request is already approved and can no longer be changed'],
      [
        409,
        'Payroll 8/2026 is in progress and already includes this employee. Lock or delete that run first.',
      ],
      [409, 'This record was modified by another operation. Reload and retry.'],
      [409, 'This payment has already been recorded (duplicate idempotency key).'],
      [
        400,
        'A garnishment of 5000 exceeds the attachable amount of 1500 for this period.',
      ],
      [
        400,
        'Net pay is 1500, above the rounding tolerance of 1. Correct the run instead of overriding it.',
      ],
      [400, 'Leave encashment of 9000 exceeds the accrued balance of 1500'],
      [400, 'Departure date must fall before the return date'],
      [400, 'Only a pending trip can be approved'],
      [400, 'This department still has employees and cannot be deleted'],
      [400, 'This contract is not on hold'],
      [
        403,
        'Your role is not permitted to perform this operation (allowed: ADMIN, HR_MANAGER)',
      ],
    ];

    for (const [status, message] of cases) {
      const err = interceptorRejection(status, { message });
      expect(apiErrorMessage(err, 'GENERIC FALLBACK')).toBe(message);
    }
  });

  it('folds class-validator arrays into one readable sentence', () => {
    // Nest sends `message` as an array when several constraints fail at once.
    const err = interceptorRejection(400, {
      message: ['installmentNo must be a positive number', 'reason should not be empty'],
    });
    expect(apiErrorMessage(err, 'GENERIC FALLBACK')).toBe(
      'installmentNo must be a positive number',
    );
  });

  it('appends field-level errors, because for a validation failure those ARE the reason', () => {
    const err = interceptorRejection(400, {
      message: 'Validation failed',
      errors: { amount: 'Amount must be greater than 0' },
    });
    expect(apiErrorMessage(err, 'GENERIC FALLBACK')).toBe(
      'Validation failed — amount: Amount must be greater than 0',
    );
  });

  it('still works on a raw AxiosError, for anything that bypasses the interceptor', () => {
    const err = {
      response: { status: 400, data: { message: 'Only pending requests can be cancelled' } },
    };
    expect(apiErrorMessage(err, 'GENERIC FALLBACK')).toBe(
      'Only pending requests can be cancelled',
    );
  });

  it('falls back only when the server genuinely said nothing', () => {
    expect(apiErrorMessage(null, 'Could not load this request')).toBe(
      'Could not load this request',
    );
    expect(apiErrorMessage({}, 'Could not load this request')).toBe(
      'Could not load this request',
    );
  });

  it('never renders [object Object] at a user', () => {
    const err = interceptorRejection(400, { message: { nested: 'thing' } });
    expect(apiErrorMessage(err, 'Safe fallback')).not.toContain('[object Object]');
  });
});

describe('apiErrorStatus / apiErrorBody', () => {
  it('reads the status off the flat shape so callers can branch 409 vs 400', () => {
    expect(apiErrorStatus(interceptorRejection(409, { message: 'x' }))).toBe(409);
    expect(apiErrorStatus({ response: { status: 404 } })).toBe(404);
    expect(apiErrorStatus(null)).toBeUndefined();
  });

  it('hands back the untouched body for endpoints that attach structured extras', () => {
    const body = { message: 'nope', preflight: { blocking: 2 } };
    expect(apiErrorBody(interceptorRejection(400, body))).toEqual(body);
  });
});

/**
 * Field-level errors live in two different places depending on who rejected:
 * the app's own interceptor puts them at the TOP level, a raw AxiosError puts
 * them under `response.data`. Reading only one is the same class of mistake as
 * reading `err.response.data.message` — right in a test, undefined in the app.
 */
describe('apiFieldErrors', () => {
  it('reads the flat shape this app actually rejects with', () => {
    expect(
      apiFieldErrors({ statusCode: 400, message: 'Invalid', errors: { iban: 'bad checksum' } }),
    ).toEqual({ iban: 'bad checksum' });
  });

  it('reads a raw AxiosError shape too', () => {
    expect(
      apiFieldErrors({ response: { data: { errors: { ifsc: 'unknown branch' } } } }),
    ).toEqual({ ifsc: 'unknown branch' });
  });

  it('reads the `details` envelope', () => {
    expect(apiFieldErrors({ details: { errors: { swift: 'wrong length' } } })).toEqual({
      swift: 'wrong length',
    });
  });

  it('answers null when there is nothing usable', () => {
    for (const input of [
      null,
      undefined,
      {},
      { errors: null },
      { errors: [] },
      { errors: 'not an object' },
      { errors: { iban: '' } },
      new Error('boom'),
    ]) {
      expect(apiFieldErrors(input)).toBeNull();
    }
  });

  it('drops non-string entries rather than rendering [object Object]', () => {
    expect(apiFieldErrors({ errors: { iban: 'bad', meta: { nested: true } } })).toEqual({
      iban: 'bad',
    });
  });
});
