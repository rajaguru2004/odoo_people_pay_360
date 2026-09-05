import { describe, expect, it } from 'vitest';
import { apiErrorMessage, apiFieldErrors } from './apiError';

describe('apiErrorMessage', () => {
  it('reads the FLAT shape the axios interceptor rejects with', () => {
    expect(apiErrorMessage({ message: 'Employee code EMP-1 is already in use' })).toBe(
      'Employee code EMP-1 is already in use',
    );
  });

  it('reads a raw AxiosError that bypassed the instance', () => {
    expect(apiErrorMessage({ response: { data: { message: 'Forbidden' } } })).toBe('Forbidden');
  });

  it('prefers the backend message over a generic axios one', () => {
    const err = { message: 'Request failed with status code 409', response: { data: { message: 'Already exists' } } };
    expect(apiErrorMessage(err)).toBe('Already exists');
  });

  it('accepts a bare string', () => {
    expect(apiErrorMessage('boom')).toBe('boom');
  });

  it('falls back when there is nothing to read', () => {
    expect(apiErrorMessage(null)).toBe('Something went wrong');
    expect(apiErrorMessage({}, 'Could not save')).toBe('Could not save');
  });
});

describe('apiFieldErrors', () => {
  it('returns the validation messages array', () => {
    expect(apiFieldErrors({ errors: ['email must be an email'] })).toEqual(['email must be an email']);
  });

  it('returns empty for anything else', () => {
    expect(apiFieldErrors({ errors: { email: 'bad' } })).toEqual([]);
    expect(apiFieldErrors(undefined)).toEqual([]);
  });
});
