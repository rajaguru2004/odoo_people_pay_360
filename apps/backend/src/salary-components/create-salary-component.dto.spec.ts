import { ValidationPipe } from '@nestjs/common';
import { CreateSalaryComponentDto } from './dto/create-salary-component.dto';

/**
 * componentType stopped being a closed enum so an admin can define HRA, DA or
 * anything else their payslip needs. That freedom is bounded: the value is a
 * machine key stored in a VarChar(50), so it stays an uppercase slug.
 */
describe('CreateSalaryComponentDto — componentType', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const run = (componentType: unknown) =>
    pipe.transform(
      { employeeId: 'e1', amount: 100, componentType },
      { type: 'body', metatype: CreateSalaryComponentDto } as any,
    );

  it.each(['BASIC', 'HRA', 'DA', 'SPECIAL_ALLOWANCE', 'PAYROLL_CONFIG'])(
    'accepts %p',
    async (code) => {
      await expect(run(code)).resolves.toMatchObject({ componentType: code });
    },
  );

  it('uppercases and trims, so a label-derived code round-trips', async () => {
    await expect(run('  hra  ')).resolves.toMatchObject({
      componentType: 'HRA',
    });
  });

  it.each([
    ['', 'empty'],
    ['9TH_MONTH', 'leading digit'],
    ['HAS SPACE', 'a space'],
    ['DROP;TABLE', 'punctuation'],
    ['A'.repeat(51), 'longer than the column'],
  ])('rejects %p (%s)', async (code) => {
    await expect(run(code)).rejects.toThrow();
  });
});
