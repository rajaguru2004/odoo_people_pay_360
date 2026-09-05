import { PdfDiagnostics, PdfService } from '../pdf/pdf.service';
import { DocumentHealthController } from './document-health.controller';

const DIAGNOSTICS: PdfDiagnostics = {
  pdfEnabled: true,
  chromiumPath: '/usr/bin/chromium',
  chromiumVersion: 'HeadlessChrome/131.0.0.0',
  browserLaunchOk: true,
  probeRenderMs: 412,
  fonts: { latin: true, arabic: true, missing: [] },
  lastRenderError: null,
};

function makeController(value: PdfDiagnostics = DIAGNOSTICS) {
  const diagnose = jest.fn(async () => value);
  const controller = new DocumentHealthController({
    diagnose,
  } as unknown as PdfService);
  return { controller, diagnose };
}

describe('DocumentHealthController', () => {
  it('returns the renderer diagnostics', async () => {
    const { controller } = makeController();
    await expect(controller.health()).resolves.toEqual(DIAGNOSTICS);
  });

  it('caches, because a probe costs a browser tab', async () => {
    // Without the cache a dashboard that polls this endpoint would open a
    // Chromium page per poll, against the one shared browser every real
    // document render also queues behind.
    const { controller, diagnose } = makeController();
    await controller.health();
    await controller.health();
    await controller.health();
    expect(diagnose).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the cache expires', async () => {
    const { controller, diagnose } = makeController();
    await controller.health();
    // Reach in rather than sleeping 60s: the TTL is the behaviour under test,
    // not the clock.
    (controller as any).cached.at -= 61_000;
    await controller.health();
    expect(diagnose).toHaveBeenCalledTimes(2);
  });

  it('caches a BAD verdict too, and does not swallow it', async () => {
    // The unhealthy answer is the one people actually read; it must survive
    // the cache unchanged rather than being retried into a different shape.
    const bad: PdfDiagnostics = {
      ...DIAGNOSTICS,
      chromiumPath: null,
      chromiumVersion: null,
      browserLaunchOk: false,
      probeRenderMs: null,
      fonts: { latin: false, arabic: false, missing: ['Noto Sans Arabic'] },
      lastRenderError: 'no Chromium binary found',
    };
    const { controller, diagnose } = makeController(bad);
    await expect(controller.health()).resolves.toEqual(bad);
    await expect(controller.health()).resolves.toEqual(bad);
    expect(diagnose).toHaveBeenCalledTimes(1);
  });
});
