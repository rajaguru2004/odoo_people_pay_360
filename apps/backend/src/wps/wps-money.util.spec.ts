import { Prisma } from '@prisma/client';
import {
  WpsPrecisionError,
  addMinor,
  currencyExponent,
  minorToFixed,
  minorToPadded,
  subMinor,
  sumMinor,
  toMinor,
  zeroMoney,
} from './wps-money.util';

/**
 * Money for wage files is integer minor units, never a float.
 *
 * The invariant these tests protect: detail rows must sum to the header total
 * exactly, because that is the arithmetic a bank validator recomputes. A single
 * cent of float drift over a few hundred rows is a rejected submission.
 */
describe('wps-money.util', () => {
  describe('currencyExponent', () => {
    it.each([
      ['OMR', 3],
      ['BHD', 3],
      ['KWD', 3],
      ['AED', 2],
      ['SAR', 2],
      ['USD', 2],
      ['JPY', 0],
      ['omr', 3], // case-insensitive
      ['XYZ', 2], // unknown defaults to 2
    ])('%s -> %i', (currency, expected) => {
      expect(currencyExponent(currency)).toBe(expected);
    });
  });

  describe('toMinor', () => {
    it.each([
      ['12.50', 3, 12500n],
      ['12.50', 2, 1250n],
      ['0', 3, 0n],
      ['0.001', 3, 1n], // one baisa
      ['1234567.890', 3, 1234567890n],
      ['-45.500', 3, -45500n], // negatives survive; blocking them is a pre-flight rule
    ])('%s at exponent %i -> %s', (value, exponent, expected) => {
      expect(toMinor(value, 'OMR', exponent, 'net').minor).toBe(expected);
    });

    it('reads a Prisma.Decimal exactly (no float round-trip)', () => {
      const d = new Prisma.Decimal('999999999.999');
      expect(toMinor(d, 'OMR', 3, 'net').minor).toBe(999999999999n);
    });

    it('treats null and undefined as zero', () => {
      expect(toMinor(null, 'OMR', 3, 'net').minor).toBe(0n);
      expect(toMinor(undefined, 'OMR', 3, 'net').minor).toBe(0n);
    });

    it('THROWS rather than rounding when the value needs more precision', () => {
      // The guard that keeps the WPS path honest once money columns widen: a
      // silent round here would make the file disagree with the bank's total.
      expect(() => toMinor('12.3456', 'OMR', 3, 'netSalary')).toThrow(WpsPrecisionError);
      expect(() => toMinor('0.005', 'AED', 2, 'basic')).toThrow(WpsPrecisionError);
    });

    it('names the offending field and value in the error', () => {
      try {
        toMinor('12.3456', 'OMR', 3, 'netSalary');
        fail('should have thrown');
      } catch (e) {
        const err = e as WpsPrecisionError;
        expect(err.field).toBe('netSalary');
        expect(err.value).toBe('12.3456');
        expect(err.message).toMatch(/netSalary.*OMR.*exponent 3/);
      }
    });

    it('accepts every 2dp value at exponent 3 — today\'s columns are Decimal(12,2)', () => {
      // This is why the 3-decimal migration is not a prerequisite for WPS: any
      // 2dp value scaled by 10^3 is an exact integer.
      for (const cents of ['0.01', '0.99', '123.45', '99999999.99']) {
        expect(() => toMinor(cents, 'OMR', 3, 'x')).not.toThrow();
      }
    });
  });

  describe('addMinor / subMinor / sumMinor', () => {
    const omr = (n: bigint) => ({ minor: n, currency: 'OMR', exponent: 3 });

    it('adds and subtracts', () => {
      expect(addMinor(omr(100n), omr(250n), omr(1n)).minor).toBe(351n);
      expect(subMinor(omr(500n), omr(120n)).minor).toBe(380n);
    });

    it('sums an empty list to zero in the given currency', () => {
      const z = sumMinor([], 'OMR', 3);
      expect(z.minor).toBe(0n);
      expect(z.currency).toBe('OMR');
      expect(z.exponent).toBe(3);
    });

    it('refuses to mix currencies or exponents', () => {
      expect(() => addMinor(omr(1n), { minor: 1n, currency: 'AED', exponent: 2 })).toThrow(
        /Cannot combine OMR\(3\) with AED\(2\)/,
      );
      expect(() => addMinor(omr(1n), { minor: 1n, currency: 'OMR', exponent: 2 })).toThrow();
    });

    it('stays exact past Number.MAX_SAFE_INTEGER', () => {
      // A run total in baisa can exceed 2^53, which is why this is bigint.
      const big = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
      expect(addMinor(omr(big), omr(1n)).minor).toBe(9_007_199_254_740_994n);
    });

    it('sums many rows without drift — the header-equals-detail invariant', () => {
      // 0.01 a thousand times is exactly 10.00; in floats it is not.
      const rows = Array.from({ length: 1000 }, () => toMinor('0.01', 'OMR', 3, 'net'));
      expect(sumMinor(rows, 'OMR', 3).minor).toBe(10_000n);
      expect(minorToFixed(sumMinor(rows, 'OMR', 3))).toBe('10.000');
    });
  });

  describe('minorToFixed', () => {
    it.each([
      [123450n, 3, '123.450'],
      [1n, 3, '0.001'],
      [0n, 3, '0.000'],
      [999n, 3, '0.999'],
      [1000n, 3, '1.000'],
      [1250n, 2, '12.50'],
      [-45500n, 3, '-45.500'],
      [-1n, 3, '-0.001'],
      [500n, 0, '500'],
    ])('%s at exponent %i -> %s', (minor, exponent, expected) => {
      expect(minorToFixed({ minor, currency: 'OMR', exponent })).toBe(expected);
    });
  });

  describe('minorToPadded', () => {
    it('zero-pads to the field width, as fixed-record SIFs need', () => {
      expect(minorToPadded({ minor: 7332300n, currency: 'OMR', exponent: 3 }, 12)).toBe(
        '000007332300',
      );
      expect(minorToPadded(zeroMoney('OMR', 3), 12)).toBe('000000000000');
    });

    it('throws rather than silently truncating an oversized amount', () => {
      // Truncation would shift every subsequent column in a fixed-width file.
      expect(() =>
        minorToPadded({ minor: 1234567890123n, currency: 'OMR', exponent: 3 }, 6),
      ).toThrow(/needs 13 digits but the field is 6 wide/);
    });
  });
});
