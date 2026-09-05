import { BadRequestException } from '@nestjs/common';
import { GradesService } from './grades.service';

/**
 * The salary band on a grade.
 *
 * `assign()` refuses any salary outside `[minSalary, maxSalary]`, so a band
 * whose ceiling sits under its floor is a grade nobody can ever hold: it is
 * accepted at create time and then rejects every assignment, which reads as a
 * bug in the assignment screen rather than in the band somebody typed
 * backwards. `PE-GRADE-04` watched exactly that — a 201 where it expected a 400.
 *
 * Open-ended bands are legitimate and must keep working, which is most of what
 * these cases are about.
 */
describe('GradesService — the salary band', () => {
  const prisma: any = {
    grade: {
      create: jest.fn(async ({ data }: any) => ({ id: 'g1', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'g1', ...data })),
      findUnique: jest.fn(async () => existing),
    },
  };
  const audit: any = { log: jest.fn(async () => undefined) };
  const features: any = { resolve: jest.fn(async () => ({ gradeEnabled: true })) };

  let existing: any;

  const service = () => new GradesService(prisma, audit, features);
  const base = { code: 'OFF1', name: 'Officer', level: 3 };

  beforeEach(() => {
    existing = { id: 'g1', code: 'OFF1', minSalary: 1000, maxSalary: 5000 };
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('refuses a ceiling below the floor, naming both figures', async () => {
      await expect(
        service().create({ ...base, minSalary: 5000, maxSalary: 1000 }, null),
      ).rejects.toThrow(BadRequestException);

      // The message has to carry both ends, or the admin cannot see which one
      // they typed wrong.
      await service()
        .create({ ...base, minSalary: 5000, maxSalary: 1000 }, null)
        .catch((e) => {
          expect(String(e.message)).toContain('5000');
          expect(String(e.message)).toContain('1000');
        });
      expect(prisma.grade.create).not.toHaveBeenCalled();
    });

    it('accepts a band the right way round', async () => {
      await expect(
        service().create({ ...base, minSalary: 1000, maxSalary: 5000 }, null),
      ).resolves.toMatchObject({ success: true });
    });

    it('accepts equal ends — a single-point band is odd but not wrong', async () => {
      await expect(
        service().create({ ...base, minSalary: 3000, maxSalary: 3000 }, null),
      ).resolves.toMatchObject({ success: true });
    });

    it('accepts an open-ended band, which is the common case', async () => {
      for (const band of [
        {},
        { minSalary: 1000 },
        { maxSalary: 5000 },
        { minSalary: null, maxSalary: null },
      ]) {
        jest.clearAllMocks();
        await expect(service().create({ ...base, ...band }, null)).resolves.toMatchObject({
          success: true,
        });
      }
    });
  });

  describe('update', () => {
    it('refuses moving the ceiling under the floor already on the row', async () => {
      // The patch carries only one end; the other comes from the record. A
      // check against the patch alone would let this through.
      await expect(service().update('g1', { maxSalary: 500 }, null)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.grade.update).not.toHaveBeenCalled();
    });

    it('refuses moving the floor above the ceiling already on the row', async () => {
      await expect(service().update('g1', { minSalary: 9000 }, null)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows a patch that keeps the band ordered', async () => {
      await expect(
        service().update('g1', { maxSalary: 8000 }, null),
      ).resolves.toMatchObject({ success: true });
    });

    it('allows clearing an end, which reopens the band', async () => {
      await expect(
        service().update('g1', { maxSalary: null }, null),
      ).resolves.toMatchObject({ success: true });
    });
  });
});
