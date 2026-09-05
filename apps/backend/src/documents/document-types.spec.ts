import {
  DOCUMENT_TYPES,
  documentTypesForRole,
  getDocumentType,
  roleMaySeeSensitivity,
  sampleContext,
} from './document-types';

/**
 * Drift guard for the document catalogue, in the style of
 * system-settings-registry.spec.ts.
 *
 * The catalogue is code precisely so that it can be checked mechanically. Every
 * rule here is one that, left unchecked, produces a document type that looks
 * fine in the gallery and fails at generation — or worse, renders blank and is
 * sent to a bank.
 */

const ROLES = ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'];

describe('DOCUMENT_TYPES', () => {
  it('has unique keys', () => {
    const keys = DOCUMENT_TYPES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses only the four roles this product has', () => {
    // There is no SUPER_ADMIN and no permissions table here. A role named in
    // the catalogue that RolesGuard has never heard of silently denies
    // everyone.
    for (const t of DOCUMENT_TYPES) {
      for (const role of t.allowedRoles) {
        expect(ROLES).toContain(role);
      }
    }
  });

  it('gives every variable a sample value', () => {
    // A variable with no sample renders blank in the sample preview, and an
    // admin reasonably concludes the token is broken rather than that the
    // preview has no data for it.
    for (const t of DOCUMENT_TYPES) {
      for (const v of t.variables) {
        expect({ type: t.key, name: v.name, sample: v.sample }).toEqual(
          expect.objectContaining({ sample: expect.anything() }),
        );
      }
    }
  });

  it('gives every table variable its columns', () => {
    for (const t of DOCUMENT_TYPES) {
      for (const v of t.variables.filter((x) => x.type === 'table')) {
        expect(v.columns && v.columns.length).toBeGreaterThan(0);
        expect(Array.isArray(v.sample)).toBe(true);
      }
    }
  });

  it('names every variable uniquely within a type', () => {
    for (const t of DOCUMENT_TYPES) {
      const names = t.variables.map((v) => v.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('declares at least one locale, and English among them', () => {
    for (const t of DOCUMENT_TYPES) {
      expect(t.defaultLocales.length).toBeGreaterThan(0);
      expect(t.defaultLocales).toContain('en');
    }
  });

  it('lets every self-service type be reached by EMPLOYEE', () => {
    // selfService means "an employee may generate this for THEMSELVES". If the
    // role is not in allowedRoles the route refuses before self-service is ever
    // considered, and the flag is a lie.
    for (const t of DOCUMENT_TYPES.filter((x) => x.selfService)) {
      expect(t.allowedRoles).toContain('EMPLOYEE');
    }
  });

  it('never marks a RESTRICTED type as bulk', () => {
    // Discipline and settlement documents are generated one at a time, with
    // intent. A bulk run of warning letters is not a feature.
    for (const t of DOCUMENT_TYPES.filter((x) => x.sensitivity === 'RESTRICTED')) {
      expect(t.cardinality).toBe('single');
    }
  });

  it('only lets EMPLOYEE-subject types be bulk', () => {
    // A batch of PAYROLL_REGISTER is nonsense — there is one register per run.
    for (const t of DOCUMENT_TYPES.filter((x) => x.cardinality === 'bulk')) {
      expect(t.subjectType).toBe('EMPLOYEE');
    }
  });

  it('files a vault document only for a type that has an employee', () => {
    // EmployeeDocument requires an employeeId; a company-wide report has none,
    // so a vaultDocumentType on it would fail at write time.
    for (const t of DOCUMENT_TYPES.filter((x) => x.vaultDocumentType)) {
      expect(t.subjectType === 'EMPLOYEE' || t.subjectType === 'SETTLEMENT').toBe(true);
    }
  });

  it('gives every type company branding and an issue date', () => {
    // Every document carries a letterhead and a date. A type missing these
    // cannot render the shipped default template at all.
    for (const t of DOCUMENT_TYPES) {
      const names = t.variables.map((v) => v.name);
      expect(names).toContain('companyName');
      expect(names).toContain('companyLogoUrl');
      expect(names).toContain('issueDate');
    }
  });

  it('gives every serialized type a serial and a verification link', () => {
    for (const t of DOCUMENT_TYPES.filter((x) => x.serialized)) {
      const names = t.variables.map((v) => v.name);
      expect(names).toContain('serialNumber');
      expect(names).toContain('verifyUrl');
    }
  });
});

describe('documentTypesForRole', () => {
  it('hides pay reports from a MANAGER entirely', () => {
    // Filtered, not disabled: a manager should not learn that a payroll
    // register exists.
    const keys = documentTypesForRole('MANAGER').map((t) => t.key);
    expect(keys).not.toContain('PAYROLL_REGISTER');
    expect(keys).not.toContain('SALARY_CERTIFICATE');
  });

  it('shows an EMPLOYEE only their own self-service documents', () => {
    const keys = documentTypesForRole('EMPLOYEE').map((t) => t.key);
    expect(keys).toContain('PAYSLIP');
    expect(keys).toContain('LEAVE_BALANCE_STATEMENT');
    expect(keys).not.toContain('PAYROLL_REGISTER');
    expect(keys).not.toContain('WARNING_LETTER');
  });

  it('shows ADMIN everything', () => {
    expect(documentTypesForRole('ADMIN')).toHaveLength(DOCUMENT_TYPES.length);
  });

  it('shows an unknown role nothing', () => {
    // Fail closed. A role string that is not one of the four is a bug, and the
    // safe reading of a bug is "no access".
    expect(documentTypesForRole('AUDITOR')).toHaveLength(0);
  });
});

describe('roleMaySeeSensitivity', () => {
  it('refuses a MANAGER pay documents about someone else', () => {
    // The rule letters already enforce: a manager has no business reading a
    // subordinate's salary certificate, and the document engine must not
    // become the way around that.
    expect(roleMaySeeSensitivity('MANAGER', 'PAY')).toBe(false);
    expect(roleMaySeeSensitivity('MANAGER', 'RESTRICTED')).toBe(false);
    expect(roleMaySeeSensitivity('MANAGER', 'INTERNAL')).toBe(true);
  });

  it('refuses an EMPLOYEE anything about someone else', () => {
    for (const s of ['INTERNAL', 'PERSONAL', 'PAY', 'RESTRICTED'] as const) {
      expect(roleMaySeeSensitivity('EMPLOYEE', s)).toBe(false);
    }
  });

  it('allows ADMIN and HR everything', () => {
    for (const role of ['ADMIN', 'HR_MANAGER']) {
      for (const s of ['INTERNAL', 'PERSONAL', 'PAY', 'RESTRICTED'] as const) {
        expect(roleMaySeeSensitivity(role, s)).toBe(true);
      }
    }
  });
});

describe('sampleContext', () => {
  it('nests a dotted variable into a real object', () => {
    // Handlebars resolves {{signatory.hr.name}} by WALKING, not by looking up a
    // key that literally contains dots — a flat map renders blank.
    const ctx = sampleContext(getDocumentType('SALARY_CERTIFICATE')!) as any;
    expect(ctx.signatory.hr.name).toBe('Fatma Al-Habsi');
  });

  it('carries table rows as arrays', () => {
    const ctx = sampleContext(getDocumentType('PAYSLIP')!) as any;
    expect(Array.isArray(ctx.earnings)).toBe(true);
    expect(ctx.earnings[0]).toHaveProperty('amount');
  });

  it('covers every declared variable', () => {
    for (const t of DOCUMENT_TYPES) {
      const ctx = sampleContext(t);
      for (const v of t.variables) {
        const value = v.name.split('.').reduce<any>((acc, k) => acc?.[k], ctx);
        expect({ type: t.key, name: v.name, defined: value !== undefined }).toEqual({
          type: t.key,
          name: v.name,
          defined: true,
        });
      }
    }
  });
});
