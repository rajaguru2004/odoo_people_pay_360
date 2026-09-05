import { describe, expect, it } from 'vitest';
import {
  describeScreen,
  moduleForEndpoint,
  moduleForPath,
  namedActionFor,
  sanitizePath,
} from './routes';

describe('sanitizePath', () => {
  it('leaves an id-free screen path untouched', () => {
    expect(sanitizePath('/dashboard/payroll/manage')).toBe('/dashboard/payroll/manage');
  });

  it('masks every id shape the portal puts in a URL', () => {
    expect(sanitizePath('/dashboard/employees/3f9a1c2e-1b44-4d0a-9e77-2b6f9c1d5a10/edit'))
      .toBe('/dashboard/employees/:id/edit');
    expect(sanitizePath('/dashboard/payroll/1421')).toBe('/dashboard/payroll/:id');
    expect(sanitizePath('/dashboard/leaves/ckv8x2p9q0001abcd1234efgh')).toBe('/dashboard/leaves/:id');
    expect(sanitizePath('/dashboard/attendance/reports/2026-08')).toBe('/dashboard/attendance/reports/:id');
  });

  it('masks an address used as a path segment', () => {
    expect(sanitizePath('/dashboard/employees/jane.doe%40company.com')).toBe('/dashboard/employees/:id');
  });

  it('drops the query string, which is where typed search terms live', () => {
    expect(sanitizePath('/dashboard/employees?search=Jane%20Doe&page=2')).toBe('/dashboard/employees');
  });

  it('leaves a numeric route ROOT alone — /403 is a page, not a record', () => {
    expect(sanitizePath('/403')).toBe('/403');
    expect(moduleForPath(sanitizePath('/403'))).toBe('system');
  });

  it('never throws on odd input', () => {
    expect(sanitizePath('')).toBe('/');
    expect(sanitizePath('/')).toBe('/');
    expect(sanitizePath('/dashboard/%E0%A4%A')).toBe('/dashboard/%e0%a4%a');
  });
});

describe('moduleForPath', () => {
  it.each([
    ['/dashboard', 'dashboard'],
    ['/dashboard/employees/:id', 'people'],
    ['/dashboard/contracts/terminations', 'people'],
    ['/dashboard/attendance/corrections', 'attendance'],
    ['/dashboard/leaves/pending', 'leave'],
    ['/dashboard/overtime/new', 'leave'],
    ['/dashboard/payroll/:id', 'payroll'],
    ['/dashboard/payroll/salary-structure', 'payroll'],
    ['/dashboard/appraisal', 'talent'],
    ['/dashboard/assets', 'workplace'],
    ['/dashboard/settings', 'system'],
    ['/dashboard/approvals', 'approvals'],
    ['/dashboard/my-department/team-balances', 'my_team'],
    ['/dashboard/my-documents', 'self_service'],
    ['/dashboard/profile', 'self_service'],
    ['/login', 'auth'],
    ['/checkin', 'attendance'],
    ['/verify/:id', 'verification'],
    ['/dashboard/something-new', 'other'],
    ['/', 'landing'],
  ])('maps %s to %s', (path, expected) => {
    expect(moduleForPath(path)).toBe(expected);
  });
});

describe('describeScreen', () => {
  it('returns a sanitised path, its module and a flat screen key', () => {
    expect(describeScreen('/dashboard/payroll/8813?tab=summary')).toEqual({
      path: '/dashboard/payroll/:id',
      module: 'payroll',
      screen: 'dashboard.payroll.:id',
    });
  });
});

describe('namedActionFor', () => {
  it('names the journeys product asks about', () => {
    expect(namedActionFor('POST', '/attendances/check-in')).toBe('attendance_check_in');
    expect(namedActionFor('POST', '/leave-requests')).toBe('leave_request_submitted');
    expect(namedActionFor('POST', '/leave-requests/:id/approve')).toBe('leave_request_decided');
    expect(namedActionFor('post', '/overtime')).toBe('overtime_request_submitted');
    expect(namedActionFor('POST', '/payrolls/:id/finalize')).toBe('payroll_run_advanced');
  });

  it('falls back to the generic event for everything else', () => {
    expect(namedActionFor('PATCH', '/employees/:id')).toBeNull();
    expect(namedActionFor('GET', '/leave-requests')).toBeNull();
  });
});

describe('moduleForEndpoint', () => {
  it('buckets API endpoints the same way screens are bucketed', () => {
    expect(moduleForEndpoint('/leave-requests/:id/approve')).toBe('leave');
    expect(moduleForEndpoint('/attendances/check-in')).toBe('attendance');
    expect(moduleForEndpoint('/payrolls/:id/lock')).toBe('payroll');
    expect(moduleForEndpoint('/auth/login')).toBe('auth');
    expect(moduleForEndpoint('/unknown-thing')).toBe('other');
  });
});
