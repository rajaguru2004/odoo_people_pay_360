import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { WpsFormatRegistry } from '../src/wps/formats/wps-format.registry';
import { SECURE_DOWNLOAD_RESOLVERS } from '../src/storage/secure-download.registry';

/**
 * Wiring smoke test. Cheap, and it catches the two failure modes that are silent
 * at compile time:
 *   • a DI cycle or missing provider in WpsModule (the app just fails to boot), and
 *   • the wps-file download resolver not reaching SECURE_DOWNLOAD_RESOLVERS, which
 *     would make every download 404 with no other symptom.
 */
describe('WPS module wiring (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootE2EApp();
  }, 120_000);

  afterAll(async () => {
    await ctx?.app?.close();
  });

  it('registers every wage-file format', () => {
    const registry = ctx.app.get(WpsFormatRegistry);
    const keys = registry.list().map((f) => f.key).sort();
    expect(keys).toEqual(['generic-csv-v1', 'om-cbo-v1', 'om-sif-edr-v1']);
  });

  it('offers BOTH provisional Oman layouts, so the bank spec decides by dropdown', () => {
    // We do not know which record convention Oman's banks require, so both
    // candidates ship and the operator picks. Neither claims to be correct.
    const omanFormats = ctx.app
      .get(WpsFormatRegistry)
      .listForCountry('OM')
      .filter((f) => f.country === 'OM');
    expect(omanFormats.map((f) => f.key).sort()).toEqual(['om-cbo-v1', 'om-sif-edr-v1']);
    for (const f of omanFormats) {
      expect(f.specVersion).toMatch(/PROVISIONAL/);
      expect(f.currency).toBe('OMR');
      expect(f.currencyExponent).toBe(3);
    }
  });

  it('exposes the Oman format with 3-decimal OMR', () => {
    const format = ctx.app.get(WpsFormatRegistry).get('om-cbo-v1');
    expect(format.country).toBe('OM');
    expect(format.currency).toBe('OMR');
    // The whole reason the money path uses integer minor units.
    expect(format.currencyExponent).toBe(3);
    expect(format.employerConfigSchema.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'molEstablishmentNumber',
        'crNumber',
        'employerBankCode',
        'employerAccountIban',
      ]),
    );
  });

  it('offers the Oman format for an OM branch and not for an IN branch', () => {
    const registry = ctx.app.get(WpsFormatRegistry);
    expect(registry.listForCountry('OM').map((f) => f.key)).toContain('om-cbo-v1');
    expect(registry.listForCountry('IN').map((f) => f.key)).not.toContain('om-cbo-v1');
    // The country-neutral format is available everywhere.
    expect(registry.listForCountry('IN').map((f) => f.key)).toContain('generic-csv-v1');
  });

  it('rejects an unknown format key with the available list', () => {
    const registry = ctx.app.get(WpsFormatRegistry);
    expect(() => registry.get('nope')).toThrow(/Unknown WPS format 'nope'.*om-cbo-v1/s);
  });

  it('wires the wps-file resolver into the secure-download route', () => {
    const resolvers = ctx.app.get(SECURE_DOWNLOAD_RESOLVERS) as { kind: string }[];
    expect(resolvers.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['letter', 'employee-document', 'wps-file']),
    );
  });

  it('serves the format catalogue over HTTP', async () => {
    // 401 (not 404) proves the route is mounted; auth is covered elsewhere.
    const res = await ctx.http().get('/wps/formats');
    expect(res.status).toBe(401);
  });
});
