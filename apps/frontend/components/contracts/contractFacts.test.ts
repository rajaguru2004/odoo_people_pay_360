import { describe, expect, it } from 'vitest';
import {
  activeContractFilterCount,
  EMPTY_CONTRACT_FILTERS,
  humanise,
  toContractQuery,
} from './contractFacts';

describe('humanise', () => {
  it('turns an enum into something a reader can scan', () => {
    expect(humanise('FIXED_TERM')).toBe('Fixed term');
    expect(humanise('ACTIVE')).toBe('Active');
  });
});

describe('activeContractFilterCount', () => {
  it('ignores the search box, which hides nothing', () => {
    expect(activeContractFilterCount({ ...EMPTY_CONTRACT_FILTERS, search: 'CTR-1' })).toBe(0);
  });

  it('counts each narrowing choice once', () => {
    expect(
      activeContractFilterCount({
        ...EMPTY_CONTRACT_FILTERS,
        status: 'ACTIVE',
        workType: 'REMOTE',
        expiringWithinDays: '30',
      }),
    ).toBe(3);
  });
});

describe('toContractQuery', () => {
  it('drops every empty field rather than sending a blank the API would reject', () => {
    expect(toContractQuery(EMPTY_CONTRACT_FILTERS)).toEqual({
      search: undefined,
      status: undefined,
      contractType: undefined,
      expiringWithinDays: undefined,
    });
  });

  it('leaves work type out — the endpoint has no such parameter', () => {
    // The validation pipe runs with forbidNonWhitelisted, so an unlisted field
    // is a 400 rather than an ignored hint.
    const query = toContractQuery({ ...EMPTY_CONTRACT_FILTERS, workType: 'REMOTE' });
    expect(query).not.toHaveProperty('workType');
  });

  it('sends the expiry window as a number, and only when it is one', () => {
    expect(
      toContractQuery({ ...EMPTY_CONTRACT_FILTERS, expiringWithinDays: '30' })
        .expiringWithinDays,
    ).toBe(30);
    expect(
      toContractQuery({ ...EMPTY_CONTRACT_FILTERS, expiringWithinDays: '' }).expiringWithinDays,
    ).toBeUndefined();
  });

  it('trims the search term so a stray space is not a filter', () => {
    expect(toContractQuery({ ...EMPTY_CONTRACT_FILTERS, search: '  ' }).search).toBeUndefined();
    expect(toContractQuery({ ...EMPTY_CONTRACT_FILTERS, search: ' CTR-1 ' }).search).toBe('CTR-1');
  });
});
