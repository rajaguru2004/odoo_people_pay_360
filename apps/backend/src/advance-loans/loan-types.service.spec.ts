import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LoanTypesService } from './loan-types.service';
import { CreateLoanTypeDto } from './dto/loan-type.dto';

/**
 * The product catalogue's rules.
 *
 * Everything interesting here is a cross-field rule the columns cannot state,
 * and every one of them exists because the combination it forbids produces a
 * product that refuses every request filed under it — a trap an administrator
 * would only discover through a borrower.
 *
 * Prisma is a hand-rolled double rather than a mock library: these are pure
 * decision rules, and the point is what reaches the database, not how.
 */
describe('LoanTypesService', () => {
  const rows = new Map<string, any>();
  let loanCount = 0;
  let lastCreate: any;
  let lastUpdate: any;

  const prisma: any = {
    loanType: {
      findFirst: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      findMany: jest.fn(async () => [...rows.values()]),
      create: jest.fn(async (args: any) => {
        lastCreate = args.data;
        if ([...rows.values()].some((r) => r.code === args.data.code)) {
          throw new Prisma.PrismaClientKnownRequestError('dupe', {
            code: 'P2002',
            clientVersion: '5.22.0',
          });
        }
        const row = { id: 'lt-new', ...args.data };
        rows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async (args: any) => {
        lastUpdate = args.data;
        const row = { ...rows.get(args.where.id), ...args.data };
        rows.set(args.where.id, row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        rows.delete(where.id);
        return {};
      }),
    },
    advanceLoanRequest: { count: jest.fn(async () => loanCount) },
    // The in-use guard counts with $queryRaw so the branch-scoping middleware
    // cannot narrow a referential-integrity check.
    $queryRaw: jest.fn(async () => [{ count: BigInt(loanCount) }]),
  };

  const service = new LoanTypesService(prisma);

  /** A product that satisfies every cross-field rule, to vary one at a time. */
  const dto = (over: Partial<CreateLoanTypeDto> = {}): CreateLoanTypeDto =>
    ({
      code: 'VEHICLE',
      name: 'Vehicle Loan',
      category: 'LOAN',
      defaultInstallments: 12,
      maxInstallments: 24,
      ...over,
    }) as CreateLoanTypeDto;

  const existing = (over: Record<string, unknown> = {}) => ({
    id: 'lt-1',
    code: 'PERSONAL',
    name: 'Personal Loan',
    category: 'LOAN',
    isActive: true,
    interestMethod: 'NONE',
    interestRate: new Prisma.Decimal(0),
    defaultInstallments: 12,
    maxInstallments: 24,
    graceMode: 'NONE',
    gracePeriods: 0,
    ...over,
  });

  beforeEach(() => {
    rows.clear();
    loanCount = 0;
    lastCreate = undefined;
    lastUpdate = undefined;
    jest.clearAllMocks();
  });

  describe('a product whose terms contradict each other is refused', () => {
    it('refuses a rate with no interest method — the rate would be silently ignored', async () => {
      await expect(
        service.create(dto({ interestMethod: 'NONE', interestRate: 8 })),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses an interest method with a zero rate — it is interest-free with extra steps', async () => {
      await expect(
        service.create(dto({ interestMethod: 'FLAT', interestRate: 0 })),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a coherent interest-bearing product', async () => {
      await service.create(
        dto({ interestMethod: 'REDUCING_BALANCE', interestRate: 8.375 }),
      );
      // 3dp survives the DTO bound and reaches the column unrounded.
      expect(lastCreate.interestRate).toBe(8.375);
    });

    it('refuses a default term longer than the product allows', async () => {
      // Otherwise every request defaults to a term the same product refuses.
      await expect(
        service.create(dto({ defaultInstallments: 36, maxInstallments: 24 })),
      ).rejects.toThrow(/default repayment period \(36\).*allows \(24\)/i);
    });

    it('accepts a default term exactly at the maximum', async () => {
      await service.create(dto({ defaultInstallments: 24, maxInstallments: 24 }));
      expect(lastCreate.defaultInstallments).toBe(24);
    });

    it('refuses a multi-instalment ADVANCE product', async () => {
      // An advance is recovered in one deduction by definition.
      await expect(
        service.create(
          dto({ category: 'ADVANCE', defaultInstallments: 1, maxInstallments: 6 }),
        ),
      ).rejects.toThrow(/recovered in one deduction/i);
    });

    it('accepts a single-instalment ADVANCE product', async () => {
      await service.create(
        dto({
          code: 'SALARY_ADVANCE',
          category: 'ADVANCE',
          defaultInstallments: 1,
          maxInstallments: 1,
        }),
      );
      expect(lastCreate.category).toBe('ADVANCE');
    });

    it('refuses a grace mode with no grace periods', async () => {
      await expect(
        service.create(dto({ graceMode: 'MORATORIUM_FULL', gracePeriods: 0 })),
      ).rejects.toThrow(/needs at least one grace period/i);
    });

    it('refuses grace periods with no grace mode', async () => {
      await expect(
        service.create(dto({ graceMode: 'NONE', gracePeriods: 3 })),
      ).rejects.toThrow(/grace mode is NONE/i);
    });
  });

  describe('the code is the stable key', () => {
    it('names the clash rather than leaking a driver error', async () => {
      await service.create(dto());
      await expect(service.create(dto())).rejects.toThrow(ConflictException);
      await expect(service.create(dto())).rejects.toThrow(/code VEHICLE already exists/);
    });
  });

  describe('an update is judged on the state it produces, not on the patch', () => {
    it('refuses lowering maxInstallments below an untouched defaultInstallments', async () => {
      // The patch alone looks harmless — this is exactly the case that gets
      // through when only the incoming fields are validated.
      rows.set('lt-1', existing({ defaultInstallments: 12, maxInstallments: 24 }));

      await expect(service.update('lt-1', { maxInstallments: 6 })).rejects.toThrow(
        /default repayment period \(12\).*allows \(6\)/i,
      );
    });

    it('refuses clearing the interest method while a rate stands', async () => {
      rows.set(
        'lt-1',
        existing({ interestMethod: 'FLAT', interestRate: new Prisma.Decimal(8) }),
      );

      await expect(service.update('lt-1', { interestMethod: 'NONE' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows a coherent pair changed together', async () => {
      rows.set(
        'lt-1',
        existing({ interestMethod: 'FLAT', interestRate: new Prisma.Decimal(8) }),
      );

      await service.update('lt-1', { interestMethod: 'NONE', interestRate: 0 });
      expect(lastUpdate).toMatchObject({ interestMethod: 'NONE', interestRate: 0 });
    });

    it('leaves untouched fields out of the write entirely', async () => {
      // `undefined` means "leave alone"; only what was sent may be written.
      rows.set('lt-1', existing());

      await service.update('lt-1', { name: 'Renamed' });

      expect(Object.keys(lastUpdate)).toEqual(['name']);
    });

    it('passes an explicit null through, so a ceiling can be REMOVED', async () => {
      // Without this a maxAmount, once set, could never be lifted.
      rows.set('lt-1', existing({ maxAmount: new Prisma.Decimal(50000) }));

      await service.update('lt-1', { maxAmount: null });

      expect(lastUpdate).toHaveProperty('maxAmount', null);
    });

    it('404s on a product that is not visible to the caller', async () => {
      await expect(service.update('lt-missing', { name: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('retirement', () => {
    it('deactivates rather than deleting', async () => {
      rows.set('lt-1', existing());
      await service.setActive('lt-1', false);
      expect(lastUpdate).toEqual({ isActive: false });
    });

    it('counts references outside the branch middleware, not through it', async () => {
      // The middleware narrows `count()` to the caller's branch, so a product
      // referenced from another branch looked unused and the delete then hit
      // the FK as a raw driver error.
      rows.set('lt-1', existing());
      loanCount = 1;

      await expect(service.remove('lt-1')).rejects.toThrow(ConflictException);
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(
        prisma.advanceLoanRequest.count,
      ).not.toHaveBeenCalled();
    });

    it('refuses to delete a product that loans still reference, and says how many', async () => {
      // The FK is `onDelete: Restrict`, so without this the caller would get a
      // raw driver error instead of the reason and the remedy.
      rows.set('lt-1', existing());
      loanCount = 3;

      await expect(service.remove('lt-1')).rejects.toThrow(ConflictException);
      await expect(service.remove('lt-1')).rejects.toThrow(
        /3 loans still reference it.*Deactivate it instead/is,
      );
    });

    it('deletes a product nothing has ever used', async () => {
      rows.set('lt-1', existing());
      loanCount = 0;

      await expect(service.remove('lt-1')).resolves.toEqual({ success: true });
      expect(rows.has('lt-1')).toBe(false);
    });
  });

  describe('listing', () => {
    it('hides retired products by default', async () => {
      await service.findAll();
      expect(prisma.loanType.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });

    it('shows them when asked', async () => {
      await service.findAll(true);
      expect(prisma.loanType.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });
});
