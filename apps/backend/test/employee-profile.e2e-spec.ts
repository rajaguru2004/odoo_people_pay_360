import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFixtures, Fixtures } from './utils/fixtures';
import { assertDevDb } from './utils/mcp-harness';

/**
 * Employee extended-profile flow through the REAL request pipeline
 * (ValidationPipe whitelist/forbidNonWhitelisted included) — regression for the
 * bank-details save bug where the frontend sent `bankAccountHolder` /
 * `healthInsuranceNumber` but the DTO didn't whitelist them → 400.
 */
describe('employee profile — bank details (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;

  beforeAll(async () => {
    assertDevDb();
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    await ctx.prisma.employeeProfile.deleteMany({ where: { employeeId: fx.empAId } });
    await fx.cleanup();
    await ctx.app.close();
  }, 120000);

  const auth = () => ({ Authorization: `Bearer ${fx.globalAdmin.token}` });

  it('saves the full bank tab payload (incl. holder name + health insurance)', async () => {
    const payload = {
      bankName: 'Vietcombank',
      bankAccountNumber: '0123456789',
      bankAccountHolderName: 'ALICE BRANCHA',
      bankBranch: 'Hanoi',
      taxCode: 'TAX-123',
      socialInsuranceNumber: 'SI-123',
      healthInsuranceNumber: 'HI-123',
    };
    const res = await ctx
      .http()
      .patch(`/employees/${fx.empAId}/profile`)
      .set(auth())
      .send(payload);
    expect(res.status).toBe(200);

    const row = await ctx.prisma.employeeProfile.findUnique({
      where: { employeeId: fx.empAId },
    });
    expect(row?.bankName).toBe('Vietcombank');
    expect(row?.bankAccountNumber).toBe('0123456789');
    expect(row?.bankAccountHolderName).toBe('ALICE BRANCHA');
    expect(row?.bankBranch).toBe('Hanoi');
    expect(row?.taxCode).toBe('TAX-123');
    expect(row?.healthInsuranceNumber).toBe('HI-123');
  });

  it('GET profile returns the saved bank fields under profile', async () => {
    const res = await ctx.http().get(`/employees/${fx.empAId}/profile`).set(auth());
    expect(res.status).toBe(200);
    const profile = res.body?.data?.profile;
    expect(profile?.bankAccountHolderName).toBe('ALICE BRANCHA');
    expect(profile?.healthInsuranceNumber).toBe('HI-123');
  });

  it('still rejects unknown properties (whitelist intact)', async () => {
    const res = await ctx
      .http()
      .patch(`/employees/${fx.empAId}/profile`)
      .set(auth())
      .send({ bankName: 'X', totallyBogusField: 'y' });
    expect(res.status).toBe(400);
  });

  describe('document upload — persistent storage (MinIO S3)', () => {
    let docId: string;
    let fileUrl: string;

    it('uploads a document and stores it in S3 (absolute URL, not local /uploads)', async () => {
      const res = await ctx
        .http()
        .post(`/employees/${fx.empAId}/documents`)
        .set(auth())
        .field('documentType', 'Certificate')
        .field('description', 'e2e storage test')
        .attach('file', Buffer.from('%PDF-1.4 e2e test'), {
          filename: 'e2e-storage-test.pdf',
          contentType: 'application/pdf',
        });
      expect(res.status).toBe(201);
      docId = res.body?.data?.id;
      fileUrl = res.body?.data?.fileUrl;
      expect(docId).toBeTruthy();
      // Core of the fix: file must live in object storage, not the local disk.
      expect(fileUrl).toMatch(/^https?:\/\//);
      expect(fileUrl).not.toMatch(/^\/uploads\//);
    });

    it('the stored object is publicly downloadable', async () => {
      const download = await fetch(fileUrl);
      expect(download.status).toBe(200);
      expect(await download.text()).toContain('e2e test');
    });

    it('deleting the document removes the DB row (storage cleanup best-effort)', async () => {
      const res = await ctx
        .http()
        .delete(`/employees/${fx.empAId}/documents/${docId}`)
        .set(auth());
      expect(res.status).toBe(200);
      const row = await ctx.prisma.employeeDocument.findUnique({ where: { id: docId } });
      expect(row).toBeNull();
    });
  });
});
