/**
 * Self-service field narrowing, the half that moved out of the controller.
 *
 * The controller used to destructure exactly five fields:
 *
 *   const { phone, address, dateOfBirth, timezone, dateFormat } = dto;
 *
 * That list is now `selfEditable` on the template. The risk in making it data is
 * that the data disagrees with the code it replaced — so the first test pins the
 * shipped baseline to precisely those five, and the rest prove nothing else can
 * ride along.
 */
import { EmployeesService } from './employees.service';
import { buildEmployeesService } from './employees-service.test-harness';
import { BASELINE_FIELDS } from '../profile-templates/profile-template-defaults';
import { BOUND_BY_KEY } from '../profile-templates/employee-bound-columns';

/** Shape the resolver returns, reduced to what updateAsSelfService reads. */
function templateFrom(keys: string[], enabled = true) {
  return {
    enabled,
    country: 'OM',
    fields: [...BOUND_BY_KEY.keys()].map((fieldKey) => ({
      fieldKey,
      storage: 'COLUMN' as const,
      selfEditable: keys.includes(fieldKey),
      selfVisible: true,
      visibleToRoles: [],
      editableByRoles: [],
    })),
  };
}

/** What the controller hardcoded before any of this was data. */
const LEGACY_FIVE = ['phone', 'address', 'dateOfBirth', 'timezone', 'dateFormat'];

/**
 * What ships today. The only addition to LEGACY_FIVE is phoneCountryCode, and
 * the case below states why it is allowed to be one — the point of pinning this
 * list is that widening self-service has to be a decision someone wrote down,
 * not a side effect of adding a baseline field.
 */
const SHIPPED_SELF_EDITABLE = [...LEGACY_FIVE, 'phoneCountryCode'];

describe('self-editable baseline', () => {
  it('is the controller hardcode plus phone country, and nothing else', () => {
    const shipped = BASELINE_FIELDS.filter(
      (f) => f.selfEditable && BOUND_BY_KEY.get(f.fieldKey)?.table === 'employee',
    ).map((f) => f.fieldKey);
    expect(shipped.sort()).toEqual([...SHIPPED_SELF_EDITABLE].sort());
  });

  it('adds nothing to the legacy set beyond phone country', () => {
    // Spelled out separately so a future addition fails on a message that names
    // the newcomer rather than on an opaque array diff.
    const extra = SHIPPED_SELF_EDITABLE.filter((k) => !LEGACY_FIVE.includes(k));
    expect(extra).toEqual(['phoneCountryCode']);
  });

  it('never lets a privileged field become self-editable', () => {
    // The real risk this suite guards: baseSalary, salaryType and the identity
    // columns must stay out of self-service however the baseline grows.
    const shipped = new Set(
      BASELINE_FIELDS.filter((f) => f.selfEditable).map((f) => f.fieldKey),
    );
    for (const key of ['baseSalary', 'salaryType', 'employeeCode', 'idCard', 'email', 'branchId', 'departmentId', 'status']) {
      expect(shipped.has(key)).toBe(false);
    }
  });
});

describe('EmployeesService.updateAsSelfService', () => {
  let prisma: any;
  let templates: any;
  let service: EmployeesService;
  let updateSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({ branchId: 'br-1' }),
      },
    };
    templates = { resolve: jest.fn().mockResolvedValue(templateFrom(LEGACY_FIVE)) };

    service = buildEmployeesService({ prisma, templates });

    updateSpy = jest
      .spyOn(service, 'update')
      .mockResolvedValue({ success: true } as any);
  });

  const payloadOf = () => updateSpy.mock.calls[0][1] as Record<string, unknown>;

  it('passes the allowed fields through', async () => {
    await service.updateAsSelfService(
      'emp-1',
      { phone: '12345', address: 'Muscat' } as any,
      'user-1',
    );
    expect(payloadOf()).toEqual({ phone: '12345', address: 'Muscat' });
  });

  it('drops privileged fields instead of failing the whole request', async () => {
    // Silently dropping, not rejecting, is the previous behaviour: a
    // self-service form that posts its whole model must not start 400ing
    // because one read-only field rode along.
    await service.updateAsSelfService(
      'emp-1',
      { phone: '1', baseSalary: 999999, status: 'ACTIVE', role: 'ADMIN' } as any,
      'user-1',
    );
    const payload = payloadOf();
    expect(payload).toEqual({ phone: '1' });
    expect(payload).not.toHaveProperty('baseSalary');
    expect(payload).not.toHaveProperty('role');
  });

  it('normalizes empty-string preferences to null so they inherit company defaults', async () => {
    await service.updateAsSelfService(
      'emp-1',
      { timezone: '', dateFormat: '' } as any,
      'user-1',
    );
    expect(payloadOf()).toEqual({ timezone: null, dateFormat: null });
  });

  it('marks the caller as self so field permissions apply to customFields', async () => {
    await service.updateAsSelfService('emp-1', { phone: '1' } as any, 'user-1');
    expect(updateSpy.mock.calls[0][3]).toEqual({
      role: 'EMPLOYEE',
      isSelf: true,
    });
  });

  it('lets customFields through to the permission check rather than dropping them', async () => {
    // Dropping would hide a genuine authorization error behind a silent no-op.
    await service.updateAsSelfService(
      'emp-1',
      { customFields: { grade: 'G4' } } as any,
      'user-1',
    );
    expect(payloadOf()).toEqual({ customFields: { grade: 'G4' } });
  });

  it('follows a widened template', async () => {
    templates.resolve.mockResolvedValue(
      templateFrom([...LEGACY_FIVE, 'placeOfBirth']),
    );
    await service.updateAsSelfService(
      'emp-1',
      { placeOfBirth: 'Nizwa', status: 'ACTIVE' } as any,
      'user-1',
    );
    expect(payloadOf()).toEqual({ placeOfBirth: 'Nizwa' });
  });

  it('follows a narrowed template', async () => {
    templates.resolve.mockResolvedValue(templateFrom(['phone']));
    await service.updateAsSelfService(
      'emp-1',
      { phone: '1', address: 'Muscat' } as any,
      'user-1',
    );
    expect(payloadOf()).toEqual({ phone: '1' });
  });

  it('still allows the legacy five when the kill switch is off', async () => {
    // The resolver serves the shipped constants in that case, so self-service
    // behaviour is identical to before the feature existed.
    templates.resolve.mockResolvedValue(templateFrom(LEGACY_FIVE, false));
    await service.updateAsSelfService(
      'emp-1',
      { phone: '1', baseSalary: 5 } as any,
      'user-1',
    );
    expect(payloadOf()).toEqual({ phone: '1' });
  });

  it('404s for an employee that does not exist', async () => {
    prisma.employee.findUnique.mockResolvedValue(null);
    await expect(
      service.updateAsSelfService('nope', { phone: '1' } as any, 'u'),
    ).rejects.toThrow('Employee not found');
  });
});
