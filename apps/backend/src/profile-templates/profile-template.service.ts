/**
 * Employee Profile Template administration.
 *
 * Two invariants live here rather than in the database, because they need the
 * code registry to decide:
 *
 *   1. An admin may never create a field bound to a real column. Bindings are
 *      code (EMPLOYEE_BOUND_COLUMNS), verified against Prisma.dmmf by a spec —
 *      a wrong binding is data corruption, not a config mistake.
 *   2. A field the database demands can be relabelled and reordered, but never
 *      deactivated, retyped, or made optional. See `assertFieldMutationAllowed`.
 *
 * Deleting is always soft. `isActive = false` plus `isCustomized = true`: the
 * row survives so stored values survive, and the create-only boot seeder can
 * never resurrect a field the admin deliberately removed.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { runWithBranchBypass } from '../common/branch/branch-context';
import {
  FIELD_TYPES,
  VALIDATION_TYPES,
} from '../common/dynamic-fields/field-def';
import { BOUND_BY_KEY } from './employee-bound-columns';
import {
  buildTemplateDefinition,
  ensureCompanyTemplate,
  listPresets,
  seedProfileTemplate,
} from './profile-template-defaults';
import { ProfileTemplateResolverService } from './profile-template-resolver.service';
import {
  AdoptTemplateDto,
  ReorderDto,
  UpsertFieldDto,
  UpsertSectionDto,
} from './dto/profile-template.dto';

/** Reserved so a custom key can never shadow a bound one or a Prisma internal. */
const FIELD_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{1,59}$/;
const RESERVED_FIELD_KEYS = new Set([
  'id',
  'customFields',
  'createdAt',
  'updatedAt',
  'profile',
  'department',
  'branch',
  'user',
]);

@Injectable()
export class ProfileTemplateService implements OnModuleInit {
  private readonly logger = new Logger(ProfileTemplateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
    private readonly resolver: ProfileTemplateResolverService,
  ) {}

  /**
   * Self-heal on boot, exactly as LibraryItemsService does: create the company
   * template if it is missing, then reconcile it against the shipped preset.
   *
   * Runs unconditionally, kill switch or not — seeding is what makes the switch
   * safe to flip. It must never throw: a template problem cannot be allowed to
   * stop the application from starting.
   */
  async onModuleInit(): Promise<void> {
    try {
      const country = await this.settings.getSetting('payroll_country', '');
      const result = await runWithBranchBypass(() =>
        ensureCompanyTemplate(this.prisma as any, country || null),
      );
      this.logger.log(
        `Profile template ready (${result.fieldsSeeded} fields, ${result.deprecated} deprecated)`,
      );
    } catch (err) {
      this.logger.error(
        `Profile template seed skipped: ${(err as Error).message}`,
      );
    }
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  presets() {
    return { success: true, data: listPresets() };
  }

  preset(country: string) {
    const def = buildTemplateDefinition(country);
    return { success: true, data: def };
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async list(query: { scope?: string; branchId?: string } = {}) {
    const where: Record<string, unknown> = {};
    if (query.scope) where.scope = query.scope.toUpperCase();
    if (query.branchId) where.branchId = query.branchId;

    const rows = await this.prisma.profileTemplate.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
      include: {
        branch: { select: { id: true, code: true, name: true, country: true } },
        _count: { select: { fields: true, sections: true } },
      },
    });
    return { success: true, data: rows };
  }

