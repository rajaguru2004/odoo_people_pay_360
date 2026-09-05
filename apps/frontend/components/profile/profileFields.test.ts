import { describe, expect, it } from 'vitest';
import {
  changedFields,
  describeMissing,
  toForm,
  validate,
  type ProfileForm,
} from './profileFields';
import type { EmployeeProfile } from '@/types/employeeProfile';

const form = (over: Partial<ProfileForm> = {}): ProfileForm => ({
  phone: '',
  personalEmail: '',
  address: '',
  dateOfBirth: '',
  gender: '',
  nationality: '',
  ...over,
});

describe('describeMissing', () => {
  it('names what is still blank', () => {
    expect(describeMissing(['phone', 'address'])).toBe('phone and address');
  });

  it('counts the rest rather than listing everything', () => {
    expect(describeMissing(['phone', 'address', 'gender', 'nationality'])).toBe(
      'phone and address and 2 more',
    );
  });

  it('says nothing when nothing is missing', () => {
    expect(describeMissing([])).toBe('');
  });

  it('ignores a field name it does not recognise', () => {
    // The server owns that list. A field added there before it is added here
    // must not put a raw column name on screen.
    expect(describeMissing(['someNewColumn'])).toBe('');
  });
});

describe('toForm', () => {
  it('turns nulls into empty strings', () => {
    // A controlled input handed null becomes uncontrolled, and React changes
    // its mind about that in the middle of an edit.
    const seeded = toForm({ phone: null, address: null } as EmployeeProfile);
    expect(seeded.phone).toBe('');
    expect(seeded.address).toBe('');
  });

  it('truncates a date of birth to its day', () => {
    // `<input type="date">` refuses a full timestamp and renders blank.
    const seeded = toForm({
      dateOfBirth: '1994-02-28T00:00:00.000Z',
    } as EmployeeProfile);
    expect(seeded.dateOfBirth).toBe('1994-02-28');
  });

  it('is a blank form for a record that has not loaded', () => {
    expect(toForm(undefined).phone).toBe('');
  });
});

describe('changedFields', () => {
  it('sends only what moved', () => {
    const original = form({ phone: '111', address: 'Muscat' });
    const edited = form({ phone: '222', address: 'Muscat' });

    expect(changedFields(edited, original)).toEqual({ phone: '222' });
  });

  it('never sends an empty string', () => {
    // Blank means "never filled in", not "clear it". Posting it fails the
    // email validator for everybody who has not given a personal address.
    const original = form({ phone: '111' });
    const edited = form({ phone: '' });

    expect(changedFields(edited, original)).toEqual({});
  });

  it('trims before comparing, so whitespace is not an edit', () => {
    const original = form({ phone: '111' });
    expect(changedFields(form({ phone: '  111  ' }), original)).toEqual({});
    expect(changedFields(form({ phone: '  222  ' }), original)).toEqual({
      phone: '222',
    });
  });
});

describe('validate', () => {
  it('refuses a birthday in the future', () => {
    expect(validate(form({ dateOfBirth: '2030-01-01' }), '2026-09-05')).toEqual({
      dateOfBirth: 'A date of birth cannot be in the future',
    });
  });

  it('accepts today', () => {
    expect(validate(form({ dateOfBirth: '2026-09-05' }), '2026-09-05')).toEqual({});
  });

  it('insists on a two-letter country code', () => {
    expect(validate(form({ nationality: 'Oman' })).nationality).toBeDefined();
    expect(validate(form({ nationality: 'OM' })).nationality).toBeUndefined();
  });

  it('catches an address with no @ before the round trip', () => {
    expect(validate(form({ personalEmail: 'nobody' })).personalEmail).toBeDefined();
    expect(
      validate(form({ personalEmail: 'nobody@example.com' })).personalEmail,
    ).toBeUndefined();
  });

  it('has nothing to say about a form left blank', () => {
    expect(validate(form())).toEqual({});
  });
});
