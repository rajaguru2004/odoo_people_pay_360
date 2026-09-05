/**
 * Finance's own error payloads, read through the shape the interceptor rejects with.
 *
 * `utils/apiError.test.ts` owns the general contract — that `lib/axios.ts`
 * rejects with a FLAT object, that `err.response.data.message` is therefore
 * undefined, and that a caller's fallback string must never win over a sentence
 * the server actually sent. That file is about the ONE-sentence read.
 *
 * This one is about the other read, the one Finance depends on and nothing else
 * in the app does: `apiErrorBody(err)?.errors`, the per-FIELD map. Bank details
 * are the only place where the server's refusal is a dictionary rather than a
 * sentence, because a bank rejects an entire wage file over one mistyped digit
 * and "which field" is the whole content of the refusal. `errors` lives on the
 * response BODY, which the flat rejection carries under `details` — so a caller
 * reading `err.response.data.errors` gets undefined and shows "Failed to
 * migrate" to somebody who mistyped a single character in an IBAN.
 *
 * Three payload shapes reach these screens and each is read differently:
 * a structured 400 with `errors`, a Nest array `message` from class-validator,
 * and a bare string from something that never touched the interceptor at all.
 */
import { describe, it, expect } from 'vitest';
import { apiErrorMessage, apiErrorBody } from './apiError';

/**
 * Exactly what `lib/axios.ts` builds on the rejection path. `message` copies the
 * body's own message through `||`, so an ARRAY message survives as an array —
 * which is why the two functions below can disagree about what `message` is.
 */
function rejectedWith(
  statusCode: number,
  body: Record<string, unknown> | null,
  path = '/bank-change-requests/migration',
): Record<string, unknown> {
  return {
    success: false,
    statusCode,
    message: body?.message ?? 'An error occurred',
    timestamp: '2026-08-16T00:00:00.000Z',
    path,
    errors: body?.errors ?? null,
    details: body,
  };
}

/** The real 400 from `BankChangeService.validateAgainstConfig`. */
const IBAN_CHECK_DIGITS =
  'IBAN check digits are invalid — a character is mistyped or transposed';

describe('a structured 400 — the refusal that names a field', () => {
  it('hands the per-field map back intact, which is what the migration screen shows', () => {
    // The screen does not want "Bank details validation failed". It wants the
    // sentence beside `iban`, because that is the one the user can act on.
    const err = rejectedWith(400, {
      message: 'Bank details validation failed',
      errors: { iban: IBAN_CHECK_DIGITS },
    });

    expect(
      apiErrorBody<{ errors?: Record<string, string> }>(err)?.errors,
      'the field map must survive the flattening, under `details`',
    ).toEqual({ iban: IBAN_CHECK_DIGITS });
  });

  it('is invisible to the access path an axios tutorial would use', () => {
    // Pinned as a counter-example. This is the read that produced "Failed to
    // migrate": correct against a real AxiosError, undefined against ours.
    const err = rejectedWith(400, {
      message: 'Bank details validation failed',
      errors: { iban: IBAN_CHECK_DIGITS },
    });

    expect(
      (err as { response?: { data?: { errors?: unknown } } }).response?.data?.errors,
      'there is no `.response` on the flat rejection — this is the trap',
    ).toBeUndefined();
  });

  it('keeps every field when more than one is wrong, so none is hidden', () => {
    // A migration row posts three or four fields at once and the server answers
    // about all of them. Surfacing only the first would send the user back for
    // a second round trip to be told about the second.
    const err = rejectedWith(400, {
      message: 'Bank details validation failed',
      errors: {
        iban: IBAN_CHECK_DIGITS,
        accountHolderName: 'Account Holder Name is required',
      },
    });

    const errors = apiErrorBody<{ errors: Record<string, string> }>(err)!.errors;
    expect(Object.keys(errors), 'both refused fields must be present').toEqual([
      'iban',
      'accountHolderName',
    ]);

    expect(
      apiErrorMessage(err, 'Failed to migrate'),
      'the sentence form names each field alongside the summary',
    ).toBe(
      `Bank details validation failed — iban: ${IBAN_CHECK_DIGITS}; accountHolderName: Account Holder Name is required`,
    );
  });

  it('reports no field map when the refusal is about the request rather than a value', () => {
    // The payroll-lock conflict is a whole-request refusal: there is nothing to
    // point at on the form, so the screen must fall through to the sentence.
    const err = rejectedWith(409, {
      message: 'Bank details are locked while a payroll run is in progress',
    });

    expect(
      apiErrorBody<{ errors?: Record<string, string> }>(err)?.errors,
      'a conflict carries no per-field map',
    ).toBeUndefined();
    expect(apiErrorMessage(err, 'Failed to migrate')).toBe(
      'Bank details are locked while a payroll run is in progress',
    );
  });
});

describe('a Nest array message — several constraints at once', () => {
  it('reads as one sentence, while the body still carries all of them', () => {
    // `apiErrorMessage` folding an array into its first usable string is the
    // general contract and belongs to `apiError.test.ts`. What matters HERE is
    // that folding is a presentation choice and not a loss: the untouched array
    // is still on the body for any caller that wants to list every constraint.
    const err = rejectedWith(
      400,
      {
        message: [
          'amount must be a positive number',
          'expenseDate must be a valid ISO 8601 date string',
          'type should not be empty',
        ],
      },
      '/reimbursements',
    );

    expect(
      apiErrorMessage(err, 'Failed to create request'),
      'one readable sentence, never a comma-mashed blob',
    ).toBe('amount must be a positive number');

    expect(
      apiErrorBody<{ message: string[] }>(err)?.message,
      'every constraint is still available to a caller that wants them all',
    ).toHaveLength(3);
  });

  it('does not mistake an array message for a field map', () => {
    // `errors` is null on this shape. A screen keying on `errors` must not read
    // the array as a dictionary and render "0: amount must be…".
    const err = rejectedWith(400, {
      message: ['amount must be a positive number'],
    });

    expect(
      apiErrorBody<{ errors?: unknown }>(err)?.errors,
      'a constraint list is not a per-field map',
    ).toBeUndefined();
  });
});

describe('a bare string — nothing that reached the interceptor', () => {
  it('is passed through as the message', () => {
    // Thrown by hand, or re-raised from a caught rejection. The user still gets
    // words rather than the caller's fallback.
    expect(apiErrorMessage('Select a bank before migrating', 'Failed to migrate')).toBe(
      'Select a bank before migrating',
    );
  });

  it('carries no body, so a field-level reader falls through to the sentence', () => {
    // This is the branch that makes `errs && Object.keys(errs).length` safe on
    // the migration screen: no body means no `.errors`, not a crash.
    expect(
      apiErrorBody('Select a bank before migrating'),
      'a string has no response body behind it',
    ).toBeNull();
  });
});

describe('a rejection with no body at all — a timeout or a dead connection', () => {
  it('falls back to the caller’s words, because the server said nothing', () => {
    // `error.response` is undefined on a network failure, so `details` is null.
    const err = rejectedWith(500, null);

    expect(apiErrorBody(err), 'nothing to read a field map out of').toBeNull();
    expect(
      apiErrorMessage(err, 'Failed to migrate'),
      'only here is the generic fallback the correct answer',
    ).toBe('An error occurred');
  });
});
