/**
 * Mapping server validation errors onto form fields.
 *
 * This exists because of a shape mismatch that is invisible at the call site:
 * the axios interceptor copies the response body's `errors` map onto a FLAT
 * rejection object, so the `e.response.data.errors` written all over this
 * codebase evaluates to `undefined` and every precise per-field reason collapses
 * into one generic toast. The reader has to know that to get it right, which is
 * exactly the kind of knowledge that belongs in a test rather than in someone's
 * head.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyServerErrors } from './applyServerErrors';

const setError = () => vi.fn();

describe('applyServerErrors', () => {
  it('reads the flat `errors` map the interceptor actually produces', () => {
    // NOT error.response.data.errors — that path is always undefined here.
    const fn = setError();
    const attached = applyServerErrors(
      { errors: { phone: 'Invalid phone' } } as any,
      fn as any,
    );
    expect(attached).toBe(true);
    expect(fn).toHaveBeenCalledWith(
      'phone',
      expect.objectContaining({ message: 'Invalid phone' }),
      expect.anything(),
    );
  });

  it('falls back to a nested details.errors', () => {
    const fn = setError();
    expect(
      applyServerErrors(
        { details: { errors: { phone: 'Invalid phone' } } } as any,
        fn as any,
      ),
    ).toBe(true);
    expect(fn).toHaveBeenCalled();
  });

  it('keeps a dotted custom-field path intact', () => {
    // 'customFields.grade' is the RHF name for a JSONB field. Rewriting or
    // splitting it would attach the error to nothing and the control would look
    // valid while the save kept failing.
    const fn = setError();
    applyServerErrors(
      { errors: { 'customFields.grade': 'Invalid format' } } as any,
      fn as any,
    );
    expect(fn).toHaveBeenCalledWith(
      'customFields.grade',
      expect.objectContaining({ message: 'Invalid format' }),
      expect.anything(),
    );
  });

  it('attaches every error, not just the first', () => {
    const fn = setError();
    applyServerErrors(
      { errors: { phone: 'bad', email: 'also bad', address: 'nope' } } as any,
      fn as any,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('focuses only the first field', () => {
    // Focusing each in turn would leave the cursor on the last one, which is
    // the least likely to be what the user should fix first.
    const fn = setError();
    applyServerErrors(
      { errors: { phone: 'bad', email: 'also bad' } } as any,
      fn as any,
    );
    const focusFlags = fn.mock.calls.map((c: any[]) => c[2]?.shouldFocus);
    expect(focusFlags.filter(Boolean)).toHaveLength(1);
    expect(focusFlags[0]).toBe(true);
  });

  it('returns false when there is no field map to attach', () => {
    // The caller uses the return value to decide whether to show a banner
    // instead. Returning true here would swallow the only feedback the user gets.
    for (const input of [
      null,
      undefined,
      'a string',
      {},
      { message: 'Something failed' },
    ]) {
      expect(applyServerErrors(input as any, setError() as any)).toBe(false);
    }
  });

  it('returns false for a NestJS ValidationPipe array', () => {
    // Those carry `message` as a string[] and no field map, so there is nothing
    // to attach — the caller must fall through to the toast.
    const fn = setError();
    expect(
      applyServerErrors(
        { message: ['phone must be a string', 'email must be an email'] } as any,
        fn as any,
      ),
    ).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores an errors array rather than treating it as a map', () => {
    expect(
      applyServerErrors({ errors: ['a', 'b'] } as any, setError() as any),
    ).toBe(false);
  });
});
