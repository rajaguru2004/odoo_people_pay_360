import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { existsSync } from 'fs';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { PdfService } from './pdf.service';

const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];
const localChromium =
  process.env.CHROMIUM_PATH ?? CHROMIUM_CANDIDATES.find((p) => existsSync(p));

function makeService(settings: Record<string, string> = {}) {
  const settingsService = {
    getSetting: jest.fn(async (key: string, fallback?: string) =>
      settings[key] ?? fallback ?? '',
    ),
  } as unknown as SystemSettingsService;
  return new PdfService(settingsService);
}

describe('PdfService', () => {
  describe('availability', () => {
    it('reports unavailable when the kill-switch is off', async () => {
      const service = makeService({ pdf_enabled: 'false' });
      await expect(service.isAvailable()).resolves.toBe(false);
    });

    it('refuses to render when the kill-switch is off', async () => {
      const service = makeService({ pdf_enabled: 'false' });
      await expect(service.renderHtml('<p>hi</p>')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('reports unavailable when CHROMIUM_PATH points at nothing', async () => {
      const prev = process.env.CHROMIUM_PATH;
      process.env.CHROMIUM_PATH = '/nonexistent/chromium';
      try {
        await expect(makeService().isAvailable()).resolves.toBe(false);
      } finally {
        if (prev === undefined) delete process.env.CHROMIUM_PATH;
        else process.env.CHROMIUM_PATH = prev;
      }
    });

    it('fails with a clear message rather than hanging when Chromium is absent', async () => {
      const prev = process.env.CHROMIUM_PATH;
      process.env.CHROMIUM_PATH = '/nonexistent/chromium';
      try {
        await expect(makeService().renderHtml('<p>hi</p>')).rejects.toThrow(
          /no Chromium binary found/,
        );
      } finally {
        if (prev === undefined) delete process.env.CHROMIUM_PATH;
        else process.env.CHROMIUM_PATH = prev;
      }
    });
  });

  describe('boot warning', () => {
    // The failure this guards is silence: before onModuleInit existed, a
    // deployment with pdf_enabled on and no binary started up looking
    // completely healthy and refused only PDFs, so it was triaged as a support
    // question rather than a deployment one.
    const withMissingChromium = async (
      settings: Record<string, string>,
      fn: (errors: string[]) => Promise<void>,
    ) => {
      const prev = process.env.CHROMIUM_PATH;
      process.env.CHROMIUM_PATH = '/nonexistent/chromium';
      const errors: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((msg: unknown) => {
          errors.push(String(msg));
        });
      try {
        await fn(errors);
      } finally {
        spy.mockRestore();
        if (prev === undefined) delete process.env.CHROMIUM_PATH;
        else process.env.CHROMIUM_PATH = prev;
      }
    };

    it('logs an error at boot when enabled but no binary is present', async () => {
      await withMissingChromium({}, async (errors) => {
        await makeService().onModuleInit();
        expect(errors).toHaveLength(1);
        // The message has to name the remedy, not just the symptom.
        expect(errors[0]).toMatch(/no Chromium binary was found/);
        expect(errors[0]).toMatch(/CHROMIUM_PATH=\/nonexistent\/chromium/);
        expect(errors[0]).toMatch(/pdf_enabled=false/);
      });
    });

    it('stays quiet when the kill-switch is deliberately off', async () => {
      // A site that turned PDFs off has made a choice; shouting at it every
      // boot would train people to ignore the log line that matters.
      await withMissingChromium({}, async (errors) => {
        await makeService({ pdf_enabled: 'false' }).onModuleInit();
        expect(errors).toHaveLength(0);
      });
    });

    it('never lets a failing settings read take the app down', async () => {
      const settingsService = {
        getSetting: jest.fn().mockRejectedValue(new Error('db down')),
      } as unknown as SystemSettingsService;
      await expect(
        new PdfService(settingsService).onModuleInit(),
      ).resolves.toBeUndefined();
    });
  });

  describe('render timeout', () => {
    const resolve = (service: PdfService, ms?: number) =>
      (service as any).resolveTimeout(ms);

    it('defaults to the request-path deadline', () => {
      expect(resolve(makeService())).toBe(30_000);
    });

    it('lets the bulk drainer lengthen it', () => {
      expect(resolve(makeService(), 90_000)).toBe(90_000);
    });

    it('clamps rather than removing the deadline', () => {
      // A caller must be able to ask for longer, never for forever.
      expect(resolve(makeService(), 10 * 60_000)).toBe(120_000);
      expect(resolve(makeService(), 0)).toBe(30_000);
      expect(resolve(makeService(), -1)).toBe(30_000);
      expect(resolve(makeService(), Number.NaN)).toBe(30_000);
    });
  });

  describe('diagnose', () => {
    it('reports cleanly instead of throwing when the renderer is off', async () => {
      const d = await makeService({ pdf_enabled: 'false' }).diagnose();
      expect(d.pdfEnabled).toBe(false);
      expect(d.browserLaunchOk).toBe(false);
      expect(d.probeRenderMs).toBeNull();
      expect(d.fonts.missing).toContain('(not probed — renderer unavailable)');
    });

    it('reports the missing binary rather than a launch stack trace', async () => {
      const prev = process.env.CHROMIUM_PATH;
      process.env.CHROMIUM_PATH = '/nonexistent/chromium';
      try {
        const d = await makeService().diagnose();
        expect(d.pdfEnabled).toBe(true);
        expect(d.chromiumPath).toBeNull();
        expect(d.browserLaunchOk).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.CHROMIUM_PATH;
        else process.env.CHROMIUM_PATH = prev;
      }
    });
  });

  // Real rendering needs a browser. Skipped rather than failed where there is
  // none, so the suite stays green on machines without Chromium.
  const describeIfChromium = localChromium ? describe : describe.skip;

  describeIfChromium('rendering', () => {
    let service: PdfService;

    beforeAll(() => {
      process.env.CHROMIUM_PATH = localChromium!;
      service = makeService();
    });

    afterAll(async () => {
      await service?.onModuleDestroy();
    });

    it('renders HTML to a PDF buffer', async () => {
      const buf = await service.renderHtml(
        '<!doctype html><html><body><h1>Salary Certificate</h1></body></html>',
      );
      expect(buf.length).toBeGreaterThan(500);
      // PDF magic number.
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }, 60_000);

    it('compiles a Handlebars source string', async () => {
      const buf = await service.renderHandlebars(
        '<!doctype html><html><body><p>{{name}} — {{amount}}</p></body></html>',
        { name: 'Alice', amount: 'OMR 1,200.000' },
      );
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }, 60_000);

    it('renders an RTL Arabic document', async () => {
      // The reason Chromium was chosen over a JS PDF library: this must not
      // come out as isolated, reversed letters.
      const buf = await service.renderHtml(
        `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
         <style>body{font-family:"Noto Sans Arabic","Noto Naskh Arabic",sans-serif}</style>
         </head><body><h1>شهادة راتب</h1><p>إلى من يهمه الأمر</p></body></html>`,
      );
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(buf.length).toBeGreaterThan(500);
    }, 60_000);

    it('reuses one browser across renders', async () => {
      await service.renderHtml('<p>one</p>');
      const first = (service as any).browser;
      await service.renderHtml('<p>two</p>');
      expect((service as any).browser).toBe(first);
    }, 60_000);

    it('blocks a remote subresource instead of fetching it', async () => {
      // Letter templates are admin-editable HTML. Without this, a template
      // carrying a remote <img> is an exfiltration channel out of a process
      // that can see salary figures — and an SSRF probe into the private
      // network. The render must still SUCCEED: a blocked image is a broken
      // image, not a failed document.
      const warnings: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((msg: unknown) => {
          warnings.push(String(msg));
        });
      try {
        const buf = await service.renderHtml(
          `<!doctype html><html><body>
             <img src="http://169.254.169.254/latest/meta-data/">
             <p>body</p></body></html>`,
        );
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(
          warnings.some((w) => w.includes('169.254.169.254')),
        ).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }, 60_000);

    it('still allows an inlined data: URI', async () => {
      // The engine inlines brand assets as data: URIs precisely so the block
      // above costs nothing. If this ever breaks, every logo disappears.
      const png =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const buf = await service.renderHtml(
        `<!doctype html><html><body><img src="${png}"><p>ok</p></body></html>`,
      );
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }, 60_000);

    it('diagnoses a working renderer, fonts included', async () => {
      const d = await service.diagnose();
      expect(d.browserLaunchOk).toBe(true);
      expect(d.chromiumVersion).toMatch(/Chrom/i);
      expect(d.probeRenderMs).toBeGreaterThan(0);
      // Not asserted as true: a developer machine legitimately may not have the
      // Noto Arabic families the IMAGE installs. What is asserted is that the
      // probe reaches a verdict and names what it could not find, rather than
      // reporting a bare boolean nobody can act on.
      expect(typeof d.fonts.arabic).toBe('boolean');
      if (!d.fonts.arabic) expect(d.fonts.missing).toContain('Noto Sans Arabic');
    }, 90_000);
  });
});
