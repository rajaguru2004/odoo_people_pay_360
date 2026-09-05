import { EmployeesService } from './employees.service';
import { buildEmployeesService } from './employees-service.test-harness';

/**
 * Profile completion has two modes and the fork matters:
 *
 *   flag OFF -> the original hardcoded scoring, so the number a user already
 *               sees does not move the day this feature is deployed;
 *   flag ON  -> `includeInCompletion` fields, evenly weighted over 90%, plus the
 *               same fixed 10% for documents.
 *
 * The old version scored a hardcoded list, so removing a field from the form
 * left the profile permanently "incomplete" because of a field nobody could
 * fill in any more.
 */
describe('EmployeesService — profile completion', () => {
  let prisma: any;
  let templates: any;
  let service: EmployeesService;

  const EMPLOYEE = {
    id: 'emp-1',
    branchId: 'br-1',
    phone: '123',
    address: 'Muscat',
    gender: 'MALE',
    email: 'a@b.co',
    dateOfBirth: new Date('1990-01-01'),
    idCard: 'ID1',
    customFields: {},
  };

  const field = (fieldKey: string, over: Record<string, unknown> = {}) => ({
    fieldKey,
    storage: 'COLUMN',
    includeInCompletion: true,
    ...over,
  });

  const build = (opts: {
    employee?: Record<string, any> | null;
    profile?: Record<string, any> | null;
    documents?: unknown[];
    template?: Record<string, any>;
  }) => {
    prisma = {
      employee: {
        // `in` rather than ??, so an explicit null means "no such employee"
        // instead of falling back to the fixture.
        findUnique: jest
          .fn()
          .mockResolvedValue('employee' in opts ? opts.employee : EMPLOYEE),
      },
      employeeProfile: {
        findUnique: jest.fn().mockResolvedValue(opts.profile ?? null),
      },
      employeeDocument: {
        findMany: jest.fn().mockResolvedValue(opts.documents ?? []),
      },
    };
    templates = {
      resolve: jest
        .fn()
        .mockResolvedValue(opts.template ?? { enabled: false, fields: [] }),
    };
    service = buildEmployeesService({ prisma, templates });
    // Private, but it is the whole unit under test.
    return (service as any).calculateProfileCompletion('emp-1') as Promise<number>;
  };

  it('returns 0 for an employee that does not exist', async () => {
    const score = await build({ employee: null as any });
    expect(score).toBe(0);
  });

  describe('kill switch off — legacy scoring', () => {
    it('scores the six basic fields at 5% each', async () => {
      expect(await build({})).toBe(30);
    });

    it('adds the fixed 10% once both documents are present', async () => {
      expect(await build({ documents: [{}, {}] })).toBe(40);
    });

    it('ignores custom fields entirely', async () => {
      const score = await build({
        employee: { ...EMPLOYEE, customFields: { anything: 'set' } },
      });
      expect(score).toBe(30);
    });
  });

  describe('kill switch on — template scoring', () => {
    it('counts only fields flagged includeInCompletion', async () => {
      const score = await build({
        template: {
          enabled: true,
          fields: [
            field('phone'), // set
            field('address'), // set
            field('religion'), // unset
            field('ethnicity', { includeInCompletion: false }), // not counted
          ],
        },
      });
      // 2 of 3 counted fields filled -> 60% of 90.
      expect(score).toBe(60);
    });

    it('reads custom fields out of the JSONB bag', async () => {
      const score = await build({
        employee: { ...EMPLOYEE, customFields: { jobGrade: 'G4' } },
        template: {
          enabled: true,
          fields: [field('jobGrade', { storage: 'JSONB' })],
        },
      });
      expect(score).toBe(90);
    });

    it('falls back to the profile table for a profile-bound field', async () => {
      const score = await build({
        profile: { nationality: 'Omani' },
        template: { enabled: true, fields: [field('nationality')] },
      });
      expect(score).toBe(90);
    });

    it('treats whitespace and empty arrays as unset', async () => {
      const score = await build({
        employee: { ...EMPLOYEE, customFields: { a: '   ', b: [] } },
        template: {
          enabled: true,
          fields: [field('a', { storage: 'JSONB' }), field('b', { storage: 'JSONB' })],
        },
      });
      expect(score).toBe(0);
    });

    it('counts a boolean false as answered', async () => {
      // "No" is an answer. Treating it as missing would leave a profile stuck
      // below 100% for anyone who is not a GCC national.
      const score = await build({
        employee: { ...EMPLOYEE, customFields: { gccNational: false } },
        template: {
          enabled: true,
          fields: [field('gccNational', { storage: 'JSONB' })],
        },
      });
      expect(score).toBe(90);
    });

    it('reaches 100 with every counted field and both documents', async () => {
      const score = await build({
        documents: [{}, {}],
        template: { enabled: true, fields: [field('phone'), field('address')] },
      });
      expect(score).toBe(100);
    });

    it('scales documents to the whole bar when no field opts in', async () => {
      // Otherwise a template with nothing flagged would report a permanent 10%.
      const score = await build({
        documents: [{}, {}],
        template: { enabled: true, fields: [field('phone', { includeInCompletion: false })] },
      });
      expect(score).toBe(100);
    });
  });
});
