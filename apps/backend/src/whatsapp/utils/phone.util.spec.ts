import fc from 'fast-check';
import {
  firstRegion,
  isE164,
  jidToE164,
  maskPhone,
  normalisePhoneRegion,
  toE164,
  toEvolutionNumber,
} from './phone.util';

/**
 * Phone normalisation is the highest-risk pure function in the WhatsApp feature:
 * its failure mode is not "no message" but "message to the wrong human". These
 * cases are drawn from the formats actually present in the repo's seed data and
 * bulk-import template.
 */
describe('phone.util', () => {
  describe('toE164 — formats present in real data', () => {
    it.each([
      // [raw, region, expected]
      ['+968-9001-0000', 'OM', '+96890010000'],
      ['+91-90000-00100', 'IN', '+919000000100'],
      ['+65-8000-0001', 'SG', '+6580000001'],
      ['+968 9001 0000', 'OM', '+96890010000'],
      ['+968(9001)0000', 'OM', '+96890010000'],
      ['+968.9001.0000', 'OM', '+96890010000'],
    ])('normalises %s (%s)', (raw, region, expected) => {
      expect(toE164(raw, region)).toBe(expected);
    });

    it('resolves a national number using the region', () => {
      // The bulk-import template's own example is a bare national number.
      expect(toE164('09123456789', 'IN')).toBe('+919123456789');
      expect(toE164('91234567', 'OM')).toBe('+96891234567');
    });

    it('treats a 00 prefix as the international access code', () => {
      expect(toE164('0096890010000', 'OM')).toBe('+96890010000');
      expect(toE164('00919000000010', 'IN')).toBe('+919000000010');
    });

    it('accepts an already-international number regardless of region', () => {
      expect(toE164('+96890010000', 'IN')).toBe('+96890010000');
      expect(toE164('+96890010000', '')).toBe('+96890010000');
    });

    it('prefers the number over the region when they disagree', () => {
      // An Omani number on an Indian branch is a transfer, not a data error.
      expect(toE164('+96890010000', 'IN')).toBe('+96890010000');
    });
  });

  describe('toE164 — rejections', () => {
    it('rejects a national number when no region is known, rather than guessing', () => {
      // This is the whole point: guessing here messages a stranger.
      expect(toE164('9001000', '')).toBeNull();
      expect(toE164('09123456789', null)).toBeNull();
    });

    it.each([
      ['', 'OM'],
      [null, 'OM'],
      [undefined, 'OM'],
      ['   ', 'OM'],
      ['not a phone', 'OM'],
      ['+1', 'US'],
      ['12', 'OM'],
      ['+9999999999999999999', 'OM'],
    ])('rejects %p', (raw, region) => {
      expect(toE164(raw as any, region)).toBeNull();
    });

    it('rejects an unknown region for a national number', () => {
      expect(toE164('9001000', 'ZZ')).toBeNull();
      expect(toE164('9001000', 'NOTACOUNTRY')).toBeNull();
    });

    it('rejects a number with the wrong national length for its country', () => {
      // Regression guard. The sample-data seed used to emit `+91-90000-0010`,
      // which is nine national digits where India requires ten — undeliverable
      // for every Indian sample employee, and invisible without this check.
      expect(toE164('+91-90000-0010', 'IN')).toBeNull();
    });
  });

  describe('isE164', () => {
    it.each(['+96890010000', '+919000000010', '+6580000001'])('accepts %s', (v) => {
      expect(isE164(v)).toBe(true);
    });
    it.each(['96890010000', '+0968900', '', '+96890010000a', null, undefined])(
      'rejects %p',
      (v) => {
        expect(isE164(v as any)).toBe(false);
      },
    );
  });

  describe('toEvolutionNumber', () => {
    it('strips exactly one leading plus', () => {
      expect(toEvolutionNumber('+96890010000')).toBe('96890010000');
    });

    it('leaves an already-bare number alone', () => {
      expect(toEvolutionNumber('96890010000')).toBe('96890010000');
    });
  });

  describe('jidToE164', () => {
    it('unwraps the WhatsApp JID suffix', () => {
      expect(jidToE164('96890010000@s.whatsapp.net')).toBe('+96890010000');
    });

    it('drops a device suffix', () => {
      expect(jidToE164('96890010000:12@s.whatsapp.net')).toBe('+96890010000');
    });

    it.each([null, undefined, '', '@s.whatsapp.net', 'abc@lid'])('returns null for %p', (v) => {
      expect(jidToE164(v as any)).toBeNull();
    });
  });

  describe('maskPhone', () => {
    it('never reveals more than the last four digits', () => {
      const masked = maskPhone('+96890010000');
      expect(masked).toContain('0000');
      expect(masked).not.toContain('9001');
      expect(masked.endsWith('0000')).toBe(true);
    });

    it('does not leak short numbers wholesale', () => {
      expect(maskPhone('+123')).toBe('••••');
    });

    it.each([null, undefined, ''])('returns empty for %p', (v) => {
      expect(maskPhone(v as any)).toBe('');
    });
  });

  describe('normalisePhoneRegion', () => {
    it.each([
      ['om', 'OM'],
      [' in ', 'IN'],
      ['SG', 'SG'],
    ])('canonicalises %p to %p', (raw, expected) => {
      expect(normalisePhoneRegion(raw)).toBe(expected);
    });

    it.each([null, undefined, '', 'IND', 'X', '99', 'ZZ'])(
      'rejects %p rather than storing something libphonenumber cannot use',
      (raw) => {
        expect(normalisePhoneRegion(raw as any)).toBe('');
      },
    );
  });

  describe('firstRegion — employee, then branch, then global default', () => {
    it("prefers the employee's own country over the branch and the default", () => {
      expect(firstRegion('PH', 'OM', 'IN')).toBe('PH');
    });

    it('falls through to the branch country when the employee has none', () => {
      expect(firstRegion(null, 'OM', 'IN')).toBe('OM');
    });

    it('falls through to the global default when neither is set', () => {
      expect(firstRegion(null, '', 'IN')).toBe('IN');
    });

    it('skips an unusable value instead of stopping on it', () => {
      // A junk employee code must not shadow a perfectly good branch country.
      expect(firstRegion('ZZ', 'OM', 'IN')).toBe('OM');
    });

    it('returns empty when nothing in the chain is usable', () => {
      expect(firstRegion(null, undefined, '')).toBe('');
    });
  });

  describe('a national number reads differently per employee region', () => {
    // The point of the whole feature: the same digits belong to two different
    // people in two different countries.
    it('parses the same digits against each resolved region', () => {
      expect(toE164('90010000', firstRegion('OM', 'IN', 'IN'))).toBe('+96890010000');
      expect(toE164('80000001', firstRegion('SG', 'IN', 'IN'))).toBe('+6580000001');
    });

    it('rejects a national number when no region survives the chain', () => {
      expect(toE164('90010000', firstRegion(null, null, ''))).toBeNull();
    });

    it('ignores every region once the number is already international', () => {
      expect(toE164('+96890010000', firstRegion('IN', 'IN', 'IN'))).toBe('+96890010000');
    });
  });

  describe('property: formatting noise is irrelevant', () => {
    it('round-trips any valid E.164 through common separators', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('+96890010000', '+919000000010', '+6580000001', '+14155552671'),
          fc.constantFrom('-', ' ', '.', ''),
          (e164, sep) => {
            // Sprinkle the separator through the national part.
            const cc = e164.slice(0, 3);
            const rest = e164.slice(3).split('').join(sep);
            expect(toE164(`${cc}${sep}${rest}`, '')).toBe(e164);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
