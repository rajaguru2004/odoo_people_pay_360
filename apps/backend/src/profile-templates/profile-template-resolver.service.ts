/**
 * Which template applies, for whom.
 *
 * Precedence deliberately mirrors the Overtime Policy chain that already ships
 * in this codebase (Employee override -> Employment Type -> Company default):
 *
 *   BRANCH_OVERRIDE   an active template for the caller's branch
 *   COMPANY           the single active company-wide template
 *   LEGACY_BASELINE   the shipped constants, used when nothing is seeded yet and
 *                     whenever the kill switch is off
 *
 * The last tier is what makes this safe to deploy: with
 * `employee_template_enabled = false` every caller resolves to LEGACY_BASELINE,
 * so behaviour is byte-identical to the version before this feature.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { BOUND_BY_KEY } from './employee-bound-columns';
import {
  BASELINE_FIELDS,
  BASELINE_SECTIONS,
  buildTemplateDefinition,
  FieldPreset,
} from './profile-template-defaults';
import {
  ResolvedField,
  ResolvedSection,
  ResolvedTemplate,
  TemplateMode,
  TemplateSource,
} from './profile-template.types';
import { FieldActor, visibleFields } from './field-permissions.util';

export const TEMPLATE_ENABLED_KEY = 'employee_template_enabled';

interface CacheEntry {
  value: ResolvedTemplate;
  at: number;
}

@Injectable()
export class ProfileTemplateResolverService {
  private readonly logger = new Logger(ProfileTemplateResolverService.name);

  // Templates change monthly at most, forms render constantly. A short TTL plus
  // explicit invalidation on write keeps the builder feeling immediate without
  // a per-render query. Deliberately in-process — no Redis dependency.
  private static readonly TTL_MS = 60_000;
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /** Called by the service after any template write. */
  invalidate(): void {
    this.cache.clear();
  }

  async isEnabled(): Promise<boolean> {
    const raw = await this.settings.getSetting(TEMPLATE_ENABLED_KEY, 'false');
    return raw === 'true';
  }

  /**
   * The full template for a branch, unfiltered by role. Cached.
   *
   * Read with a branch bypass on purpose: resolution must be able to see the
   * company row (branch_id NULL) and a specific branch's row regardless of the
   * caller's own branch envelope, and the row it returns is form CONFIGURATION,
   * not employee data.
   */
  async resolve(branchId?: string | null): Promise<ResolvedTemplate> {
    const enabled = await this.isEnabled();
    if (!enabled) return this.legacy(branchId ?? null, false);

    const key = branchId ?? '__company__';
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ProfileTemplateResolverService.TTL_MS) {
      return hit.value;
    }

    const value = await runWithBranchBypass(async () => {
      if (branchId) {
        const branchTpl = await this.loadTemplate({
          scope: 'BRANCH',
          branchId,
          isActive: true,
        });
        if (branchTpl) return this.shape(branchTpl, 'BRANCH_OVERRIDE');
      }

      const companyTpl = await this.loadTemplate({
        scope: 'COMPANY',
        isActive: true,
      });
      if (companyTpl) return this.shape(companyTpl, 'COMPANY');

      // Nothing seeded yet (a brand-new database mid-boot). Serve the constants
      // rather than an empty form.
      return this.legacy(branchId ?? null, true);
    });

    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  /**
   * The template projected for one caller: inactive fields dropped, then the
   * role filter applied. This is what the frontend renders.
   */
  async resolveForActor(
    actor: FieldActor,
    opts: { branchId?: string | null; mode?: TemplateMode } = {},
  ): Promise<ResolvedTemplate> {
    const tpl = await this.resolve(opts.branchId);
    const allowed = visibleFields(tpl.fields, actor);
    const allowedIds = new Set(allowed.map((f) => f.fieldKey));

    const sections = tpl.sections
      .map((s) => ({
        ...s,
        fields: s.fields.filter((f) => allowedIds.has(f.fieldKey)),
      }))
      // An empty section is a stray heading on the form.
      .filter((s) => s.fields.length > 0);

    return { ...tpl, fields: allowed, sections };
  }

  /** Where an employee's template comes from — a support/debug endpoint. */
  async resolveForEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const tpl = await this.resolve(employee.branchId);
    return {
      employeeId,
      branchId: employee.branchId,
      source: tpl.source,
      templateId: tpl.templateId,
      scope: tpl.scope,
      country: tpl.country,
      fieldCount: tpl.fields.length,
      enabled: tpl.enabled,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private loadTemplate(where: Record<string, unknown>) {
    return this.prisma.profileTemplate.findFirst({
      where,
      include: {
        sections: {
          where: { isActive: true },
          orderBy: [{ wizardStep: 'asc' }, { displayOrder: 'asc' }],
          include: {
            fields: {
              where: { isActive: true },
              orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
            },
          },
        },
      },
    });
  }

  private shape(tpl: any, source: TemplateSource): ResolvedTemplate {
    const sections: ResolvedSection[] = tpl.sections.map((s: any) => ({
      id: s.id,
      sectionKey: s.sectionKey,
      label: s.label,
      icon: s.icon,
      wizardStep: s.wizardStep,
      columns: s.columns,
      displayOrder: s.displayOrder,
      fields: s.fields.map((f: any) => this.toField(f, s.sectionKey)),
    }));

    return {
      templateId: tpl.id,
      source,
      scope: tpl.scope,
      branchId: tpl.branchId,
      country: tpl.country,
      name: tpl.name,
      sections,
      fields: sections.flatMap((s) => s.fields),
      enabled: true,
    };
  }

  private toField(row: any, sectionKey: string): ResolvedField {
    const bound = BOUND_BY_KEY.get(row.fieldKey);
    return {
      id: row.id,
      sectionKey,
      fieldKey: row.fieldKey,
      label: row.label,
      fieldType: row.fieldType,
      storage: row.storage,
      boundColumn: row.boundColumn,
      validationType: row.validationType,
      regex: row.regex,
      options: row.options,
      optionSource: row.optionSource,
      required: row.required,
      displayOrder: row.displayOrder,
      placeholder: row.placeholder,
      helpText: row.helpText,
      defaultValue: row.defaultValue,
      colSpan: row.colSpan,
      isSensitive: row.isSensitive,
      // Decimal -> number at the edge; the frontend and the validators both
      // want a plain number, and these are bounds, not money.
      minValue: row.minValue == null ? null : Number(row.minValue),
      maxValue: row.maxValue == null ? null : Number(row.maxValue),
      minLength: row.minLength,
      maxLength: row.maxLength,
      visibleToRoles: row.visibleToRoles ?? [],
      editableByRoles: row.editableByRoles ?? [],
      selfVisible: row.selfVisible,
      selfEditable: row.selfEditable,
      includeInCompletion: row.includeInCompletion,
      isActive: row.isActive,
      systemDeprecated: row.systemDeprecated,
      origin: row.origin,
      locked: bound?.locked ?? false,
      systemRequired: bound?.systemRequired ?? false,
      lockReason: bound?.reason ?? null,
    };
  }

  /**
   * The shipped constants, shaped like a template. Used when the kill switch is
   * off and when nothing has been seeded yet.
   */
  private legacy(branchId: string | null, enabled: boolean): ResolvedTemplate {
    const def = buildTemplateDefinition(null);
    const sectionOf = new Map(
      BASELINE_SECTIONS.map((s) => [s.sectionKey, s] as const),
    );

    const toField = (p: FieldPreset): ResolvedField => {
      const bound = BOUND_BY_KEY.get(p.fieldKey);
      return {
        id: null,
        sectionKey: p.sectionKey,
        fieldKey: p.fieldKey,
        label: p.label,
        fieldType: bound?.type ?? p.fieldType ?? 'TEXT',
        storage: bound ? 'COLUMN' : 'JSONB',
        boundColumn: bound ? `${bound.table}.${bound.column}` : null,
        validationType: p.validationType ?? 'NONE',
        regex: p.regex ?? null,
        options: p.options ?? null,
        optionSource: p.optionSource ?? bound?.optionSource ?? null,
        required: bound?.systemRequired || (p.required ?? false),
        displayOrder: p.displayOrder,
        placeholder: p.placeholder ?? null,
        helpText: p.helpText ?? null,
        defaultValue: null,
        colSpan: p.colSpan ?? 1,
        isSensitive: p.isSensitive ?? false,
        minValue: null,
        maxValue: null,
        minLength: null,
        maxLength: null,
        // With the switch OFF these must be inert. The baseline marks
        // baseSalary, salaryType, overtimePolicyId and attendanceExternalId
        // visible to ADMIN/HR_MANAGER only and hidden from self — and
        // findOne() applies the projection whether or not the feature is on.
        // Copying them through regardless would strip Base Salary from a
        // MANAGER reading a direct report, and from an employee reading their
        // own record, on the default configuration. Tightening reads is a
        // consequence of turning the feature ON, which is what the switch is
        // for; it is not something the merge gets to do on its own.
        visibleToRoles: enabled ? (p.visibleToRoles ?? []) : [],
        editableByRoles: enabled ? (p.editableByRoles ?? []) : [],
        selfVisible: enabled ? (p.selfVisible ?? true) : true,
        // selfEditable is deliberately NOT neutralised. Forcing it would WIDEN
        // self-service rather than restore prior behaviour, and the legacy
        // allowlist that updateAsSelfService narrows to lives in these values.
        selfEditable: p.selfEditable ?? false,
        includeInCompletion: p.includeInCompletion ?? false,
        isActive: p.isActive ?? true,
        systemDeprecated: false,
        origin: 'SYSTEM',
        locked: bound?.locked ?? false,
        systemRequired: bound?.systemRequired ?? false,
        lockReason: bound?.reason ?? null,
      };
    };

    const sections: ResolvedSection[] = BASELINE_SECTIONS.filter(
      (s) => s.isActive !== false,
    )
      .sort(
        (a, b) =>
          a.wizardStep - b.wizardStep || a.displayOrder - b.displayOrder,
      )
      .map((s) => ({
        id: null,
        sectionKey: s.sectionKey,
        label: s.label,
        icon: s.icon ?? null,
        wizardStep: s.wizardStep,
        columns: s.columns ?? 2,
        displayOrder: s.displayOrder,
        fields: BASELINE_FIELDS.filter(
          (f) => f.sectionKey === s.sectionKey && f.isActive !== false,
        )
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map(toField),
      }))
      .filter((s) => sectionOf.has(s.sectionKey));

    return {
      templateId: null,
      source: 'LEGACY_BASELINE',
      scope: 'NONE',
      branchId,
      country: def.country,
      name: def.name,
      sections,
      fields: sections.flatMap((s) => s.fields),
      enabled,
    };
  }
}
