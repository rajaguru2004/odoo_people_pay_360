/**
 * The kill switch has to be honest on the READ path too.
 *
 * `findOne(id, actor)` projects per-field visibility, and the controller passes
 * an actor on every request — whether or not the feature is enabled. The shipped
 * baseline marks baseSalary, salaryType, overtimePolicyId and
 * attendanceExternalId as ADMIN/HR_MANAGER-only and hidden from self.
 *
 * So while `legacy()` copied those role gates through verbatim, turning the
 * feature OFF did not restore prior behaviour: a MANAGER reading a direct
 * report lost Base Salary, and an employee lost it on their own record, on the
 * default configuration. The regression was invisible because every template
 * test runs with the flag ON.
 *
 * These cases pin the contract that "off" means off.
 */
import { ProfileTemplateResolverService } from './profile-template-resolver.service';
import { BASELINE_FIELDS } from './profile-template-defaults';

/** The four the baseline restricts — the ones that made this a regression. */
const RESTRICTED = [
  'baseSalary',
  'salaryType',
  'overtimePolicyId',
  'attendanceExternalId',
];

function resolverWith(enabled: boolean) {
  const settings = {
    getSetting: jest.fn().mockResolvedValue(enabled ? 'true' : 'false'),
  };
  // Nothing seeded: resolve() falls through to legacy() in both states, which
  // is precisely the code path under test.
  const prisma = {
    profileTemplate: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const Ctor = ProfileTemplateResolverService as unknown as new (
    ...args: any[]
  ) => ProfileTemplateResolverService;
  return new Ctor(prisma, settings);
}

describe('resolver — kill switch OFF neutralises role gates', () => {
  it('reports itself disabled and serving the legacy baseline', async () => {
    const tpl = await resolverWith(false).resolve(null);
    expect(tpl.enabled).toBe(false);
    expect(tpl.source).toBe('LEGACY_BASELINE');
  });

  it('leaves no field restricted by role', async () => {
    const tpl = await resolverWith(false).resolve(null);
    const restricted = tpl.fields
      .filter((f) => (f.visibleToRoles ?? []).length > 0)
      .map((f) => f.fieldKey);
    expect(restricted).toEqual([]);
  });

  it('leaves no field hidden from the employee themself', async () => {
    const tpl = await resolverWith(false).resolve(null);
    const hidden = tpl.fields
      .filter((f) => f.selfVisible === false)
      .map((f) => f.fieldKey);
    expect(hidden).toEqual([]);
  });

  it('specifically returns base salary to MANAGER and self', async () => {
    // The concrete regression: a manager opening a direct report's page, and an
    // employee opening their own, both lost the Base Salary field.
    const tpl = await resolverWith(false).resolve(null);
    for (const key of RESTRICTED) {
      const field = tpl.fields.find((f) => f.fieldKey === key)!;
      expect(field.visibleToRoles).toEqual([]);
      expect(field.selfVisible).toBe(true);
    }
  });

  it('does not widen self-service on the way', async () => {
    // selfEditable is deliberately NOT neutralised — forcing it would grant
    // write access rather than restore read access. The legacy allowlist that
    // updateAsSelfService narrows to is exactly these values.
    const tpl = await resolverWith(false).resolve(null);
    const editable = tpl.fields
      .filter((f) => f.selfEditable)
      .map((f) => f.fieldKey)
      .sort();
    expect(editable).toEqual(
      BASELINE_FIELDS.filter((f) => f.selfEditable)
        .map((f) => f.fieldKey)
        .sort(),
    );
    for (const key of RESTRICTED) {
      expect(editable).not.toContain(key);
    }
  });
});

describe('resolver — kill switch ON keeps the gates', () => {
  it('restricts the privileged fields once the feature is enabled', async () => {
    // Tightening reads is a consequence of turning the feature ON. That is what
    // the switch is for; the merge does not get to do it unasked.
    const tpl = await resolverWith(true).resolve(null);
    expect(tpl.enabled).toBe(true);
    for (const key of RESTRICTED) {
      const field = tpl.fields.find((f) => f.fieldKey === key)!;
      expect(field.visibleToRoles).toEqual(['ADMIN', 'HR_MANAGER']);
      expect(field.selfVisible).toBe(false);
    }
  });
});
