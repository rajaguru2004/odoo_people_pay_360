import { describe, expect, it } from 'vitest';
import { isDeniedKey, pseudonymousId, scrubParams } from './params';

describe('isDeniedKey', () => {
  it.each([
    'email', 'employeeName', 'employee_name', 'fullName', 'netPay', 'net_pay',
    'basicSalary', 'amount', 'iban', 'accountNumber', 'passportNo', 'comment',
    'rejectedReason', 'searchQuery', 'employeeId', 'employee_id', 'id',
    'branchId', 'phone', 'dob',
  ])('denies %s', (key) => {
    expect(isDeniedKey(key)).toBe(true);
  });

  it.each([
    'module', 'screen', 'endpoint', 'method', 'status', 'outcome', 'user_role',
    'employee_count', 'page_path', 'branch_access', 'payroll_stage', 'leave_type',
  ])('allows %s', (key) => {
    expect(isDeniedKey(key)).toBe(false);
  });
});

describe('scrubParams', () => {
  it('keeps safe scalars', () => {
    expect(scrubParams({ module: 'payroll', status: 200, outcome: true })).toEqual({
      module: 'payroll',
      status: 200,
      outcome: true,
    });
  });

  it('drops confidential HR fields even when a caller passes them', () => {
    expect(
      scrubParams({ module: 'payroll', netPay: 4200, employeeName: 'Jane Doe' }),
    ).toEqual({ module: 'payroll' });
  });

  it('drops values that are personal data whatever the key is called', () => {
    expect(scrubParams({ contact: 'jane.doe@company.com' })).toEqual({});
    expect(scrubParams({ ref: 'GB29NWBK60161331926819' })).toEqual({});
    expect(scrubParams({ code: '+44 7700 900123' })).toEqual({});
  });

  it('refuses non-scalars — a whole record is what gets passed by accident', () => {
    expect(scrubParams({ employeeRecord: { a: 1 }, tags: ['x'], when: new Date() })).toEqual({});
  });

  it('drops over-long strings rather than truncating a leaked sentence', () => {
    expect(scrubParams({ label: 'x'.repeat(101) })).toEqual({});
    expect(scrubParams({ label: 'x'.repeat(100) })).toEqual({ label: 'x'.repeat(100) });
  });

  it('skips null and undefined, and survives no params at all', () => {
    expect(scrubParams({ module: null, screen: undefined })).toEqual({});
    expect(scrubParams(undefined)).toEqual({});
  });
});

describe('pseudonymousId', () => {
  it('is stable for the same account', () => {
    expect(pseudonymousId('u-admin')).toBe(pseudonymousId('u-admin'));
  });

  it('does not contain the account id it was built from', () => {
    const raw = '3f9a1c2e-1b44-4d0a-9e77-2b6f9c1d5a10';
    expect(pseudonymousId(raw)).not.toContain(raw);
    expect(pseudonymousId(raw)).toMatch(/^u_[0-9a-f]{8}$/);
  });

  it('separates different accounts', () => {
    expect(pseudonymousId('u-admin')).not.toBe(pseudonymousId('u-employee'));
  });
});
