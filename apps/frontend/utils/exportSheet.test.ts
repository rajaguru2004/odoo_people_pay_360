import { describe, expect, it } from 'vitest';
import { blankMissing, datedStem, sheetTabName } from './exportSheet';

describe('sheetTabName', () => {
  it('trims to the 31 characters a workbook accepts', () => {
    expect(sheetTabName('Departments by headcount and span of control')).toHaveLength(31);
  });

  it('strips the characters that make a workbook refuse to open', () => {
    expect(sheetTabName('Head Office / Sohar [2026]')).toBe('Head Office   Sohar  2026');
  });

  it('falls back rather than producing an empty tab name', () => {
    expect(sheetTabName('///')).toBe('Sheet');
  });
});

describe('blankMissing', () => {
  it('writes a blank cell, never a zero, for a figure that was not measured', () => {
    // A 0 here joins every average built on the sheet afterwards and there is
    // nothing left in the file saying it was invented.
    expect(blankMissing({ Headcount: 4, 'Span of control': null })).toEqual({
      Headcount: 4,
      'Span of control': '',
    });
  });

  it('keeps a real zero', () => {
    expect(blankMissing({ Headcount: 0 })).toEqual({ Headcount: 0 });
  });
});

describe('datedStem', () => {
  it('dates the file from the local calendar day, not a zone-shifted instant', () => {
    expect(datedStem('contracts', new Date(2026, 0, 15, 23, 30))).toBe('contracts-2026-01-15');
  });
});
