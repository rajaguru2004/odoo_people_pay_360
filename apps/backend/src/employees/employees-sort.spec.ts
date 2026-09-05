import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { EmployeesService } from './employees.service';
import { buildEmployeesService } from './employees-service.test-harness';
import { QueryEmployeesDto } from './dto/query-employees.dto';

/**
 * `sortBy` used to be a free `@IsString()` that was interpolated straight into
 * Prisma's `orderBy` — so `GET /employees?sortBy=nope` reached the driver and
 * came back as a 500 with a Prisma stack, not a validation error.
 *
 * Two layers now: the DTO allowlist rejects it at the pipe for HTTP callers,
 * and the service falls back to the default for callers that bypass the pipe
 * (MCP tools, other services).
 */
describe('employee list sorting', () => {
  describe('QueryEmployeesDto', () => {
    const dtoFor = (sortBy: unknown) =>
      plainToInstance(QueryEmployeesDto, { sortBy });

    it('rejects a sort field that is not on the allowlist', async () => {
      const errors = await validate(dtoFor('nope'));
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('sortBy');
    });

    it('rejects a relation path, which Prisma would also refuse', async () => {
      const errors = await validate(dtoFor('department.name'));
      expect(errors).toHaveLength(1);
    });

    it('accepts every allowlisted field', async () => {
      for (const f of [
        'employeeCode',
        'fullName',
        'email',
        'position',
        'status',
        'gender',
        'startDate',
        'baseSalary',
        'createdAt',
        'updatedAt',
      ]) {
        expect(await validate(dtoFor(f))).toEqual([]);
      }
    });
  });

  describe('EmployeesService.findAll', () => {
    let prisma: any;
    let service: EmployeesService;

    beforeEach(() => {
      prisma = {
        employee: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
      };
      // findAll touches only `prisma`. The harness fills every other dependency
      // by name, so adding one to the service does not break this spec — and,
      // unlike a positional list, cannot silently land in the wrong slot.
      service = buildEmployeesService({ prisma });
    });

    const orderByOf = () => prisma.employee.findMany.mock.calls[0][0].orderBy;

    it('honours an allowlisted field', async () => {
      await service.findAll({ sortBy: 'fullName', sortOrder: 'asc' } as any);
      expect(orderByOf()).toEqual({ fullName: 'asc' });
    });

    it('falls back to createdAt for a key the pipe never saw', async () => {
      await service.findAll({ sortBy: 'nope', sortOrder: 'desc' } as any);
      expect(orderByOf()).toEqual({ createdAt: 'desc' });
    });

    it('falls back for a prototype key rather than passing it to Prisma', async () => {
      await service.findAll({ sortBy: 'constructor' } as any);
      expect(orderByOf()).toEqual({ createdAt: 'desc' });
    });
  });
});
