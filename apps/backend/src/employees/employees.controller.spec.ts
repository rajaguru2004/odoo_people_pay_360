import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

/**
 * Self-service update guard on PATCH /employees/:id.
 *
 * WHICH fields an employee may edit is now template data and is enforced in
 * EmployeesService.updateAsSelfService — see employees-self-service-fields.spec.ts
 * for that half, including the proof that the shipped template allows exactly
 * the five fields this controller used to hardcode.
 *
 * What stays here: an employee may only touch their OWN record, and the two
 * preference values the database has no constraint for must be rejected before
 * anything is written. Admin/HR keep full access.
 */
describe('EmployeesController - self-service update whitelist', () => {
  let controller: EmployeesController;
  let service: { update: jest.Mock; updateAsSelfService: jest.Mock };

  const SELF = 'emp-self';
  const OTHER = 'emp-other';
  const employeeUser = (employeeId: string) => ({
    id: `user-${employeeId}`,
    role: 'EMPLOYEE',
    employeeId,
  });

  beforeEach(() => {
    service = {
      update: jest.fn().mockResolvedValue({ id: SELF }),
      updateAsSelfService: jest.fn().mockResolvedValue({ id: SELF }),
    };
    controller = new EmployeesController(
      service as unknown as EmployeesService,
      // Unused by these cases; the hub aggregate has its own spec.
      {} as any,
    );
  });

  it('forbids an employee editing someone else', () => {
    expect(() =>
      controller.update(OTHER, { phone: '999' } as any, employeeUser(SELF)),
    ).toThrow(ForbiddenException);
    expect(service.updateAsSelfService).not.toHaveBeenCalled();
  });

  it('rejects an invalid IANA timezone', () => {
    expect(() =>
      controller.update(SELF, { timezone: 'Not/AZone' } as any, employeeUser(SELF)),
    ).toThrow(BadRequestException);
    expect(service.updateAsSelfService).not.toHaveBeenCalled();
  });

  it('rejects an unknown date format', () => {
    expect(() =>
      controller.update(SELF, { dateFormat: 'DD.MM.YY' } as any, employeeUser(SELF)),
    ).toThrow(BadRequestException);
    expect(service.updateAsSelfService).not.toHaveBeenCalled();
  });

  it('hands a valid self-service patch to the template-aware service path', () => {
    const dto = {
      phone: '12345',
      timezone: 'Asia/Singapore',
      dateFormat: 'MM/DD/YYYY',
      baseSalary: 999999,
    } as any;
    controller.update(SELF, dto, employeeUser(SELF));

    // The controller no longer narrows the payload — it must NOT reach the
    // privileged `update`, and the narrowing itself is asserted in the service
    // spec against the real shipped template.
    expect(service.update).not.toHaveBeenCalled();
    expect(service.updateAsSelfService).toHaveBeenCalledWith(
      SELF,
      dto,
      `user-${SELF}`,
    );
  });

  it('lets an ADMIN pass the full dto through untouched', () => {
    const dto = { baseSalary: 5000, timezone: 'Asia/Kolkata' } as any;
    controller.update('any-id', dto, { id: 'u1', role: 'ADMIN' });
    // The dto is untouched, but the actor still rides along: the privileged
    // path used to omit it, which skipped the template's per-field write rules
    // for HR_MANAGER too.
    expect(service.update).toHaveBeenCalledWith('any-id', dto, 'u1', {
      role: 'ADMIN',
      isSelf: false,
    });
  });

  it('marks an HR_MANAGER as not-self even on their own record', () => {
    // isSelf means "a self-service role acting on its own record". A privileged
    // role editing itself keeps its privileges; treating it as self would
    // narrow an HR_MANAGER to the employee allowlist.
    const dto = { phone: '900' } as any;
    controller.update('emp-9', dto, {
      id: 'u2',
      role: 'HR_MANAGER',
      employeeId: 'emp-9',
    });
    expect(service.update).toHaveBeenCalledWith('emp-9', dto, 'u2', {
      role: 'HR_MANAGER',
      isSelf: false,
    });
  });
});
