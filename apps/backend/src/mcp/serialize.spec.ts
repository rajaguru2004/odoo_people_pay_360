import { toJsonSafe, toToolJson } from './serialize';

class FakeDecimal {
  constructor(private readonly v: number) {}
  d = [1];
  e = 0;
  s = 1;
  toNumber() {
    return this.v;
  }
}

describe('serialize', () => {
  it('converts Date, BigInt and Prisma Decimal', () => {
    const out = toJsonSafe({
      when: new Date('2026-07-09T00:00:00.000Z'),
      big: BigInt(42),
      money: new FakeDecimal(1234.5),
      nested: [{ money: new FakeDecimal(1) }],
    });
    expect(out).toEqual({
      when: '2026-07-09T00:00:00.000Z',
      big: 42,
      money: 1234.5,
      nested: [{ money: 1 }],
    });
  });

  it('passes small scalar payloads through', () => {
    expect(toToolJson({ a: 1 })).toEqual({ a: 1 });
    expect(toToolJson('hello')).toBe('hello');
    expect(toToolJson(null)).toBeNull();
  });

  it('trims bare arrays with a truncation marker', () => {
    const out: any = toToolJson(
      Array.from({ length: 30 }, (_, i) => i),
      { maxItems: 5 },
    );
    expect(out.data).toHaveLength(5);
    expect(out.meta).toMatchObject({ truncated: true, returned: 5, total: 30 });
  });

  it('trims nested data arrays inside envelopes', () => {
    const out: any = toToolJson(
      { success: true, data: Array.from({ length: 30 }, (_, i) => ({ i })), meta: { page: 1 } },
      { maxItems: 8 },
    );
    expect(out.data).toHaveLength(8);
    expect(out.meta).toMatchObject({ page: 1, truncated: true, returned: 8, total: 30 });
  });

  it('hard-caps oversized payloads', () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ i, blob: 'x'.repeat(2000) }));
    const out: any = toToolJson(big, { maxItems: 200 });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(50 * 1024);
    expect(out.meta?.truncated ?? out.truncated).toBe(true);
  });
});
