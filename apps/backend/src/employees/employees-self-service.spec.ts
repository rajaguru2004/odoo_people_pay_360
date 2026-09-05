import { ForbiddenException } from '@nestjs/common';
import { EmployeesController } from './employees.controller';

/**
 * Self-service write access on employee records.
 *
 * MANAGER was absent from @Roles on the write endpoints, so a manager got a
 * bare 403 "Forbidden resource" when editing their *own* profile or uploading
 * their own documents — while reads worked, because GET :id/documents did list
 * MANAGER. Adding MANAGER to the guard fixes that, but must not let a manager
 * write to a colleague's record, hence the paired self-checks asserted here.
 */
describe('EmployeesController — self-service writes', () => {
  const OWN_ID = 'emp-self';
  const OTHER_ID = 'emp-colleague';

  const service = {
    updateEmployeeProfile: jest.fn().mockResolvedValue({ ok: true }),
    uploadDocument: jest.fn().mockResolvedValue({ ok: true }),
    deleteDocument: jest.fn().mockResolvedValue({ ok: true }),
    update: jest.fn().mockResolvedValue({ ok: true }),
  };

  // The hub aggregate is a second constructor arg but plays no part in these
  // self-service cases, so it is stubbed rather than mocked out method by method.
  const controller = new EmployeesController(service as any, {} as any);

  const asRole = (role: string) => ({
    id: 'user-1',
    role,
    employeeId: OWN_ID,
    departmentId: 'dept-1',
  });

  beforeEach(() => jest.clearAllMocks());

  describe('PATCH :id/profile', () => {
    it('lets a MANAGER update their own profile', () => {
      expect(() =>
        controller.updateProfile(asRole('MANAGER'), OWN_ID, {} as any),
      ).not.toThrow();
      // The actor is the point, not incidental: this route used to apply no
      // field permissions at all, so a self-service caller could write taxCode
      // and bank details through it.
      expect(service.updateEmployeeProfile).toHaveBeenCalledWith(OWN_ID, {}, {
        role: 'MANAGER',
        isSelf: true,
      });
    });

    it("blocks a MANAGER from updating a colleague's profile", () => {
      expect(() =>
        controller.updateProfile(asRole('MANAGER'), OTHER_ID, {} as any),
      ).toThrow(ForbiddenException);
      expect(service.updateEmployeeProfile).not.toHaveBeenCalled();
    });

    it("blocks an EMPLOYEE from updating a colleague's profile", () => {
      expect(() =>
        controller.updateProfile(asRole('EMPLOYEE'), OTHER_ID, {} as any),
      ).toThrow(ForbiddenException);
    });

    it("lets HR_MANAGER update anyone's profile", () => {
      expect(() =>
        controller.updateProfile(asRole('HR_MANAGER'), OTHER_ID, {} as any),
      ).not.toThrow();
      // isSelf false: HR_MANAGER is not a self-service role, so editing a
      // colleague keeps its privileges rather than being narrowed to "own".
      expect(service.updateEmployeeProfile).toHaveBeenCalledWith(OTHER_ID, {}, {
        role: 'HR_MANAGER',
        isSelf: false,
      });
    });
  });

  describe('POST :id/documents', () => {
    const file = { originalname: 'cv.pdf' } as any;

    it('lets a MANAGER upload their own document', () => {
      expect(() =>
        controller.uploadDocument(OWN_ID, file, 'CV', '', asRole('MANAGER')),
      ).not.toThrow();
      expect(service.uploadDocument).toHaveBeenCalled();
    });

    it('blocks a MANAGER uploading against another employee', () => {
      expect(() =>
        controller.uploadDocument(OTHER_ID, file, 'CV', '', asRole('MANAGER')),
      ).toThrow(ForbiddenException);
      expect(service.uploadDocument).not.toHaveBeenCalled();
    });
  });
});
