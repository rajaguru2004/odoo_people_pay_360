import { ValidationPipe } from '@nestjs/common';
import { CreateLegalDocumentDto } from './create-legal-document.dto';

describe('CreateLegalDocumentDto — nationality', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const base = {
    employeeId: '11111111-1111-4111-8111-111111111111',
    documentNumber: 'V-1',
    documentType: 'Employment Visa',
    country: 'Oman',
    issueDate: '2026-01-01',
    expiryDate: '2028-01-01',
  };

  const run = (nationality: unknown) =>
    pipe.transform(
      { ...base, nationality },
      { type: 'body', metatype: CreateLegalDocumentDto } as any,
    );

  it('is optional', async () => {
    await expect(
      pipe.transform(base, { type: 'body', metatype: CreateLegalDocumentDto } as any),
    ).resolves.toMatchObject({ nationality: undefined });
  });

  it.each(['IN', 'OM', 'US'])('accepts ISO-3166 alpha-2 code %p', async (code) => {
    await expect(run(code)).resolves.toMatchObject({ nationality: code });
  });

  it.each([
    ['India', 'a full country name'],
    ['XX', 'not a real ISO code'],
    ['I', 'one letter'],
  ])('rejects %p (%s)', async (value) => {
    await expect(run(value)).rejects.toThrow();
  });
});
