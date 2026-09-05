import { deflateSync } from 'zlib';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer, withSetting } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';

/**
 * Letterhead upload, validation and rendering.
 *
 * The validation cases carry most of the weight, because every one of them is
 * something a real HR user will do: upload a screenshot instead of artwork,
 * upload a PDF because that is what the designer sent, upload a 12 MB TIFF
 * renamed to .png. A refusal that does not say what is wrong just becomes a
 * support ticket.
 *
 * The uploaded file is checked by MAGIC BYTES rather than by the mimetype the
 * browser claims — `upload.service.ts` matches on the claim alone, which is a
 * known gap in this codebase, and this path deliberately does not inherit it.
 */

/** A real, minimal PNG of the given size. Deflate-stored, so it is valid. */
function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height); // filter byte + row, all zero
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

describe('Workplace — Document letterheads (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;
  const created: string[] = [];

  const engineOn = <T>(fn: () => Promise<T>) =>
    withSetting(ctx, 'document_engine_enabled', 'true', fn);

  const upload = (token: string, buf: Buffer, name = 'letterhead.png', fields: Record<string, string> = {}) => {
    let req = ctx.http().post('/documents/assets').set(bearer(token));
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', buf, name);
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);
  }, 120_000);

  afterAll(async () => {
    if (created.length) {
      await ctx.prisma.documentAsset.deleteMany({ where: { id: { in: created } } });
    }
    await ctx?.app.close();
  });

  describe('1. what is accepted', () => {
    it('DOC-LH-01 accepts an A4-sized PNG and returns its measured dimensions', async () => {
      await engineOn(async () => {
        const res = await upload(fx.admin.token, makePng(1240, 1754), 'company.png', {
          name: 'Company letterhead',
        });
        expect(res.status).toBe(201);
        expect(res.body.widthPx).toBe(1240);
        expect(res.body.heightPx).toBe(1754);
        expect(res.body.kind).toBe('LETTERHEAD');
        // Defaults exist so a letterhead is usable the moment it is uploaded,
        // without anybody having to understand millimetres first.
        expect(res.body.safeTopMm).toBeGreaterThan(0);
        expect(res.body.previewPath).toMatch(/^\/secure-files\/document-asset\//);
        created.push(res.body.id);
      });
    });

    it('DOC-LH-02 stores it PRIVATELY — public stationery is a forgery kit', async () => {
      await engineOn(async () => {
        const res = await upload(fx.admin.token, makePng(1240, 1754));
        created.push(res.body.id);
        const row = await ctx.prisma.documentAsset.findUnique({ where: { id: res.body.id } });
        expect(row!.privateRef.startsWith('private://')).toBe(true);
        // Content-addressed, so re-uploading identical artwork is detectable
        // and a published version can prove its artwork never changed.
        expect(row!.contentHash).toHaveLength(64);
      });
    });

    it('DOC-LH-03 serves the preview only through the authenticated door', async () => {
      await engineOn(async () => {
        const res = await upload(fx.admin.token, makePng(1240, 1754));
        created.push(res.body.id);

        const ok = await ctx
          .http()
          .get(`/secure-files/document-asset/${res.body.id}`)
          .set(bearer(fx.admin.token))
          .buffer(true);
        expect(ok.status).toBe(200);
        expect(Buffer.from(ok.body).subarray(0, 4).toString('latin1')).toContain('PNG');

        const anon = await ctx.http().get(`/secure-files/document-asset/${res.body.id}`);
        expect(anon.status).toBe(401);
      });
    });

    it('DOC-LH-04 warns about a non-A4 shape without refusing it', async () => {
      await engineOn(async () => {
        // A warning, not a block: plenty of companies have a squarer letter
        // pad, and refusing it outright would be the tool overruling them.
        // Both edges clear the resolution floor, so the only thing wrong with
        // it is the shape.
        const res = await upload(fx.admin.token, makePng(1800, 1800), 'square.png');
        expect(res.status).toBe(201);
        expect(res.body.warning).toMatch(/not A4 proportions/i);
        created.push(res.body.id);
      });
    });
  });

  describe('2. what is refused, and whether the refusal helps', () => {
    it('DOC-LH-04b accepts a LANDSCAPE letterhead of the same resolution', async () => {
      await engineOn(async () => {
        // The rule is about resolution, not orientation. Judging width against
        // the portrait minimum would refuse a perfectly good landscape pad.
        const res = await upload(fx.admin.token, makePng(1754, 1240), 'landscape.png');
        expect(res.status).toBe(201);
        expect(res.body.warning).toBeNull();
        created.push(res.body.id);
      });
    });

    it('DOC-LH-05 refuses a small image, quoting the measured size', async () => {
      await engineOn(async () => {
        const res = await upload(fx.admin.token, makePng(640, 480), 'small.png');
        expect(res.status).toBe(400);
        // The numbers, not "image too small": somebody can act on 640×480.
        expect(res.body.message).toMatch(/640×480/);
        expect(res.body.message).toMatch(/1240×1754/);
        expect(res.body.message).toMatch(/150 DPI/);
      });
    });

    it('DOC-LH-06 refuses a PDF, and says what to upload instead', async () => {
      await engineOn(async () => {
        const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048)]);
        const res = await upload(fx.admin.token, pdf, 'letterhead.pdf');
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/PNG or JPEG/i);
        expect(res.body.message).toMatch(/PDF and SVG stationery are not supported/i);
      });
    });

    it('DOC-LH-07 refuses an SVG — it is a scripting surface', async () => {
      await engineOn(async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
        const res = await upload(fx.admin.token, svg, 'logo.svg');
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/PNG or JPEG/i);
      });
    });

    it('DOC-LH-08 refuses a file RENAMED to .png, because it checks magic bytes', async () => {
      await engineOn(async () => {
        // The mimetype a browser sends is a claim. upload.service.ts trusts the
        // claim; this path does not, because what it accepts is about to be
        // inlined into a rendered document.
        const fake = Buffer.from('GIF89a this is not a png at all');
        const res = await upload(fx.admin.token, fake, 'actually-a-gif.png');
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/PNG or JPEG/i);
      });
    });

    it('DOC-LH-09 refuses an empty upload', async () => {
      await engineOn(async () => {
        const res = await upload(fx.admin.token, Buffer.alloc(0), 'empty.png');
        expect(res.status).toBe(400);
      });
    });
  });

  describe('3. who may change the stationery', () => {
    it('DOC-LH-10 refuses HR, MANAGER and EMPLOYEE the upload', async () => {
      await engineOn(async () => {
        for (const token of [fx.scopedHr.token, fx.manager.token, fx.employee.token]) {
          const res = await upload(token, makePng(1240, 1754));
          expect(res.status).toBe(403);
        }
      });
    });

    it('DOC-LH-11 lets HR READ the list — they design templates against it', async () => {
      await engineOn(async () => {
        const res = await ctx.http().get('/documents/assets').set(bearer(fx.scopedHr.token));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
      });
    });
  });

  describe('4. the safe area and retirement', () => {
    it('DOC-LH-12 adjusts the content-safe area in millimetres', async () => {
      await engineOn(async () => {
        const res = await upload(fx.admin.token, makePng(1240, 1754));
        created.push(res.body.id);

        const updated = await ctx
          .http()
          .put(`/documents/assets/${res.body.id}`)
          .set(bearer(fx.admin.token))
          .send({ safeTopMm: 45, safeBottomMm: 32 });
        expect(updated.status).toBe(200);
        expect(updated.body.safeTopMm).toBe(45);
        expect(updated.body.safeBottomMm).toBe(32);
      });
    });

    it('DOC-LH-13 RETIRES rather than deletes a letterhead a published version pins', async () => {
      await engineOn(async () => {
        const res = await upload(fx.admin.token, makePng(1240, 1754));
        const assetId = res.body.id;
        created.push(assetId);

        const template = await ctx.prisma.documentTemplate.findFirst({
          where: { typeKey: 'SALARY_CERTIFICATE', locale: 'en', branchId: null },
        });
        await ctx.prisma.documentTemplateVersion.updateMany({
          where: { templateId: template!.id, status: 'PUBLISHED' },
          data: { letterheadId: assetId },
        });

        const del = await ctx
          .http()
          .delete(`/documents/assets/${assetId}`)
          .set(bearer(fx.admin.token));
        expect(del.status).toBe(200);
        // Deleting it would break the pin that lets a letter issued last year
        // still show last year's stationery — the FK is RESTRICT for the same
        // reason. Retiring says so instead of failing with a constraint error.
        expect(del.body.message).toMatch(/retired rather than deleted/i);

        const still = await ctx.prisma.documentAsset.findUnique({ where: { id: assetId } });
        expect(still).not.toBeNull();
        expect(still!.isActive).toBe(false);

        await ctx.prisma.documentTemplateVersion.updateMany({
          where: { templateId: template!.id },
          data: { letterheadId: null },
        });
      });
    });
  });

  describe('5. it reaches the page', () => {
    it('DOC-LH-14 draws the letterhead into a rendered preview as an inlined image', async () => {
      await engineOn(async () => {
        const res = await upload(fx.admin.token, makePng(1240, 1754), 'lh.png', {
          safeTopMm: '48',
        });
        created.push(res.body.id);

        const preview = await ctx
          .http()
          .post('/documents/preview/html')
          .set(bearer(fx.admin.token))
          .send({
            typeKey: 'SALARY_CERTIFICATE',
            letterheadId: res.body.id,
            doc: {
              schemaVersion: 1,
              documentType: 'SALARY_CERTIFICATE',
              locale: 'en',
              dir: 'ltr',
              page: {
                size: 'A4',
                orientation: 'portrait',
                margin: { top: 20, right: 18, bottom: 20, left: 18 },
                letterhead: { source: 'company', firstPageOnly: true },
              },
              theme: { followBrand: true },
              body: [{ id: 'h', type: 'heading', props: { html: 'HELLO', level: 1 } }],
            },
          });

        expect(preview.status).toBe(201);
        // INLINED, not linked: the renderer has no network, so a letterhead
        // referenced by URL would silently never paint — which is exactly how
        // the company logo went missing from every letter for years.
        expect(preview.body.html).toContain('data:image/png;base64,');
        expect(preview.body.html).not.toMatch(/background-image:\s*url\(["']?https?:/);
        // The safe area became real padding, so body text cannot sit on the
        // artwork.
        expect(preview.body.html).toContain('48mm');
      });
    });
  });
});
