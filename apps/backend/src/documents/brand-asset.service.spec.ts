import { StorageService } from '../storage/storage.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { BrandAssetService } from './brand-asset.service';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function make(
  settings: Record<string, string>,
  object: { buffer: Buffer; mimeType: string } | null = {
    buffer: PNG,
    mimeType: 'image/png',
  },
) {
  const readPublicObject = jest.fn(async () => object);
  const service = new BrandAssetService(
    {
      getSetting: jest.fn(
        async (key: string, fallback?: string) => settings[key] ?? fallback ?? '',
      ),
    } as unknown as SystemSettingsService,
    { readPublicObject } as unknown as StorageService,
  );
  return { service, readPublicObject };
}

describe('BrandAssetService', () => {
  it('inlines the stored logo as a data: URI', async () => {
    // The defect this closes: every shipped template emits
    // <img src="{{companyLogoUrl}}"> and was handed an http URL, on a render
    // page that has no network. No issued letter has ever shown the logo.
    const { service } = make({ company_logo_url: 'http://minio/bucket/logo/a.png' });
    const uri = await service.logoDataUri();
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    expect(uri).not.toMatch(/http/);
  });

  it('prefers the SVG, matching the app chrome', async () => {
    // Sidebar, login and footer all resolve svg → url → initials. A document
    // showing a different logo from the page next to it is its own bug.
    const { service, readPublicObject } = make({
      company_logo_svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      company_logo_url: 'http://minio/bucket/logo/a.png',
    });
    const uri = await service.logoDataUri();
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(readPublicObject).not.toHaveBeenCalled();
  });

  it('returns empty when no logo is configured', async () => {
    const { service } = make({});
    await expect(service.logoDataUri()).resolves.toBe('');
  });

  it('degrades to no logo rather than failing the document', async () => {
    // A letter without a logo is a letter. A letter that could not be issued
    // because the logo was unreadable is an outage.
    const { service } = make({ company_logo_url: 'http://minio/bucket/gone.png' }, null);
    await expect(service.logoDataUri()).resolves.toBe('');
  });

  it('refuses to inline something enormous', async () => {
    // base64 costs ~33% on top, and this string lands in the markup of every
    // document — once per employee in a 500-person bulk run.
    const { service } = make(
      { company_logo_url: 'http://minio/bucket/huge.png' },
      { buffer: Buffer.alloc(3 * 1024 * 1024), mimeType: 'image/png' },
    );
    await expect(service.logoDataUri()).resolves.toBe('');
  });

  it('passes an already-inlined value straight through', async () => {
    const data = 'data:image/png;base64,AAAA';
    const { service, readPublicObject } = make({ company_logo_url: data });
    await expect(service.logoDataUri()).resolves.toBe(data);
    expect(readPublicObject).not.toHaveBeenCalled();
  });

  it('caches repeated reads', async () => {
    const { service, readPublicObject } = make({
      company_logo_url: 'http://minio/bucket/logo/a.png',
    });
    await service.logoDataUri();
    await service.logoDataUri();
    expect(readPublicObject).toHaveBeenCalledTimes(1);
  });

  it('re-reads when the admin changes the logo', async () => {
    // Keyed on the setting VALUES, not on a timer alone: an admin who
    // re-uploads and re-renders must not be shown the old logo for 5 minutes.
    const settings: Record<string, string> = {
      company_logo_url: 'http://minio/bucket/logo/a.png',
    };
    const { service, readPublicObject } = make(settings);
    await service.logoDataUri();
    settings.company_logo_url = 'http://minio/bucket/logo/b.png';
    await service.logoDataUri();
    expect(readPublicObject).toHaveBeenCalledTimes(2);
  });
});