  async findOne(id: string) {
    const tpl = await this.prisma.profileTemplate.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        sections: {
          orderBy: [{ wizardStep: 'asc' }, { displayOrder: 'asc' }],
          include: {
            fields: { orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }] },
          },
        },
      },
    });
    if (!tpl) throw new NotFoundException('Template not found');

    // Decorate with the registry so the builder can render locks and explain
    // them, without the frontend duplicating the registry.
    const sections = tpl.sections.map((s) => ({
      ...s,
      fields: s.fields.map((f) => {
        const bound = BOUND_BY_KEY.get(f.fieldKey);
        return {
          ...f,
          locked: bound?.locked ?? false,
          systemRequired: bound?.systemRequired ?? false,
          lockReason: bound?.reason ?? null,
        };
      }),
    }));

    return { success: true, data: { ...tpl, sections } };
  }

  /**
   * Copy a country preset into a new template. A COPY, never a reference: from
   * here on the customer's template evolves independently, and a later change
   * to our shipped preset reaches it only through the provenance rules.
   */
  async adopt(dto: AdoptTemplateDto, actorUserId?: string) {
    const scope = (dto.scope ?? 'COMPANY').toUpperCase();
    if (scope !== 'COMPANY' && scope !== 'BRANCH') {
      throw new BadRequestException('scope must be COMPANY or BRANCH');
    }
    if (scope === 'BRANCH' && !dto.branchId) {
      throw new BadRequestException('branchId is required for a BRANCH template');
    }

    let country = (dto.country ?? '').trim().toUpperCase();
    if (scope === 'BRANCH') {
      const branch = await this.prisma.branch.findUnique({
        where: { id: dto.branchId! },
        select: { id: true, name: true, country: true },
      });
      if (!branch) throw new NotFoundException('Branch not found');
      // Default to the branch's own country — the whole reason branch overrides
      // exist is that branches sit in different countries.
      if (!country) country = (branch.country ?? '').toUpperCase();
    }

    return runWithBranchBypass(async () => {
      const existing = await this.prisma.profileTemplate.findFirst({
        where:
          scope === 'COMPANY'
            ? { scope, isActive: true }
            : { scope, branchId: dto.branchId!, isActive: true },
        select: { id: true },
      });
      if (existing) {
        // Enforced by a partial unique index too; this is the friendly version.
        throw new ConflictException(
          scope === 'COMPANY'
            ? 'An active company template already exists. Edit it, or archive it first.'
            : 'This branch already has an active template override.',
        );
      }

      const def = buildTemplateDefinition(country);
      const tpl = await this.prisma.profileTemplate.create({
        data: {
          scope,
          branchId: scope === 'BRANCH' ? dto.branchId! : null,
          country: def.country,
          name: dto.name?.trim() || def.name,
          isActive: true,
        },
        select: { id: true, country: true },
      });

      const result = await seedProfileTemplate(this.prisma as any, tpl);
      this.resolver.invalidate();

      await this.audit.log({
        userId: actorUserId,
        action: 'TEMPLATE_ADOPTED',
        resourceType: 'ProfileTemplate',
        resourceId: tpl.id,
        newData: { scope, branchId: dto.branchId ?? null, country, ...result },
      });

      return this.findOne(tpl.id);
    });
  }

  /** Soft-archive. The partial unique index only counts active rows. */
  async archive(id: string, actorUserId?: string) {
    const tpl = await this.requireTemplate(id);
    await this.prisma.profileTemplate.update({
      where: { id },
      data: { isActive: false },
    });
    this.resolver.invalidate();

    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_ARCHIVED',
      resourceType: 'ProfileTemplate',
      resourceId: id,
      oldData: { scope: tpl.scope, branchId: tpl.branchId },
    });
    return { success: true, data: { id, isActive: false } };
  }

  async rename(id: string, name: string, actorUserId?: string) {
    await this.requireTemplate(id);
    const row = await this.prisma.profileTemplate.update({
      where: { id },
      data: { name: name.trim() },
    });
    this.resolver.invalidate();
    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_RENAMED',
      resourceType: 'ProfileTemplate',
      resourceId: id,
      newData: { name: row.name },
    });
    return { success: true, data: row };
  }

  // ── Sections ──────────────────────────────────────────────────────────────

  async upsertSection(
    templateId: string,
    dto: UpsertSectionDto,
    sectionId?: string,
    actorUserId?: string,
  ) {
    await this.requireTemplate(templateId);

    if (sectionId) {
      const existing = await this.requireSection(templateId, sectionId);
      const row = await this.prisma.profileTemplateSection.update({
        where: { id: existing.id },
        data: {
          label: dto.label ?? existing.label,
          icon: dto.icon ?? existing.icon,
          wizardStep: dto.wizardStep ?? existing.wizardStep,
          columns: dto.columns ?? existing.columns,
          displayOrder: dto.displayOrder ?? existing.displayOrder,
          isActive: dto.isActive ?? existing.isActive,
          visibleToRoles: dto.visibleToRoles ?? existing.visibleToRoles,
          // From now on the seeder leaves this section alone.
          isCustomized: true,
        },
      });
      this.resolver.invalidate();
      await this.audit.log({
        userId: actorUserId,
        action: 'TEMPLATE_SECTION_UPDATED',
        resourceType: 'ProfileTemplate',
        resourceId: templateId,
        oldData: { sectionKey: existing.sectionKey, label: existing.label },
        newData: { label: row.label, isActive: row.isActive },
      });
      return { success: true, data: row };
    }

    const sectionKey = (dto.sectionKey ?? '').trim();
    if (!FIELD_KEY_PATTERN.test(sectionKey)) {
      throw new BadRequestException(
        'sectionKey must start with a lowercase letter and contain only letters, digits or underscore',
      );
    }
    const clash = await this.prisma.profileTemplateSection.findUnique({
      where: { templateId_sectionKey: { templateId, sectionKey } },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`Section ${sectionKey} already exists`);

    const row = await this.prisma.profileTemplateSection.create({
      data: {
        templateId,
        sectionKey,
        label: dto.label ?? sectionKey,
        icon: dto.icon ?? null,
        wizardStep: dto.wizardStep ?? 1,
        columns: dto.columns ?? 2,
        displayOrder: dto.displayOrder ?? 999,
        visibleToRoles: dto.visibleToRoles ?? [],
        origin: 'CUSTOM',
        isCustomized: true,
      },
    });
    this.resolver.invalidate();
    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_SECTION_CREATED',
      resourceType: 'ProfileTemplate',
      resourceId: templateId,
      newData: { sectionKey, label: row.label },
    });
    return { success: true, data: row };
  }

  /** Soft-deactivate. Refuses while the section still holds a locked field. */
  async removeSection(
    templateId: string,
    sectionId: string,
    actorUserId?: string,
  ) {
    const section = await this.requireSection(templateId, sectionId);
    const fields = await this.prisma.profileTemplateField.findMany({
      where: { sectionId, isActive: true },
      select: { fieldKey: true },
    });
    const locked = fields
      .map((f) => BOUND_BY_KEY.get(f.fieldKey))
      .filter((b) => b?.locked);
    if (locked.length) {
      throw new BadRequestException(
        `Cannot remove this section while it holds required field${locked.length > 1 ? 's' : ''}: ${locked
          .map((b) => b!.fieldKey)
          .join(', ')}. Move them to another section first.`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.profileTemplateSection.update({
        where: { id: sectionId },
        data: { isActive: false, isCustomized: true },
      }),
      // Hide the fields with it, and mark them customized so the seeder does not
      // quietly bring them back on the next boot.
      this.prisma.profileTemplateField.updateMany({
        where: { sectionId },
        data: { isActive: false, isCustomized: true },
      }),
    ]);
    this.resolver.invalidate();

    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_SECTION_REMOVED',
      resourceType: 'ProfileTemplate',
      resourceId: templateId,
      oldData: { sectionKey: section.sectionKey, fieldCount: fields.length },
    });
    return { success: true, data: { id: sectionId, isActive: false } };
  }

  async reorderSections(
    templateId: string,
    dto: ReorderDto,
    actorUserId?: string,
  ) {
    await this.requireTemplate(templateId);
    const owned = await this.prisma.profileTemplateSection.findMany({
      where: { templateId, id: { in: dto.order } },
      select: { id: true },
    });
    if (owned.length !== dto.order.length) {
      throw new BadRequestException(
        'order contains sections that do not belong to this template',
      );
    }

    await this.prisma.$transaction(
      dto.order.map((id, index) =>
        this.prisma.profileTemplateSection.update({
          where: { id },
          data: { displayOrder: (index + 1) * 10, isCustomized: true },
        }),
      ),
    );
    this.resolver.invalidate();
    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_SECTIONS_REORDERED',
      resourceType: 'ProfileTemplate',
      resourceId: templateId,
      newData: { order: dto.order },
    });
    return this.findOne(templateId);
  }

  // ── Fields ────────────────────────────────────────────────────────────────

  async createField(
    templateId: string,
    dto: UpsertFieldDto,
    actorUserId?: string,
  ) {
    await this.requireTemplate(templateId);

    const fieldKey = (dto.fieldKey ?? '').trim();
    if (!FIELD_KEY_PATTERN.test(fieldKey)) {
      throw new BadRequestException(
        'fieldKey must start with a lowercase letter and contain only letters, digits or underscore (2-60 chars)',
      );
    }
    if (RESERVED_FIELD_KEYS.has(fieldKey)) {
      throw new BadRequestException(`fieldKey "${fieldKey}" is reserved`);
    }
    if (BOUND_BY_KEY.has(fieldKey)) {
      // Bindings are code. Letting an admin claim a column name here would put
      // arbitrary input on a payroll-critical column.
      throw new BadRequestException(
        `"${fieldKey}" is a built-in field. Add it from the built-in list instead of creating a custom field with that name.`,
      );
    }

    const existing = await this.prisma.profileTemplateField.findUnique({
      where: { templateId_fieldKey: { templateId, fieldKey } },
      select: { id: true, isActive: true },
    });
    if (existing) {
      throw new ConflictException(
        existing.isActive
          ? `Field "${fieldKey}" already exists`
          : `Field "${fieldKey}" exists but is hidden. Re-enable it instead of creating a duplicate.`,
      );
    }

    const section = await this.requireSection(templateId, dto.sectionId!);
    this.assertTypes(dto);

    const row = await this.prisma.profileTemplateField.create({
      data: {
        templateId,
        sectionId: section.id,
        fieldKey,
        label: dto.label ?? fieldKey,
        fieldType: dto.fieldType ?? 'TEXT',
        // Admin-created fields are ALWAYS JSONB. There is no code path that
        // lets a request choose COLUMN.
        storage: 'JSONB',
        boundColumn: null,
        validationType: dto.validationType ?? 'NONE',
        regex: dto.regex ?? null,
        minValue: dto.minValue ?? null,
        maxValue: dto.maxValue ?? null,
        minLength: dto.minLength ?? null,
        maxLength: dto.maxLength ?? null,
        required: dto.required ?? false,
        options: (dto.options ?? null) as any,
        optionSource: dto.optionSource ?? null,
        placeholder: dto.placeholder ?? null,
        helpText: dto.helpText ?? null,
        defaultValue: dto.defaultValue ?? null,
        colSpan: dto.colSpan ?? 1,
        displayOrder: dto.displayOrder ?? 999,
        visibleToRoles: dto.visibleToRoles ?? [],
        editableByRoles: dto.editableByRoles ?? [],
        selfVisible: dto.selfVisible ?? true,
        selfEditable: dto.selfEditable ?? false,
        isSensitive: dto.isSensitive ?? false,
        includeInCompletion: dto.includeInCompletion ?? false,
        origin: 'CUSTOM',
        isCustomized: true,
      },
    });
    this.resolver.invalidate();

    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_FIELD_CREATED',
      resourceType: 'ProfileTemplate',
      resourceId: templateId,
      newData: { fieldKey, label: row.label, fieldType: row.fieldType },
    });
    return { success: true, data: row };
  }

  async updateField(
    templateId: string,
    fieldId: string,
    dto: UpsertFieldDto,
    actorUserId?: string,
  ) {
    const field = await this.requireField(templateId, fieldId);
    this.assertTypes(dto);
    this.assertFieldMutationAllowed(field, dto);

    if (dto.sectionId && dto.sectionId !== field.sectionId) {
      await this.requireSection(templateId, dto.sectionId);
    }

    const row = await this.prisma.profileTemplateField.update({
      where: { id: fieldId },
      data: {
        sectionId: dto.sectionId ?? field.sectionId,
        label: dto.label ?? field.label,
        // fieldType/storage are inherent for bound fields; assertFieldMutation
        // has already refused a change on those.
        fieldType: dto.fieldType ?? field.fieldType,
        validationType: dto.validationType ?? field.validationType,
        regex: dto.regex === undefined ? field.regex : dto.regex,
        minValue: dto.minValue === undefined ? field.minValue : dto.minValue,
        maxValue: dto.maxValue === undefined ? field.maxValue : dto.maxValue,
        minLength: dto.minLength === undefined ? field.minLength : dto.minLength,
        maxLength: dto.maxLength === undefined ? field.maxLength : dto.maxLength,
        required: dto.required ?? field.required,
        options:
          dto.options === undefined ? (field.options as any) : (dto.options as any),
        optionSource:
          dto.optionSource === undefined ? field.optionSource : dto.optionSource,
        placeholder:
          dto.placeholder === undefined ? field.placeholder : dto.placeholder,
        helpText: dto.helpText === undefined ? field.helpText : dto.helpText,
        defaultValue:
          dto.defaultValue === undefined ? field.defaultValue : dto.defaultValue,
        colSpan: dto.colSpan ?? field.colSpan,
        displayOrder: dto.displayOrder ?? field.displayOrder,
        visibleToRoles: dto.visibleToRoles ?? field.visibleToRoles,
        editableByRoles: dto.editableByRoles ?? field.editableByRoles,
        selfVisible: dto.selfVisible ?? field.selfVisible,
        selfEditable: dto.selfEditable ?? field.selfEditable,
        isSensitive: dto.isSensitive ?? field.isSensitive,
        isActive: dto.isActive ?? field.isActive,
        includeInCompletion:
          dto.includeInCompletion ?? field.includeInCompletion,
        // The whole provenance contract in one line: from here the boot seeder
        // never touches this row again, so our next shipped revision cannot
        // overwrite what the admin just decided.
        isCustomized: true,
      },
    });
    this.resolver.invalidate();

    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_FIELD_UPDATED',
      resourceType: 'ProfileTemplate',
      resourceId: templateId,
      oldData: {
        fieldKey: field.fieldKey,
        label: field.label,
        required: field.required,
        isActive: field.isActive,
      },
      newData: {
        label: row.label,
        required: row.required,
        isActive: row.isActive,
      },
    });
    return { success: true, data: row };
  }

  /**
   * Soft delete. Never DROP COLUMN, never remove a JSONB key — reactivating the
   * field must bring every stored value back exactly as it was.
   */
  async removeField(templateId: string, fieldId: string, actorUserId?: string) {
    const field = await this.requireField(templateId, fieldId);
    const bound = BOUND_BY_KEY.get(field.fieldKey);

    if (bound?.locked) {
      throw new BadRequestException(
        `"${field.label}" cannot be removed. ${bound.reason ?? 'It is required by the system.'}`,
      );
    }

    const row = await this.prisma.profileTemplateField.update({
      where: { id: fieldId },
      // isCustomized alongside isActive is what stops the create-only seeder
      // from resurrecting this field on the next boot.
      data: { isActive: false, isCustomized: true },
    });
    this.resolver.invalidate();

    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_FIELD_DEACTIVATED',
      resourceType: 'ProfileTemplate',
      resourceId: templateId,
      oldData: { fieldKey: field.fieldKey, label: field.label },
    });
    return { success: true, data: { id: row.id, isActive: false } };
  }

  async reorderFields(
    templateId: string,
    dto: ReorderDto,
    actorUserId?: string,
  ) {
    await this.requireTemplate(templateId);
    const owned = await this.prisma.profileTemplateField.findMany({
      where: { templateId, id: { in: dto.order } },
      select: { id: true },
    });
    if (owned.length !== dto.order.length) {
      throw new BadRequestException(
        'order contains fields that do not belong to this template',
      );
    }
    if (dto.sectionId) await this.requireSection(templateId, dto.sectionId);

    await this.prisma.$transaction(
      dto.order.map((id, index) =>
        this.prisma.profileTemplateField.update({
          where: { id },
          data: {
            displayOrder: (index + 1) * 10,
            ...(dto.sectionId ? { sectionId: dto.sectionId } : {}),
            isCustomized: true,
          },
        }),
      ),
    );
    this.resolver.invalidate();
    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_FIELDS_REORDERED',
      resourceType: 'ProfileTemplate',
      resourceId: templateId,
      newData: { sectionId: dto.sectionId ?? null, order: dto.order },
    });
    return this.findOne(templateId);
  }

  /** Re-run the shipped preset against a template. Idempotent and safe. */
  async reseed(templateId: string, actorUserId?: string) {
    const tpl = await this.requireTemplate(templateId);
    const result = await runWithBranchBypass(() =>
      seedProfileTemplate(this.prisma as any, {
        id: tpl.id,
        country: tpl.country,
      }),
    );
    this.resolver.invalidate();
    await this.audit.log({
      userId: actorUserId,
      action: 'TEMPLATE_RESEEDED',
      resourceType: 'ProfileTemplate',
      resourceId: templateId,
      newData: result as any,
    });
    return { success: true, data: result };
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  /**
   * The rules that keep a configurable form from breaking payroll.
   *
   * Exported shape kept small on purpose: everything it needs is the stored row
   * plus the patch, so it is trivially unit-testable without a database.
   */
  assertFieldMutationAllowed(
    field: { fieldKey: string; label: string; storage: string },
    dto: UpsertFieldDto,
  ): void {
    const bound = BOUND_BY_KEY.get(field.fieldKey);

    if (dto.fieldKey && dto.fieldKey !== field.fieldKey) {
      // Values are stored under the key. Renaming it orphans every value.
      throw new BadRequestException(
        'fieldKey cannot be changed. Change the label instead — that is what users see.',
      );
    }

    if (!bound) return; // custom field: everything else is fair game

    if (dto.fieldType && dto.fieldType !== bound.type) {
      throw new BadRequestException(
        `"${field.label}" is stored in a ${bound.type} column and cannot be changed to ${dto.fieldType}.`,
      );
    }
    if (dto.storage && dto.storage !== 'COLUMN') {
      throw new BadRequestException(
        `"${field.label}" is a built-in field and always stores to its own column.`,
      );
    }
    if (bound.systemRequired && dto.required === false) {
      throw new BadRequestException(
        `"${field.label}" cannot be made optional — the database requires a value for every employee.`,
      );
    }
    if (bound.locked && dto.isActive === false) {
      throw new BadRequestException(
        `"${field.label}" cannot be hidden. ${bound.reason ?? 'It is required by the system.'}`,
      );
    }
  }

  private assertTypes(dto: UpsertFieldDto): void {
    if (dto.fieldType && !FIELD_TYPES.includes(dto.fieldType as any)) {
      throw new BadRequestException(`Unknown fieldType ${dto.fieldType}`);
    }
    if (
      dto.validationType &&
      !VALIDATION_TYPES.includes(dto.validationType as any)
    ) {
      throw new BadRequestException(
        `Unknown validationType ${dto.validationType}`,
      );
    }
    if (dto.validationType === 'REGEX' && dto.regex) {
      try {
        new RegExp(dto.regex);
      } catch {
        // Better here than silently never matching at validation time.
        throw new BadRequestException('regex is not a valid regular expression');
      }
    }
  }

  private async requireTemplate(id: string) {
    const tpl = await this.prisma.profileTemplate.findUnique({ where: { id } });
    if (!tpl) throw new NotFoundException('Template not found');
    return tpl;
  }

  private async requireSection(templateId: string, sectionId: string) {
    const section = await this.prisma.profileTemplateSection.findUnique({
      where: { id: sectionId },
    });
    // Checking ownership, not just existence: otherwise a template id in the URL
    // could be paired with any section id in the body.
    if (!section || section.templateId !== templateId) {
      throw new NotFoundException('Section not found on this template');
    }
    return section;
  }

  private async requireField(templateId: string, fieldId: string) {
    const field = await this.prisma.profileTemplateField.findUnique({
      where: { id: fieldId },
    });
    if (!field || field.templateId !== templateId) {
      throw new NotFoundException('Field not found on this template');
    }
    return field;
  }
}
