import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { GarnishmentsService } from '../garnishments/garnishments.service';
import { Workbook } from 'exceljs';
import { existsSync, unlinkSync } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import {
  FIXED_IMPORT_COLUMNS,
  isCustomImportColumn,
} from './import-columns';
import { actorFor, FieldActor } from '../common/utils/self-service.util';
import { stripUnsettableNulls } from '../common/utils/nullable-columns.util';
import {
  EMPLOYEE_SORT_FIELDS,
  EmployeeSortField,
  QueryEmployeesDto,
} from './dto/query-employees.dto';
import { ProfileTemplateResolverService } from '../profile-templates/profile-template-resolver.service';
import {
  assertFieldsWritable,
  canEditField,
  projectEmployeeForRole,
} from '../profile-templates/field-permissions.util';
import { validateDynamicData } from '../common/dynamic-fields/validate-dynamic-data';
import {
  EmployeeActivityService,
  GetActivitiesDto,
} from './employee-activity.service';
import { MailService } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { ClearanceService } from '../assets/clearance.service';
import { SupervisorsService } from '../supervisors/supervisors.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import {
  assertBranchAssignable,
  assertInBranch,
  getEffectiveBranchId,
  rawBranchFilter,
} from '../common/branch/branch-scope.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { checkEmploymentStartDate } from '../common/utils/start-date-policy.util';
import {
  toSalaryBasis,
  SalaryBasisValue,
} from '../payrolls/payroll-earnings.util';
import { LibraryType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { reassignProjectOwnershipOnEmployeeDelete } from '../projects/projects.service';
import { WhatsAppOutboxService } from '../whatsapp/whatsapp-outbox.service';
import { WhatsAppSettingsService } from '../whatsapp/whatsapp-settings.service';
import { toE164, normalisePhoneRegion, firstRegion } from '../whatsapp/utils/phone.util';
import {
  bold,
  escapeWa,
  kv,
  lines,
  WA_SAFE_SYMBOLS,
} from '../whatsapp/templates/format';
import { randomInt } from 'crypto';

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private prisma: PrismaService,
    private activityService: EmployeeActivityService,
    private mailService: MailService,
    private settingsService: SystemSettingsService,
    private storage: StorageService,
    private clearance: ClearanceService,
    // Canonical parameter order. Three specs construct this service
    // positionally (employees-pay-basis, employees-phone-country,
    // employees-import-phone-country) — reordering here silently injects the
    // wrong stub into each of them. Append only.
    private whatsappOutbox: WhatsAppOutboxService,
    private whatsappSettings: WhatsAppSettingsService,
    private templates: ProfileTemplateResolverService,
    private supervisors: SupervisorsService,
    private readonly garnishments: GarnishmentsService,
  ) {}

  /**
   * Route a supervisor change through the service that owns its invariants.
   *
   * `Employee.supervisorId` is a real column and the employee form offers it,
   * but writing it here would bypass the cycle check, the active-supervisor
   * check, the branch envelope, the audit entry and the stale-team-membership
   * cleanup that SupervisorsService performs. `undefined` means "not part of
   * this request"; `null`/'' means "clear it".
   */
  private async applySupervisor(
    employeeId: string,
    supervisorId: string | null | undefined,
    actor?: { id?: string },
  ): Promise<void> {
    if (supervisorId === undefined) return;
    if (!supervisorId) {
      await this.supervisors.unassign(employeeId, actor);
      return;
    }
    await this.supervisors.assign(employeeId, supervisorId, actor);
  }

  async create(dto: CreateEmployeeDto, actor?: { id?: string; role?: string }) {
    // Validate age (minimum 18 years old - Indian labor law)
    const birthDate = new Date(dto.dateOfBirth);
    const age = Math.floor(
      (new Date().getTime() - birthDate.getTime()) /
        (365.25 * 24 * 60 * 60 * 1000),
    );
    if (age < 18) {
      throw new BadRequestException(
        'Employee must be at least 18 years old (Indian labor law)',
      );
    }
    if (age > 100) {
      throw new BadRequestException('Invalid date of birth');
    }

    // Start date bounds come from the admin-configurable policy. Backdating is
    // unrestricted by default so late paperwork and historical hires can be
    // onboarded; see start-date-policy.util.ts.
    const startDatePolicy =
      await this.settingsService.getEmploymentStartDatePolicy();
    const startCheck = checkEmploymentStartDate({
      startDate: dto.startDate,
      dateOfBirth: dto.dateOfBirth,
      policy: startDatePolicy,
    });
    if (!startCheck.ok) {
      throw new BadRequestException(startCheck.message);
    }

    // Check email uniqueness on employee
    const existingEmail = await this.prisma.employee.findUnique({
      where: { email: dto.email },
    });
    if (existingEmail) {
      throw new ConflictException('Email already exists');
    }

    // Check email uniqueness on user
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existingUser) {
      throw new ConflictException('User email already exists');
    }

    // Check ID card uniqueness — skipped when autoGenerateIdCard is set, since a
    // stale collision there is expected to self-heal via retry in createEmployeeRecord
    // rather than fail the request outright.
    if (!dto.autoGenerateIdCard) {
      const existingIdCard = await this.prisma.employee.findUnique({
        where: { idCard: dto.idCard },
      });
      if (existingIdCard) {
        throw new ConflictException('ID card already exists');
      }
    }

    // Validate department. Active is the only requirement — a sub-department
    // is a legitimate home for staff.
    //
    // Both doors used to refuse a department with a parent, on the reading that
    // such a row is a "team" and that staff belong to the main department with
    // the team expressed through their position. Team membership is its own
    // model (`Team`/`TeamMember`, with a lead, allocation percentages and dated
    // rows). A child Department is a sub-department: the department module
    // gives it its own manager, its own headcount and its own card, and the org
    // chart draws it as a unit.
    //
    // The rule also could not describe the data the product had already let
    // people build. `update()` refused a parented target from the first commit
    // but `create()` did not, so tenants staffed their sub-departments for
    // months — on the live tenant 21 of 29 employees sit in six sub-departments
    // created the same day as their parent. Hardening `create()` to match (P28)
    // did not correct that structure, it only made the org's real working
    // departments unpickable and locked those employees out of any edit that
    // touches a department. Nothing outside this method reads
    // `department.parentId` — approvals route on the requester's own department
    // manager — so retiring the check costs nothing downstream.
    const department = await this.prisma.department.findUnique({
      where: { id: dto.departmentId },
    });
    if (!department) {
      throw new BadRequestException('Department not found');
    }
    if (!department.isActive) {
      throw new BadRequestException(
        'Cannot assign employee to inactive department',
      );
    }

    // Multi-branch: resolve + authorize the target branch. Onboard into the
    // provided branch, else the caller's active branch, else default Head Office.
    let branchId = dto.branchId ?? getEffectiveBranchId() ?? undefined;
    if (!branchId) {
      const hq = await this.prisma.branch.findFirst({
        where: { code: 'HO' },
        select: { id: true },
      });
      branchId = hq?.id;
    }
    if (branchId) {
      // Out-of-envelope target => 404 (no existence leak) before we confirm it
      // exists. Uses the caller's full envelope, not the narrowed active-branch
      // selector — picking a branch in the form other than the currently
      // viewed branch is a legitimate cross-branch assignment for global callers.
      assertBranchAssignable(branchId);
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { id: true, isActive: true },
      });
      if (!branch) {
        throw new BadRequestException('Branch not found');
      }
      // A retired branch appears in no list and no picker, but nothing stopped
      // a hire into it — and those staff then held a branch nobody could select,
      // while re-arming the delete guard on a branch that had been closed.
      if (!branch.isActive) {
        throw new BadRequestException('Branch is not active');
      }
    }
    dto.branchId = branchId;

    // Resolved out here, not inside createEmployeeRecord, because that method
    // recurses on employeeCode collisions.
    const derivedSalaryType = await this.payBasisForEmploymentType(
      dto.employmentType,
    );
    // Validated BEFORE the insert: a rejected custom field must not leave a
    // half-onboarded employee behind with no login.
    const custom = await this.resolveCustomFields(dto.customFields, branchId, {
      partial: false,
      // No target id: nobody creates their own employee record, so isSelf is
      // always false here. The role still matters — an HR_MANAGER must not be
      // able to set an ADMIN-only custom field at onboarding time, which is
      // exactly what happened while this argument was missing.
      actor: actorFor(actor),
    });

    const employee = await this.createEmployeeRecord(
      dto,
      0,
      derivedSalaryType,
      custom?.merged,
    );

    // The form offers a Supervisor on the create step, but assigning one has
    // invariants (active supervisor, branch envelope, audit, notifications) that
    // live in SupervisorsService. Delegating keeps ONE enforcement path instead
    // of a second, unchecked one on this DTO.
    await this.applySupervisor(employee.id, dto.supervisorId, actor);

    // Create user login credentials
    const temporaryPassword = this.generateTempPassword();
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(temporaryPassword, salt);

    await this.prisma.user.create({
      data: {
        email: employee.email,
        passwordHash,
        role: 'EMPLOYEE',
        employeeId: employee.id,
        isActive: true,
      },
    });

    // Send welcome email
    try {
      await this.mailService.sendWelcomeEmail(employee.email, {
        employeeName: employee.fullName,
        employeeCode: employee.employeeCode,
        position: employee.position,
        department: employee.department.name,
        startDate: employee.startDate.toISOString().split('T')[0],
        email: employee.email,
        temporaryPassword,
      });
    } catch (mailError) {
      this.logger.error(
        `Failed to send welcome email to ${employee.email}:`,
        mailError.message,
      );
    }

    // The same credentials over WhatsApp. Previously only "Resend credentials"
    // did this, so the one moment an employee is guaranteed to be waiting for
    // their login — the moment they were added — was email-only.
    void this.sendCredentialsWhatsApp(employee, temporaryPassword).catch((e) =>
      this.logger.warn(`WhatsApp credentials send skipped: ${(e as Error).message}`),
    );

    return {
      success: true,
      message: 'Employee created successfully',
      data: employee,
    };
  }

  // Lightweight active-employee directory for pickers (e.g. project members).
  async directory(search?: string) {
    const where: any = { status: 'ACTIVE' };
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { employeeCode: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    const employees = await this.prisma.employee.findMany({
      where,
      take: 500,
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        email: true,
        avatarUrl: true,
        position: true,
      },
    });
    return { success: true, data: employees };
  }

  async findAll(query: QueryEmployeesDto) {
    const {
      search,
      departmentId,
      departmentIds,
      position,
      status,
      gender,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;
    const skip = (page - 1) * limit;

    // `sortBy` is interpolated into Prisma's `orderBy` below, so an unknown key
    // is a driver error rather than a validation one. The DTO allowlist catches
    // the HTTP path; this guard covers callers that bypass the pipe (MCP tools,
    // other services) so a bad key degrades to the default instead of a 500.
    const orderByField: EmployeeSortField = (
      EMPLOYEE_SORT_FIELDS as readonly string[]
    ).includes(sortBy)
      ? (sortBy as EmployeeSortField)
      : 'createdAt';

    const where: any = {};

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { employeeCode: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }

    if (departmentId) where.departmentId = departmentId;
    // Multi-department scope (e.g. a MANAGER who heads several departments).
    // Overrides the single-department filter above when provided.
    if (departmentIds && departmentIds.length > 0) {
      where.departmentId = { in: departmentIds };
    }
    if (position) where.position = { contains: position, mode: 'insensitive' };
    if (status) where.status = status;
    if (gender) where.gender = gender;

    const [employees, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          employeeCode: true,
          fullName: true,
          email: true,
          phone: true,
          position: true,
          status: true,
          gender: true,
          baseSalary: true,
          // baseSalary is meaningless without its basis — a per-day rate for
          // daily-wage staff, a monthly amount otherwise.
          salaryType: true,
          employmentType: true,
          startDate: true,
          avatarUrl: true,
          departmentId: true,
          // Without this the template-driven list columns would render blank:
          // the select is an explicit allowlist, so a new field is never
          // returned for free.
          customFields: true,
          department: {
            select: { id: true, code: true, name: true },
          },
          user: {
            select: { id: true, email: true, role: true, isActive: true },
          },
          contracts: {
            where: { status: 'ACTIVE' },
            select: { id: true, startDate: true, endDate: true },
          },
          _count: {
            select: { faceDescriptors: true },
          },
        },
        orderBy: { [orderByField]: sortOrder },
      }),
      this.prisma.employee.count({ where }),
    ]);

    return {
      success: true,
      data: employees,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * `actor` is optional so existing internal callers (payroll, MCP tools,
   * reports) keep the full record. Only the HTTP read path passes it, and only
   * then are fields the caller may not see stripped.
   */
  async findOne(id: string, actor?: { role: string; isSelf: boolean }) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        department: {
          select: { id: true, code: true, name: true },
        },
        // Departments this employee heads (a manager may head more than one).
        managedDepartments: {
          where: { isActive: true },
          select: { id: true, code: true, name: true },
          orderBy: { name: 'asc' },
        },
        user: {
          select: { id: true, email: true, role: true, isActive: true },
        },
        contracts: {
          where: { status: 'ACTIVE' },
          orderBy: { startDate: 'desc' },
          take: 1,
        },
        _count: {
          select: {
            contracts: true,
            attendances: true,
            leaveRequests: true,
            rewards: true,
            disciplines: true,
          },
        },
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Object-level branch authorization (findUnique-by-id is not auto-scoped).
    assertInBranch(employee.branchId);

    const projected = actor
      ? projectEmployeeForRole(
          employee,
          (await this.templates.resolve(employee.branchId)).fields,
          actor,
        )
      : employee;

    return {
      success: true,
      data: projected,
    };
  }

  /**
   * An employee editing their own record.
   *
   * Narrows the patch to the fields the active template marks `selfEditable`,
   * then delegates to the normal update. Filtering rather than rejecting is
   * deliberate and preserves the previous behaviour: the old controller code
   * destructured five fields and silently ignored the rest, and a self-service
   * form that posts its whole model should not start failing because one
   * read-only field rode along.
   *
   * `customFields` is the exception — those go through the permission check in
   * resolveCustomFields, which throws, because a custom field the user cannot
   * edit is a field they were shown and typed into.
   */
  async updateAsSelfService(
    id: string,
    dto: UpdateEmployeeDto,
    userId?: string,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: { branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const template = await this.templates.resolve(employee.branchId);
    const editable = new Set(
      template.fields
        .filter((f) => f.selfEditable && f.storage === 'COLUMN')
        .map((f) => f.fieldKey),
    );

    const narrowed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (key === 'customFields') {
        narrowed.customFields = value;
        continue;
      }
      if (!editable.has(key)) continue;
      // '' means "inherit the company default" for the nullable preference
      // columns; storing an empty string there would defeat that.
      narrowed[key] = value === '' ? null : value;
    }

    return this.update(id, narrowed as UpdateEmployeeDto, userId, {
      role: 'EMPLOYEE',
      isSelf: true,
    });
  }

  /**
   * Drop profile-table keys this actor may not write.
   *
   * The employee_profiles columns are governed by the same template as the
   * employees columns — placeOfBirth, taxCode, bankAccountNumber and
   * socialInsuranceNumber are all template fields — but PATCH
   * /employees/:id/profile spread the whole DTO into the upsert without
   * consulting any of it.
   *
   * Dropping rather than throwing, deliberately, and matching
   * updateAsSelfService: this endpoint is posted by a form that sends its whole
   * model, so a read-only field riding along must not fail the request. A field
   * the actor cannot write is simply not written. `customFields` is the
   * exception and still throws, because those are typed in by hand.
   *
   * Fields the template does not govern pass through unchanged — this method
   * narrows what the template CAN speak for, and is not a whitelist of the
   * profile table.
   */
  private async narrowProfileWrite(
    dto: Record<string, unknown>,
    branchId: string | null | undefined,
    actor: FieldActor,
  ): Promise<Record<string, unknown>> {
    const template = await this.templates.resolve(branchId ?? null);
    const governed = new Map(
      template.fields
        .filter((f) => f.storage === 'COLUMN')
        .map((f) => [f.fieldKey, f] as const),
    );

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto ?? {})) {
      const field = governed.get(key);
      if (field && !canEditField(field, actor)) continue;
      out[key] = value;
    }
    return out;
  }

  async update(
    id: string,
    dto: UpdateEmployeeDto,
    userId: string | undefined,
    // Required, with no default. While it was optional the privileged branch of
    // the controller simply did not pass one, so an HR_MANAGER could write a
    // custom field marked editableByRoles: ['ADMIN']. A default here would
    // recreate that hole silently; callers with no human behind them say so by
    // passing SYSTEM_ACTOR.
    actor: FieldActor,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      // The login row travels with the address — see the email block below.
      include: { user: { select: { id: true, email: true } } },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Object-level branch authorization.
    assertInBranch(employee.branchId);

    // Validate age if changing
    if (dto.dateOfBirth) {
      const birthDate = new Date(dto.dateOfBirth);
      const age = Math.floor(
        (new Date().getTime() - birthDate.getTime()) /
          (365.25 * 24 * 60 * 60 * 1000),
      );
      if (age < 18) {
        throw new BadRequestException(
          'Employee must be at least 18 years old (Indian labor law)',
        );
      }
      if (age > 100) {
        throw new BadRequestException('Invalid date of birth');
      }
    }

    // No start-date check here on purpose: UpdateEmployeeDto has no startDate
    // field, so the value cannot change through this path.

    // Check email uniqueness if changing
    if (dto.email && dto.email !== employee.email) {
      const existingEmail = await this.prisma.employee.findUnique({
        where: { email: dto.email },
      });
      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    // ── The login row moves with the address ────────────────────────────────
    // `users.email` is what AuthService.login looks up, and this method never
    // touched it. Editing an employee's email left the account answering to the
    // OLD address while every mail — the welcome mail, Resend Credentials — went
    // to the NEW one, so the person was told "Email does not exist in the
    // system" while holding a password that was in fact correct. Three rows on
    // PROD had drifted this way before it was found.
    //
    // Compared against `user.email`, not `employee.email`, so a row that already
    // drifted heals on the next edit instead of staying broken because the two
    // employee-side values happen to match.
    const linkedUser = employee.user;
    const syncUserEmail =
      !!dto.email && !!linkedUser && dto.email !== linkedUser.email;
    if (syncUserEmail) {
      // users.email is UNIQUE too. Refuse here, or the employee row saves and
      // the paired user update dies inside the transaction on a raw P2002 that
      // names a constraint instead of telling the admin what to do.
      const clash = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (clash && clash.id !== linkedUser!.id) {
        throw new ConflictException(
          'Email already exists on another user account',
        );
      }
    }

    // Check ID card uniqueness if changing
    if (dto.idCard && dto.idCard !== employee.idCard) {
      const existingIdCard = await this.prisma.employee.findUnique({
        where: { idCard: dto.idCard },
      });
      if (existingIdCard) {
        throw new ConflictException('ID card already exists');
      }
    }

    // Validate department if changing
    if (dto.departmentId && dto.departmentId !== employee.departmentId) {
      const department = await this.prisma.department.findUnique({
        where: { id: dto.departmentId },
      });
      if (!department) {
        throw new BadRequestException('Department not found');
      }

      // Business Rule: Cannot move employee to inactive department
      if (!department.isActive) {
        throw new BadRequestException(
          'Cannot assign employee to inactive department',
        );
      }

      // A manager may head one or more departments independently of the
      // department they belong to, so moving a manager to a different department
      // is allowed and does not strand any managed department (approval authority
      // flows from Department.managerId, not from the manager's own departmentId).

      // A parented department is NOT refused here. See the note in `create()`:
      // sub-departments hold staff in this product, and teams are the separate
      // `Team`/`TeamMember` model. Refusing one here also froze every employee
      // already filed under a sub-department — no edit that touched the
      // department could be saved, including moving them back out.
    }

    // ── Pay basis is derived, not accepted ──────────────────────────────────
    // The employment type in force AFTER this update — the caller may be
    // changing only the salary, leaving the stored type in play.
    const nextEmploymentType =
      dto.employmentType !== undefined
        ? dto.employmentType
        : employee.employmentType;
    const derivedSalaryType =
      await this.payBasisForEmploymentType(nextEmploymentType);

    // `effective` is what actually gets written and diffed. Deriving into it
    // (rather than into updateData at the end) means a derived flip lands in
    // EmployeeHistory exactly like a hand-made one.
    const effective: Record<string, any> = { ...dto };
    if (derivedSalaryType) {
      // Reject rather than silently coerce. The form locks its Pay Basis select
      // so a UI user cannot get here; an API or MCP client that does deserves to
      // be told its write was ignored instead of discovering it at payroll time.
      if (dto.salaryType && toSalaryBasis(dto.salaryType) !== derivedSalaryType) {
        throw new BadRequestException(
          `Pay basis is fixed by employment type "${nextEmploymentType}" ` +
            `(${derivedSalaryType}) and cannot be set directly. ` +
            `Change the employment type, or clear its pay basis in the Employment Types library.`,
        );
      }
      effective.salaryType = derivedSalaryType;
    } else if (dto.salaryType) {
      effective.salaryType = toSalaryBasis(dto.salaryType);
    }
    // No derived basis and none supplied => the stored salaryType is left alone.
    // Never reset to MONTHLY: that would silently re-read a per-day rate as a
    // monthly salary the moment someone edits an unrelated field.

    // Log history for important changes
    // salaryType is tracked because flipping it re-interprets baseSalary from a
    // monthly amount to a per-day rate (or back), and employmentType because it
    // is what derives that flip.
    const historyFields = [
      'position',
      'departmentId',
      'baseSalary',
      'salaryType',
      'employmentType',
      'status',
    ];
    const historyEntries: any[] = [];

    for (const field of historyFields) {
      if (effective[field] !== undefined && effective[field] !== employee[field]) {
        historyEntries.push({
          employeeId: id,
          field,
          // ?? '' so a previously-unset field reads as empty, not "null".
          oldValue: String(employee[field] ?? ''),
          newValue: String(effective[field] ?? ''),
          changedBy: userId || id,
        });
      }
    }

    // Update employee
    const updateData: any = { ...effective };
    if (dto.dateOfBirth) updateData.dateOfBirth = new Date(dto.dateOfBirth);
    if (dto.endDate) updateData.endDate = new Date(dto.endDate);
    // '' is how the form says "clear it and go back to the branch/global default";
    // an unrecognised code becomes null rather than being stored to fail later.
    if (dto.phoneCountryCode !== undefined) {
      updateData.phoneCountryCode = normalisePhoneRegion(dto.phoneCountryCode) || null;
    }

    // Applied through SupervisorsService below, never written as a plain column.
    delete updateData.supervisorId;

    // Template-driven custom fields. Merged into the existing bag rather than
    // replacing it, so a PATCH that sends one field does not wipe the rest.
    const custom = await this.resolveCustomFields(
      dto.customFields,
      employee.branchId,
      { partial: true, existing: employee.customFields, actor },
    );
    if (custom) {
      updateData.customFields = custom.merged;
      historyEntries.push(
        ...custom.changes.map((c) => ({
          employeeId: id,
          field: `custom.${c.fieldKey}`,
          oldValue: c.oldValue,
          newValue: c.newValue,
          changedBy: userId || id,
        })),
      );
    }

    // Same guard as the profile path: a column that is NOT NULL with a default
    // reads as "optional" everywhere above this line, so an explicit null can
    // reach Prisma and take the whole statement down with an error that names
    // the wrong field.
    const employeeData = stripUnsettableNulls(updateData, 'Employee');

    const [updatedEmployee] = await this.prisma.$transaction([
      this.prisma.employee.update({
        where: { id },
        data: employeeData,
        include: {
          department: {
            select: { id: true, code: true, name: true },
          },
        },
      }),
      // Create history entries
      ...(historyEntries.length > 0
        ? [this.prisma.employeeHistory.createMany({ data: historyEntries })]
        : []),
      // Same transaction on purpose: an employee row whose address moved while
      // its login row did not is the exact defect above, so the two either both
      // land or neither does.
      ...(syncUserEmail
        ? [
            this.prisma.user.update({
              where: { id: linkedUser!.id },
              data: { email: dto.email },
            }),
          ]
        : []),
    ]);

    // After the row is current, so the cycle check reads the same state the
    // caller just wrote. Throws on an invalid assignment, which is the point:
    // the rest of the update standing while a bad supervisor is silently
    // dropped would be worse than a 400.
    await this.applySupervisor(id, dto.supervisorId, { id: userId });

    return {
      success: true,
      message: 'Employee updated successfully',
      data: updatedEmployee,
    };
  }

  /**
   * Soft delete. This is the third path that ends an employment (alongside
   * TerminationRequestService.approveTermination and ContractsService.terminate)
   * and therefore carries the same asset-clearance gate — a control with two of
   * three doors guarded is not a control.
   */
  async delete(
    id: string,
    actor?: { id?: string; role?: string },
    clearanceOverrideReason?: string,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        user: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Object-level branch authorization.
    assertInBranch(employee.branchId);

    await this.clearance.assertCleared(id, {
      actorUserId: actor?.id,
      actorRole: actor?.role,
      reason: clearanceOverrideReason,
    });

    await this.prisma.$transaction(async (tx) => {
      // Soft delete — the person is marked as having left.
      //
      // R72: this path used to write `TERMINATED` while the two contract-side
      // offboarding paths (`TerminationRequestService.approveTermination` and
      // `ContractsService.terminate`) wrote `INACTIVE`. One outcome — this
      // person has left — recorded two different ways, so every query keying
      // on one status silently missed the other population.
      //
      // `INACTIVE` is what the rest of the codebase already reads back:
      // `DashboardService.getTurnoverStats` counts `status = 'INACTIVE'` AS
      // terminations, `getDepartmentTurnover` groups on it, and the chatbot's
      // headcount answers from it. Nothing outside this file read
      // `Employee.status === 'TERMINATED'`. So all three exits write
      // `INACTIVE`, and `TERMINATED` stays what it always was: a CONTRACT
      // status.
      await tx.employee.update({
        where: { id },
        data: {
          status: 'INACTIVE',
          endDate: new Date(),
        },
      });
      // G29: leaving does NOT clear what is owed. An unrecovered carry-forward
      // balance becomes a RECEIVABLE — a debt on record — rather than being
      // written off silently. `GarnishmentsService.waive` stays the only path
      // that erases one, and it demands a reason.
      await this.garnishments.markOutstandingAsReceivable(id, tx);


      // Deactivate linked user account if exists
      if (employee.user) {
        await tx.user.update({
          where: { id: employee.user.id },
          data: { isActive: false },
        });
      }
    });

    return {
      success: true,
      message: 'Employee terminated successfully',
    };
  }

  /**
   * Permanent delete. Unlike `delete()` above, this one actually removes the
   * row — so every `onDelete` rule on every FK that points at Employee fires,
   * and two of them used to take a project's chain of command with them.
   *
   * `actor` is optional only so the three specs that construct this service
   * positionally keep compiling; the controller always passes the caller, and
   * it is what makes the handover's audit rows attributable to a person rather
   * than to nobody.
   */
  async hardDelete(id: string, actor?: { id?: string }) {
    const settings = await this.settingsService.getAllSettings();
    if (settings['allow_hard_delete_terminated'] !== 'true') {
      throw new BadRequestException(
        'Hard delete is not enabled. Enable it in System Settings first.',
      );
    }

    const employee = await this.prisma.employee.findUnique({ where: { id } });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }
    // R72: an exit is `INACTIVE` on all three offboarding paths now.
    // `TERMINATED` is still admitted because rows written by the pre-fix soft
    // delete carry it, and those people must stay permanently deletable.
    if (employee.status !== 'INACTIVE' && employee.status !== 'TERMINATED') {
      throw new BadRequestException(
        'Only terminated employees can be permanently deleted.',
      );
    }

    // Loan/advance history must outlive the person for statutory audit, so the
    // FK is onDelete: RESTRICT. Check explicitly, or this surfaces as a raw
    // P2003 that nobody can act on.
    const loanCount = await this.prisma.advanceLoanRequest.count({
      where: { employeeId: id },
    });
    if (loanCount > 0) {
      throw new BadRequestException(
        `Cannot permanently delete: ${loanCount} advance/loan record(s) must be retained ` +
          `for statutory audit. Keep the employee soft-deleted (INACTIVE) instead.`,
      );
    }

    // The login row is NOT cascaded away: User.employeeId is onDelete: SetNull,
    // so a hard delete used to leave an orphan user holding the person's email
    // on a UNIQUE column — re-onboarding them then failed with "User email
    // already exists" forever. Release the email as part of the same
    // transaction, then drop the row entirely when nothing references it.
    // Straight deletion cannot be the primary path: several relations point at
    // User with onDelete: Restrict (leave approvals, termination requests,
    // contract appendices, task attachments), so an approver's account would
    // fail with P2003 and block the whole delete.
    const linkedUser = await this.prisma.user.findFirst({
      where: { OR: [{ employeeId: id }, { email: employee.email }] },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      // R12 + R13 — hand over what this delete would otherwise destroy, in the
      // SAME transaction as the delete itself.
      //
      // `Project.ownerId` is `onDelete: SetNull` and `ProjectMember.employeeId`
      // is `onDelete: Cascade`, so `tx.employee.delete()` below nulls the owner
      // of every project this person owned AND erases their membership rows in
      // one instant — severing both of the routes
      // `ProjectAccessService.getAccess()` has to owner rights, so the surviving
      // members were 403 on their own project and only a global ADMIN could act
      // on it again. Reassigning first, inside this transaction, means a project
      // can never be OBSERVED ownerless: either the whole delete lands with a
      // new owner in place, or none of it does.
      //
      // Only this HARD path. The soft delete above writes
      // `Employee.status = 'INACTIVE'` and fires neither FK, so an ordinary
      // offboarding leaves ownership exactly where it was — which is why this
      // was easy to miss.
      const handovers = await reassignProjectOwnershipOnEmployeeDelete(
        tx,
        id,
        actor?.id ?? null,
      );

      if (linkedUser) {
        await tx.user.update({
          where: { id: linkedUser.id },
          data: {
            email: `deleted+${linkedUser.id}@deleted.invalid`,
            isActive: false,
            employeeId: null,
            isEmailVerified: false,
            emailVerificationToken: null,
          },
        });
      }
      await tx.employee.delete({ where: { id } });

      for (const h of handovers) {
        this.logger.log(
          h.newOwnerId
            ? `Project ${h.projectCode} reassigned from hard-deleted employee ${id} to ${h.newOwnerId} (${h.via})`
            : `Project ${h.projectCode} left OWNERLESS by the hard delete of employee ${id} — see GET /projects/ownerless`,
        );
      }
    });

    if (linkedUser) {
      await this.prisma.user
        .delete({ where: { id: linkedUser.id } })
        .catch(() =>
          this.logger.log(
            `User ${linkedUser.id} kept as an anonymized tombstone: still referenced by retained records`,
          ),
        );
    }

    return {
      success: true,
      message: 'Employee permanently deleted from the database',
    };
  }

  async getHistory(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const history = await this.prisma.employeeHistory.findMany({
      where: { employeeId: id },
      orderBy: { changedAt: 'desc' },
      take: 50,
    });

    return {
      success: true,
      data: history,
    };
  }

  async getStatistics() {
    const [total, byStatus, byDepartment, byGender, avgSalary] =
      await Promise.all([
        this.prisma.employee.count(),
        this.prisma.employee.groupBy({
          by: ['status'],
          _count: { status: true },
        }),
        this.prisma.employee.groupBy({
          by: ['departmentId'],
          _count: { departmentId: true },
        }),
        this.prisma.employee.groupBy({
          by: ['gender'],
          _count: { gender: true },
        }),
        this.prisma.employee.aggregate({
          _avg: { baseSalary: true },
        }),
      ]);

    // Get department names
    const departments = await this.prisma.department.findMany({
      select: { id: true, name: true, code: true },
    });

    const deptMap = new Map(departments.map((d) => [d.id, d]));

    return {
      success: true,
      data: {
        total,
        byStatus: byStatus.map((s) => ({
          status: s.status,
          count: s._count.status,
        })),
        byDepartment: byDepartment.map((d) => ({
          department: deptMap.get(d.departmentId),
          count: d._count.departmentId,
        })),
        byGender: byGender.map((g) => ({
          gender: g.gender,
          count: g._count.gender,
        })),
        averageSalary: avgSalary._avg.baseSalary,
      },
    };
  }

  /**
   * Get employees without active contract
   * Used for contract creation to show only eligible employees
   */
  async getEmployeesWithoutActiveContract(limit: number = 100) {
    // Get all active employees
    const employees = await this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
      },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        phone: true,
        position: true,
        avatarUrl: true,
        department: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        contracts: {
          where: {
            status: 'ACTIVE',
          },
          select: {
            id: true,
          },
        },
      },
      take: Math.min(limit, 100), // Max 100
      orderBy: {
        fullName: 'asc',
      },
    });

    // Filter out employees with active contracts
    const employeesWithoutContract = employees.filter(
      (emp) => emp.contracts.length === 0,
    );

    // Remove contracts field from response
    const cleanedEmployees = employeesWithoutContract.map((emp) => {
      const { contracts, ...rest } = emp;
      return rest;
    });

    return {
      success: true,
      data: cleanedEmployees,
      meta: {
        total: cleanedEmployees.length,
        totalActive: employees.length,
        withContract: employees.length - cleanedEmployees.length,
      },
    };
  }

  // Public method to generate next employee code
  async generateNextEmployeeCode(departmentId?: string): Promise<string> {
    return this.generateEmployeeCode(departmentId);
  }

  private getDepartmentShortName(name: string): string {
    const words = name.trim().split(/[\s\-_]+/);
    if (words.length === 1) {
      const word = words[0];
      if (word.length <= 3) {
        return word.toUpperCase();
      }
      return word.slice(0, 2).toUpperCase();
    }
    return words
      .map((w) => w.charAt(0))
      .join('')
      .toUpperCase();
  }

  private async generateEmployeeCode(departmentId?: string): Promise<string> {
    let deptShortName = 'EMP';
    let targetDeptId = departmentId;

    if (!targetDeptId) {
      const firstDept = await this.prisma.department.findFirst();
      if (firstDept) {
        targetDeptId = firstDept.id;
      }
    }

    if (targetDeptId) {
      const department = await this.prisma.department.findUnique({
        where: { id: targetDeptId },
      });
      if (department) {
        deptShortName = this.getDepartmentShortName(department.name);
      }
    }

    const companyShortname = await this.settingsService.getSetting(
      'company_shortname',
      'TRS',
    );

    const prefix = `${companyShortname}-${deptShortName}-`;

    // Employee codes are globally unique — the "last code" lookup must see ALL
    // branches, so bypass branch scoping (otherwise a per-branch max reuses a
    // number that already exists in another branch => unique-constraint 500).
    const employees = await runWithBranchBypass(() =>
      this.prisma.employee.findMany({
        where: {
          employeeCode: { startsWith: prefix },
        },
        select: { employeeCode: true },
        orderBy: { employeeCode: 'desc' },
        take: 1,
      }),
    );

    let nextNumber = 1;
    if (employees.length > 0 && employees[0].employeeCode) {
      const lastCode = employees[0].employeeCode;
      const parts = lastCode.split('-');
      const lastNumStr = parts[parts.length - 1];
      const currentNumber = parseInt(lastNumStr, 10);
      if (!isNaN(currentNumber)) {
        nextNumber = currentNumber + 1;
      }
    }

    return `${prefix}${nextNumber.toString().padStart(3, '0')}`;
  }

  /**
   * The pay basis an employment type FORCES on its employees, or undefined when
   * the type is blank, unknown, or carries no flag.
   *
   * The server is the source of truth for pay basis: an EMPLOYMENT_TYPE library
   * item flagged DAILY makes every employee assigned to it a daily-wage worker,
   * and the employee form locks its Pay Basis select to match. Before this, the
   * two were unrelated fields and "Employment Type = Daily Wage, Pay Basis =
   * Monthly salary" was silently accepted — the employee's per-day rate was then
   * paid as a whole month's salary.
   *
   * Note there is no employment-type LABEL anywhere in this logic. The flag on
   * the library row is the entire contract, so an admin can mark any custom type
   * as daily-wage and renaming a type never breaks payroll.
   */
  async payBasisForEmploymentType(
    employmentType?: string | null,
  ): Promise<SalaryBasisValue | undefined> {
    if (!employmentType?.trim()) return undefined;
    const item = await this.prisma.libraryItem.findUnique({
      where: {
        libraryType_label: {
          libraryType: LibraryType.EMPLOYMENT_TYPE,
          label: employmentType,
        },
      },
      select: { payBasis: true },
    });
    return item?.payBasis ? toSalaryBasis(item.payBasis) : undefined;
  }

  /**
   * Validate and merge template-driven custom fields.
   *
   * Custom fields are the ONLY part of the employee record the admin invents, so
   * they get their own gate rather than riding on the DTO whitelist:
   *
   *   - while the kill switch is off, sending them at all is an error, because
   *     the caller is describing fields no template governs;
   *   - unknown keys are rejected rather than dropped — a typo'd field that
   *     silently vanishes after "Saved!" is worse than a 400;
   *   - the result is MERGED into the stored bag, so a PATCH carrying one field
   *     cannot blank the others.
   *
   * Returns null when there is nothing to write, so callers can leave the column
   * untouched instead of overwriting it with an empty object.
   */
  private async resolveCustomFields(
    submitted: Record<string, unknown> | undefined,
    branchId: string | null | undefined,
    opts: {
      partial: boolean;
      existing?: unknown;
      /**
       * Required, not optional. It used to be optional and two of the three
       * call sites simply left it out, so `assertFieldsWritable` never ran on
       * either — an EMPLOYEE could write an `editableByRoles: ['ADMIN']` field
       * through PATCH /employees/:id/profile, and an HR_MANAGER could set one
       * at create time. Only PATCH /employees/:id was guarded, and that is the
       * one route every shipped permission test exercises.
       *
       * Making it mandatory turns "I forgot the actor" into a compile error.
       * Callers with no human behind them pass SYSTEM_ACTOR explicitly, so the
       * bypass is visible in the code rather than implied by an absence.
       */
      actor: { role: string; isSelf: boolean };
    },
  ): Promise<{
    merged: Record<string, unknown>;
    changes: { fieldKey: string; oldValue: string; newValue: string }[];
  } | null> {
    if (submitted === undefined) return null;

    const template = await this.templates.resolve(branchId ?? null);
    if (!template.enabled) {
      throw new BadRequestException({
        message:
          'Custom employee fields are not enabled. Turn on employee_template_enabled in system settings first.',
        errors: { customFields: 'Employee profile templates are disabled' },
      });
    }

    const jsonFields = template.fields.filter((f) => f.storage === 'JSONB');

    // Permission before validation: a caller who may not write the field should
    // be told that, not handed its validation message.
    if (opts.actor) {
      assertFieldsWritable(submitted, jsonFields, opts.actor);
    }

    const result = validateDynamicData(submitted, jsonFields, {
      country: template.country ?? undefined,
      unknownKeys: 'reject',
      partial: opts.partial,
      errorKeyPrefix: 'customFields',
    });

    if (!result.valid) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: result.errors,
      });
    }

    const existing = (opts.existing ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    const changes: { fieldKey: string; oldValue: string; newValue: string }[] =
      [];

    for (const [key, value] of Object.entries(result.normalized)) {
      const before = existing[key];
      if (before === value) continue;
      // null clears the key entirely rather than storing a JSON null, so the
      // bag stays a map of values that exist.
      if (value === null) delete merged[key];
      else merged[key] = value;
      changes.push({
        fieldKey: key,
        oldValue: before == null ? '' : String(before),
        newValue: value == null ? '' : String(value),
      });
    }

    return { merged, changes };
  }

  /**
   * Generates a fresh employeeCode and inserts the employee, retrying on a
   * uniqueness collision. The employeeCode preview (GET /employees/generate-code)
   * isn't reserved, so two concurrent onboarding sessions for the same department
   * can be shown the same next code — this is the safety net for that race,
   * not just a theoretical simultaneous-insert case.
   *
   * `derivedSalaryType` is resolved by the caller rather than here because this
   * method recurses on collisions — looking the library item up inside would
   * repeat the query on every retry.
   */
  private async createEmployeeRecord(
    dto: CreateEmployeeDto,
    attempt = 0,
    derivedSalaryType?: SalaryBasisValue,
    customFields?: Record<string, unknown>,
  ) {
    const employeeCode = await this.generateEmployeeCode(dto.departmentId);
    // Onboarding flow mirrors idCard from the previewed code and never lets the
    // user edit it — on retry, re-mirror the freshly generated code. Bulk import
    // and any other caller that didn't opt in keeps its real idCard untouched.
    // Mirror on the FIRST attempt too when the caller supplied nothing — the
    // flag previously only took effect on a retry, so an opted-in caller with
    // no idCard got a validation error rather than a generated one.
    const idCard =
      dto.autoGenerateIdCard && (attempt > 0 || !dto.idCard) ? employeeCode : dto.idCard;

    // A flagged employment type wins over whatever basis the client sent.
    const salaryType =
      derivedSalaryType ??
      (dto.salaryType ? toSalaryBasis(dto.salaryType) : undefined);

    try {
      return await this.prisma.employee.create({
        data: {
          employeeCode,
          fullName: dto.fullName,
          dateOfBirth: new Date(dto.dateOfBirth),
          gender: dto.gender,
          idCard,
          address: dto.address,
          phone: dto.phone,
          phoneCountryCode: normalisePhoneRegion(dto.phoneCountryCode) || null,
          email: dto.email,
          departmentId: dto.departmentId,
          branchId: dto.branchId,
          position: dto.position,
          startDate: new Date(dto.startDate),
          baseSalary: dto.baseSalary,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          avatarUrl: dto.avatarUrl,
          // supervisorId is NOT written here — see the delegation to
          // SupervisorsService in create()/update(), which owns the cycle,
          // active-supervisor and branch checks plus the audit trail.
          dateFormat: dto.dateFormat,
          attendanceExternalId: dto.attendanceExternalId,
          status: dto.status ?? 'ACTIVE',
          // Template-driven fields the admin added. Already validated by the
          // caller; omitted entirely when there are none so the column stays
          // NULL rather than becoming an empty object.
          ...(customFields && Object.keys(customFields).length
            ? { customFields: customFields as any }
            : {}),
          timezone: dto.timezone,
          employmentType: dto.employmentType,
          // Pay basis. A flagged employment type dictates it (see
          // payBasisForEmploymentType); otherwise the explicit choice stands.
          // Both absent => the DB default MONTHLY, so baseSalary keeps meaning
          // "monthly amount" unless DAILY is deliberately chosen.
          ...(salaryType ? { salaryType } : {}),
          overtimePolicyId: dto.overtimePolicyId,
        },
        include: {
          department: {
            select: { id: true, code: true, name: true },
          },
          // Second link in the phone-region chain, needed to WhatsApp the
          // credentials this employee is about to be given.
          branch: { select: { country: true } },
        },
      });
    } catch (err) {
      if (err.code === 'P2002') {
        const targetRaw = err.meta?.target;
        const target: string[] = Array.isArray(targetRaw)
          ? targetRaw
          : typeof targetRaw === 'string'
            ? [targetRaw]
            : [];
        const hitEmployeeCode = target.some((t) => /employee_?code/i.test(t));
        const hitIdCard = target.some((t) => /id_?card/i.test(t));
        const hitEmail = target.some((t) => /email/i.test(t));

        const canRetry =
          attempt < 5 && (hitEmployeeCode || (hitIdCard && dto.autoGenerateIdCard));
        if (canRetry) {
          return this.createEmployeeRecord(
          dto,
          attempt + 1,
          derivedSalaryType,
          customFields,
        );
        }
        if (hitIdCard) {
          throw new ConflictException('ID card already exists');
        }
        if (hitEmail) {
          throw new ConflictException('Email already exists');
        }
      }
      throw err;
    }
  }

  async getTopPerformers(
    limit: number = 5,
    period: 'week' | 'month' = 'month',
  ) {
    const now = new Date();
    const startDate =
      period === 'week'
        ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Get active employees with their attendance and rewards
    const employees = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        position: true,
        department: {
          select: { name: true },
        },
        attendances: {
          where: {
            date: { gte: startDate },
          },
          select: {
            status: true,
            isLate: true,
            workHours: true,
          },
        },
        rewards: {
          where: {
            createdAt: { gte: startDate },
          },
          select: {
            id: true,
          },
        },
      },
      take: 50, // Limit to top 50 for performance
    });

    // Calculate performance score for each employee
    const performersWithScores = employees.map((emp) => {
      const totalAttendance = emp.attendances.length;
      const presentDays = emp.attendances.filter(
        (a) => a.status === 'PRESENT',
      ).length;
      const lateDays = emp.attendances.filter((a) => a.isLate).length;
      const totalWorkHours = emp.attendances.reduce(
        (sum, a) => sum + (Number(a.workHours) || 0),
        0,
      );
      const rewardsCount = emp.rewards.length;

      // Calculate metrics (0-100 scale)
      const attendanceRate =
        totalAttendance > 0 ? (presentDays / totalAttendance) * 100 : 0;
      const onTimeRate =
        totalAttendance > 0
          ? ((totalAttendance - lateDays) / totalAttendance) * 100
          : 0;
      const avgWorkHours =
        totalAttendance > 0 ? totalWorkHours / totalAttendance : 0;

      // Work hours score (8 hours = 100%, max 10 hours = 125%)
      const workHoursScore = Math.min((avgWorkHours / 8) * 100, 125);

      // Rewards bonus (each reward = 5 points, max 20 points)
      const rewardsBonus = Math.min(rewardsCount * 5, 20);

      // Calculate weighted performance score
      // Attendance: 40%, On-time: 30%, Work hours: 20%, Rewards: 10%
      const baseScore =
        attendanceRate * 0.4 + onTimeRate * 0.3 + workHoursScore * 0.2;

      const finalScore = Math.min(baseScore + rewardsBonus, 100);

      return {
        id: emp.id,
        employeeCode: emp.employeeCode,
        name: emp.fullName,
        position: emp.position,
        department: emp.department?.name || 'N/A',
        score: Math.round(finalScore * 10) / 10, // Round to 1 decimal
        metrics: {
          attendanceRate: Math.round(attendanceRate * 10) / 10,
          onTimeRate: Math.round(onTimeRate * 10) / 10,
          avgWorkHours: Math.round(avgWorkHours * 10) / 10,
          rewardsCount,
        },
        achievements: rewardsCount,
      };
    });

    // Sort by score and take top N
    const topPerformers = performersWithScores
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return {
      success: true,
      data: topPerformers,
      meta: {
        period,
        startDate,
        endDate: now,
        totalEvaluated: employees.length,
      },
    };
  }

  // =====================================================
  // EMPLOYEE PROFILE METHODS
  // =====================================================

  /**
   * Get employee profile with extended information
   */
  /**
   * `actor` is optional here, unlike on the write paths: payroll, letters and
   * reports read profiles internally and need the whole record. Every HTTP
   * caller supplies one, which is what makes this route agree with
   * GET /employees/:id — the two used to disagree, one projecting per role and
   * the other returning everything.
   */
  async getEmployeeProfile(id: string, actor?: FieldActor) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        department: {
          select: { id: true, code: true, name: true },
        },
        profile: true,
        documents: {
          orderBy: { uploadedAt: 'desc' },
        },
        user: {
          select: { id: true, email: true, role: true },
        },
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Calculate profile completion in real-time
    const profileCompletionPercentage =
      await this.calculateProfileCompletion(id);

    // Convert BigInt to Number for JSON serialization
    const documentsWithNumberSize = employee.documents.map((doc) => ({
      ...doc,
      fileSize: Number(doc.fileSize),
    }));

    const data = {
      ...employee,
      profileCompletionPercentage, // Always at top level so frontend can read it even when profile is null
      documents: documentsWithNumberSize,
      profile: employee.profile
        ? {
            ...employee.profile,
            profileCompletionPercentage,
          }
        : null,
    };

    // projectEmployeeForRole strips bound fields from `data` and from the
    // nested `profile` object, which is where this route's sensitive columns
    // live. Skipped entirely for internal callers, as above.
    const projected = actor
      ? projectEmployeeForRole(
          data,
          (await this.templates.resolve(employee.branchId)).fields,
          actor,
        )
      : data;

    return { success: true, data: projected };
  }

  /**
   * Update employee profile.
   *
   * This is the SECOND write door onto an employee. PATCH /employees/:id runs
   * every field through the template's permissions; this route did not, so an
   * employee could write a field the other route refused them simply by posting
   * it here instead. The actor is therefore mandatory, and both the JSONB bag
   * and the profile columns are narrowed with it.
   */
  async updateEmployeeProfile(id: string, dto: any, actor: FieldActor) {
    // Check if employee exists
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: { profile: true },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // customFields live on `employees`, not `employee_profiles`. This method
    // spreads the DTO straight into the upsert, so the key has to come out here
    // or Prisma is handed a column that does not exist on this table.
    const { customFields: submittedCustom, ...rawProfileDto } = dto ?? {};

    // Profile COLUMNS need the same narrowing the JSONB bag gets. taxCode,
    // bankAccountNumber and socialInsuranceNumber all live on this table, and
    // this route accepted them from anyone who could reach it.
    const profileDto = stripUnsettableNulls(
      await this.narrowProfileWrite(rawProfileDto, employee.branchId, actor),
      'EmployeeProfile',
    );

    const custom = await this.resolveCustomFields(
      submittedCustom,
      employee.branchId,
      { partial: true, existing: employee.customFields, actor },
    );
    if (custom) {
      await this.prisma.employee.update({
        where: { id },
        data: { customFields: custom.merged as any },
      });
      if (custom.changes.length) {
        await this.prisma.employeeHistory.createMany({
          data: custom.changes.map((c) => ({
            employeeId: id,
            field: `custom.${c.fieldKey}`,
            oldValue: c.oldValue,
            newValue: c.newValue,
            changedBy: id,
          })),
        });
      }
    }

    // Update or create profile
    const profile = await this.prisma.employeeProfile.upsert({
      where: { employeeId: id },
      create: {
        employeeId: id,
        ...profileDto,
      },
      update: {
        ...profileDto,
        lastProfileUpdate: new Date(),
      },
    });

    // Calculate and update completion percentage
    await this.updateProfileCompletion(id);

    // Log activity
    await this.activityService.logActivity({
      employeeId: id,
      activityType: 'profile_update',
      action: 'updated',
      description: 'Updated detailed profile information',
      newValue: dto,
    });

    return {
      success: true,
      message: 'Profile updated successfully',
      data: profile,
    };
  }

  /**
   * Profile completion, real-time and never stored.
   *
   * WHICH fields count is template data (`includeInCompletion`), so an admin who
   * removes a field stops being told the profile is incomplete because of it —
   * the old hardcoded list kept demanding fields the form no longer showed.
   *
   * Documents keep their fixed 10%: they are attachments, not template fields.
   * With the kill switch off this falls through to the original scoring, so the
   * number a user sees does not move until the feature is deliberately enabled.
   */
  private async calculateProfileCompletion(
    employeeId: string,
  ): Promise<number> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) return 0;

    const profile = await this.prisma.employeeProfile.findUnique({
      where: { employeeId },
    });

    const template = await this.templates.resolve(employee.branchId);
    if (template.enabled) {
      return this.templateCompletion(employee, profile, template.fields, employeeId);
    }

    return this.legacyCompletion(employee, profile, employeeId);
  }

  /** Even weighting across the fields the template says count, plus documents. */
  private async templateCompletion(
    employee: Record<string, any>,
    profile: Record<string, any> | null,
    fields: { fieldKey: string; storage: string; includeInCompletion: boolean }[],
    employeeId: string,
  ): Promise<number> {
    const counted = fields.filter((f) => f.includeInCompletion);
    const docShare = await this.documentCompletionShare(employeeId);

    // No field opted in: documents are the only signal we have, so scale them to
    // the whole bar rather than reporting a permanent 10%.
    if (counted.length === 0) return Math.round((docShare / 10) * 100);

    const custom = (employee.customFields ?? {}) as Record<string, unknown>;
    const filled = counted.filter((f) => {
      const value =
        f.storage === 'JSONB'
          ? custom[f.fieldKey]
          : (employee[f.fieldKey] ?? profile?.[f.fieldKey]);
      if (value === null || value === undefined) return false;
      if (typeof value === 'string') return value.trim() !== '';
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }).length;

    return Math.round((filled / counted.length) * 90 + docShare);
  }

  /** The two documents that have always been worth 10%. */
  private async documentCompletionShare(employeeId: string): Promise<number> {
    const documents = await this.prisma.employeeDocument.findMany({
      where: {
        employeeId,
        documentType: {
          // Both legacy enum values and current library labels.
          in: ['RESUME', 'ID_CARD_FRONT', 'Resume/CV', 'ID Card Front'],
        },
      },
    });
    return documents.length >= 2 ? 10 : 0;
  }

  /** The original scoring, kept verbatim for when the kill switch is off. */
  private async legacyCompletion(
    employee: Record<string, any>,
    profile: Record<string, any> | null,
    employeeId: string,
  ): Promise<number> {
    let completion = 0;

    // Basic Employee Info (30%) - Most important
    if (employee.phone) completion += 5;
    if (employee.address) completion += 5;
    if (employee.gender) completion += 5;
    if (employee.email) completion += 5; // Always has email
    if (employee.dateOfBirth) completion += 5; // Always has DOB
    if (employee.idCard) completion += 5; // Always has ID card

    if (profile) {
      // Personal Info (15%)
      if (profile.placeOfBirth) completion += 5;
      if (profile.nationality) completion += 5;
      if (profile.maritalStatus) completion += 5;

      // Emergency Contact (15%)
      if (profile.emergencyContactName) completion += 5;
      if (profile.emergencyContactPhone) completion += 5;
      if (profile.emergencyContactRelationship) completion += 5;

      // Education (15%)
      if (profile.highestEducation) completion += 5;
      if (profile.major) completion += 5;
      if (profile.university) completion += 5;

      // Bank Info (15%)
      if (profile.bankName) completion += 5;
      if (profile.bankAccountNumber) completion += 5;
      if (profile.bankBranch) completion += 5;
    }

    completion += await this.documentCompletionShare(employeeId);

    return Math.round(completion);
  }

  /**
   * Calculate profile completion percentage (DEPRECATED - kept for backward compatibility)
   * Now we calculate on-the-fly instead of storing in DB
   */
  private async updateProfileCompletion(employeeId: string) {
    const profile = await this.prisma.employeeProfile.findUnique({
      where: { employeeId },
    });

    if (!profile) return;

    // Get employee basic info
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        phone: true,
        address: true,
        gender: true,
        email: true,
        dateOfBirth: true,
        idCard: true,
      },
    });

    if (!employee) return;

    let completion = 0;

    // Basic Employee Info (30%) - Most important
    let basicInfoScore = 0;
    if (employee.phone) basicInfoScore += 5;
    if (employee.address) basicInfoScore += 5;
    if (employee.gender) basicInfoScore += 5;
    if (employee.email) basicInfoScore += 5; // Always has email
    if (employee.dateOfBirth) basicInfoScore += 5; // Always has DOB
    if (employee.idCard) basicInfoScore += 5; // Always has ID card
    completion += basicInfoScore;

    // Personal Info (15%)
    let personalScore = 0;
    if (profile.placeOfBirth) personalScore += 5;
    if (profile.nationality) personalScore += 5;
    if (profile.maritalStatus) personalScore += 5;
    completion += personalScore;

    // Emergency Contact (15%)
    let emergencyScore = 0;
    if (profile.emergencyContactName) emergencyScore += 5;
    if (profile.emergencyContactPhone) emergencyScore += 5;
    if (profile.emergencyContactRelationship) emergencyScore += 5;
    completion += emergencyScore;

    // Education (15%)
    let educationScore = 0;
    if (profile.highestEducation) educationScore += 5;
    if (profile.major) educationScore += 5;
    if (profile.university) educationScore += 5;
    completion += educationScore;

    // Bank Info (15%)
    let bankScore = 0;
    if (profile.bankName) bankScore += 5;
    if (profile.bankAccountNumber) bankScore += 5;
    if (profile.bankBranch) bankScore += 5;
    completion += bankScore;

    // Documents (10%) — check both legacy enum values and current library labels
    const documents = await this.prisma.employeeDocument.findMany({
      where: {
        employeeId,
        documentType: {
          in: ['RESUME', 'ID_CARD_FRONT', 'Resume/CV', 'ID Card Front'],
        },
      },
    });
    if (documents.length >= 2) {
      completion += 10;
    }

    // Update profile and employee
    await this.prisma.employeeProfile.update({
      where: { employeeId },
      data: {
        profileCompletionPercentage: completion,
        lastProfileUpdate: new Date(),
      },
    });

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: {
        hasCompleteProfile: completion >= 80,
        profileLastUpdated: new Date(),
      },
    });
  }

  /**
   * Upload employee document
   */
  async uploadDocument(
    employeeId: string,
    file: Express.Multer.File,
    documentType: string,
    description?: string,
    uploadedBy?: string,
  ) {
    // Check if employee exists
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Persist the buffer via StorageService (MinIO S3 when configured; local
    // fallback otherwise) so files survive restarts/redeploys.
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const folder = documentType === 'AVATAR' ? 'avatars' : 'documents';
    const storedName =
      documentType === 'AVATAR'
        ? `avatar-${uniqueSuffix}-${sanitizedName}`
        : `doc-${uniqueSuffix}-${sanitizedName}`;
    const storedUrl = await this.storage.uploadFile(
      file.buffer,
      storedName,
      folder,
    );

    // For avatar, delete old avatar first
    if (documentType === 'AVATAR') {
      const oldAvatar = await this.prisma.employeeDocument.findFirst({
        where: {
          employeeId,
          documentType: 'AVATAR',
        },
      });

      if (oldAvatar) {
        await this.prisma.employeeDocument.delete({
          where: { id: oldAvatar.id },
        });
        // Best-effort storage cleanup — DB row is the source of truth.
        this.storage.deleteFile(oldAvatar.fileUrl).catch(() => undefined);
      }

      // Update employee avatarUrl
      const avatarUrl = storedUrl;
      await this.prisma.employee.update({
        where: { id: employeeId },
        data: { avatarUrl },
      });

      // Create document record
      const document = await this.prisma.employeeDocument.create({
        data: {
          employeeId,
          documentType,
          fileName: file.originalname,
          fileUrl: avatarUrl,
          fileSize: BigInt(file.size),
          mimeType: file.mimetype,
          description,
          uploadedBy,
        },
      });

      // Update profile completion
      await this.updateProfileCompletion(employeeId);

      // Log activity
      await this.activityService.logActivity({
        employeeId,
        activityType: 'profile_update',
        action: 'updated',
        description: 'Updated profile picture',
        metadata: { documentType: 'AVATAR' },
        performedBy: uploadedBy,
      });

      return {
        success: true,
        message: 'Avatar uploaded successfully',
        data: {
          ...document,
          fileSize: Number(document.fileSize),
          avatarUrl, // Return avatarUrl for frontend
        },
      };
    }

    // Create document record
    const document = await this.prisma.employeeDocument.create({
      data: {
        employeeId,
        documentType,
        fileName: file.originalname,
        fileUrl: storedUrl,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        description,
        uploadedBy,
      },
    });

    // Update profile completion
    await this.updateProfileCompletion(employeeId);

    // Log activity
    await this.activityService.logActivity({
      employeeId,
      activityType: 'document_upload',
      action: 'created',
      description: `Uploaded document: ${file.originalname}`,
      metadata: { documentType, fileName: file.originalname },
      performedBy: uploadedBy,
    });

    return {
      success: true,
      message: 'Document uploaded successfully',
      data: {
        ...document,
        fileSize: Number(document.fileSize), // Convert BigInt to Number for JSON
      },
    };
  }

  /**
   * Get employee documents
   */
  async getEmployeeDocuments(employeeId: string, documentType?: string) {
    const where: any = { employeeId };
    if (documentType) {
      where.documentType = documentType;
    }

    const documents = await this.prisma.employeeDocument.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      include: {
        uploader: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });

    return {
      success: true,
      data: documents.map((doc) => ({
        ...doc,
        fileSize: Number(doc.fileSize), // Convert BigInt to Number
      })),
    };
  }

  /**
   * Delete employee document
   */
  async deleteDocument(employeeId: string, documentId: string) {
    const document = await this.prisma.employeeDocument.findFirst({
      where: {
        id: documentId,
        employeeId,
      },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.prisma.employeeDocument.delete({
      where: { id: documentId },
    });

    // Best-effort storage cleanup — DB row is the source of truth.
    this.storage.deleteFile(document.fileUrl).catch(() => undefined);

    // Update profile completion
    await this.updateProfileCompletion(employeeId);

    return {
      success: true,
      message: 'Document deleted successfully',
    };
  }

  /**
   * Get profile completion stats
   */
  async getProfileCompletionStats() {
    const stats = await this.prisma.$queryRaw<any[]>`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE has_complete_profile = true) as complete,
        COUNT(*) FILTER (WHERE has_complete_profile = false) as incomplete,
        AVG(COALESCE(ep.profile_completion_percentage, 0))::INT as avg_completion
      FROM employees e
      LEFT JOIN employee_profiles ep ON e.id = ep.employee_id
      WHERE e.status = 'ACTIVE'
        ${rawBranchFilter('e')}
    `;

    return {
      success: true,
      data: {
        total: Number(stats[0].total),
        complete: Number(stats[0].complete),
        incomplete: Number(stats[0].incomplete),
        avgCompletion: Number(stats[0].avg_completion),
      },
    };
  }

  // =====================================================
  // EMPLOYEE ACTIVITY METHODS
  // =====================================================

  /**
   * Get employee activities
   */
  async getEmployeeActivities(dto: GetActivitiesDto) {
    return this.activityService.getActivities(dto);
  }

  /**
   * Get activity statistics
   */
  async getActivityStats(employeeId: string) {
    return this.activityService.getActivityStats(employeeId);
  }

  /**
   * Recalculate profile completion for all employees
   * Useful after updating the calculation logic
   */
  async recalculateAllProfileCompletions() {
    const employees = await this.prisma.employee.findMany({
      select: { id: true },
    });

    let updated = 0;
    for (const employee of employees) {
      try {
        await this.updateProfileCompletion(employee.id);
        updated++;
      } catch (error) {
        console.error(
          `Failed to update profile completion for employee ${employee.id}:`,
          error,
        );
      }
    }

    return {
      success: true,
      message: `Recalculated profile completion for ${updated} employees`,
      data: {
        total: employees.length,
        updated,
      },
    };
  }

  /**
   * A temporary password that survives every channel it is delivered over.
   *
   * `*`, `_`, `~` and a backtick are WhatsApp's formatting markers and there is
   * no way to escape them, so escapeWa() strips them from any value it renders.
   * With `*` in the symbol pool that silently deleted a character from about one
   * in five credential messages: the hash stored in the database was of the full
   * password, the employee was shown one character short, and every login came
   * back "Incorrect password" with nothing in the logs to say why. The pool is
   * the only place this can be fixed — the alternative, sending `*` unescaped,
   * makes WhatsApp swallow it into bold formatting instead.
   *
   * randomInt over Math.random: this is a credential, and Math.random is a
   * predictable PRNG. Fisher-Yates over `sort(() => 0.5 - Math.random())`, which
   * is not a uniform shuffle and left the guaranteed-class characters clustered
   * near their original positions.
   */
  private generateTempPassword(length = 10): string {
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const symbols = WA_SAFE_SYMBOLS;
    const allChars = uppercase + lowercase + numbers + symbols;

    const pick = (pool: string) => pool[randomInt(pool.length)];

    const chars = [
      pick(uppercase),
      pick(lowercase),
      pick(numbers),
      pick(symbols),
    ];
    for (let i = chars.length; i < length; i++) {
      chars.push(pick(allChars));
    }

    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
  }

  async resendWelcomeEmail(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        department: {
          select: { id: true, code: true, name: true },
        },
        // Second link in the phone-region chain, for a number typed without a
        // country prefix — see sendCredentialsWhatsApp.
        branch: { select: { country: true } },
        user: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const temporaryPassword = this.generateTempPassword();
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(temporaryPassword, salt);

    if (employee.user) {
      // The mail below goes to `employee.email`, so that is the address the
      // login has to answer to. Rows that drifted before update() started
      // syncing would otherwise be handed a fresh password for an account whose
      // email login cannot find — which is how the defect reached a real user.
      if (employee.user.email !== employee.email) {
        const clash = await this.prisma.user.findUnique({
          where: { email: employee.email },
        });
        if (clash && clash.id !== employee.user.id) {
          throw new ConflictException(
            `Another user account already uses ${employee.email}. ` +
              'Resolve the duplicate before resending credentials.',
          );
        }
      }
      await this.prisma.user.update({
        where: { id: employee.user.id },
        data: {
          email: employee.email,
          passwordHash,
          isActive: true,
        },
      });
    } else {
      await this.prisma.user.create({
        data: {
          email: employee.email,
          passwordHash,
          role: 'EMPLOYEE',
          employeeId: employee.id,
          isActive: true,
        },
      });
    }

    // Send welcome email
    await this.mailService.sendWelcomeEmail(employee.email, {
      employeeName: employee.fullName,
      employeeCode: employee.employeeCode,
      position: employee.position,
      department: employee.department.name,
      startDate: employee.startDate.toISOString().split('T')[0],
      email: employee.email,
      temporaryPassword,
    });

    // Send credentials via WhatsApp (best-effort — never fails the request)
    void this.sendCredentialsWhatsApp(employee, temporaryPassword).catch((e) =>
      this.logger.warn(`WhatsApp credentials send skipped: ${(e as Error).message}`),
    );

    return {
      success: true,
      message: 'Welcome email resent successfully',
    };
  }

  /** Fire off a WhatsApp with the temporary password. Swallows all errors. */
  private async sendCredentialsWhatsApp(
    employee: {
      fullName: string;
      employeeCode: string;
      email: string;
      phone?: string | null;
      phoneCountryCode?: string | null;
      branch?: { country?: string | null } | null;
    },
    temporaryPassword: string,
  ): Promise<void> {
    const cfg = await this.whatsappSettings.get().catch(() => null);
    if (!cfg?.enabled) return;

    // Most specific wins: what HR typed against this employee's number, then the
    // country their branch sits in, then the global WhatsApp default. No 'IN'
    // backstop — guessing a region for a national number is how a message reaches
    // a stranger who happens to hold that number in India.
    const region = firstRegion(
      employee.phoneCountryCode,
      employee.branch?.country,
      cfg.defaultRegion,
    );
    const phoneE164 = toE164(employee.phone ?? '', region);
    if (!phoneE164) {
      this.logger.debug(
        `Resend credentials: no valid phone for ${employee.employeeCode}, skipping WhatsApp`,
      );
      return;
    }

    const appUrl = process.env.FRONTEND_URL ?? '';
    const body = lines(
      bold('\ud83d\udd11 Your HR Portal Credentials'),
      '',
      `Hello ${escapeWa(employee.fullName)}, here are your updated login details:`,
      '',
      kv('Employee ID', employee.employeeCode),
      kv('Email', employee.email),
      kv('Temporary Password', temporaryPassword),
      '',
      '_Please log in and change your password immediately._',
      appUrl ? `${bold('Login:')} ${appUrl}/login` : '',
    );

    await this.whatsappOutbox.enqueueDirect({
      toE164: phoneE164,
      templateKey: 'welcome_credentials',
      body,
      dedupeKey: `resend-cred:${employee.employeeCode}:${Date.now()}`,
    });
  }

  /** Helper: fetch just departmentId for a given employee (used for MANAGER scope checks). */
  async getEmployeeDept(employeeId: string) {
    return this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true },
    });
  }

  /** Generate an Excel template for importing employees */
  /**
   * The custom (JSONB) template fields that participate in Excel import.
   *
   * Bound fields are excluded because the fixed columns already carry them, and
   * sensitive ones because a spreadsheet emailed around is the wrong place for
   * a national ID.
   */
  private async importableCustomFields() {
    const template = await this.templates.resolve(null);
    if (!template.enabled) return [];
    return template.fields.filter(
      (f) => f.isActive && f.storage === 'JSONB' && !f.isSensitive,
    );
  }

  async generateImportTemplate(res: Response) {
    const customImportFields = await this.importableCustomFields();
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet('Employee Template');

    // The fixed block is read by INDEX on import, so it lives in one constant
    // shared with the parser (see import-columns.ts). Custom template fields are
    // APPENDED after it, so a file downloaded before this feature still imports:
    // the reader matches those by header text, never by position.
    worksheet.columns = [
      ...FIXED_IMPORT_COLUMNS.map((c) => ({ ...c })),
      ...customImportFields.map((f) => ({
        header: f.required ? `${f.label} *` : f.label,
        key: `tpl_${f.fieldKey}`,
        width: 22,
      })),
    ];

    // Styling the header row to look premium
    const headerRow = worksheet.getRow(1);
    headerRow.font = {
      bold: true,
      color: { argb: 'FFFFFF' },
      name: 'Segoe UI',
      size: 11,
    };
    headerRow.height = 25;
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Add dark blue theme
    for (let col = 1; col <= worksheet.columns.length; col++) {
      const cell = headerRow.getCell(col);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '1E3A8A' },
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'D1D5DB' } },
        left: { style: 'thin', color: { argb: 'D1D5DB' } },
        bottom: { style: 'medium', color: { argb: '1E3A8A' } },
        right: { style: 'thin', color: { argb: 'D1D5DB' } },
      };
    }

    // Sample start dates are computed, not hardcoded: a literal rots the moment
    // anyone tightens employee_start_date_max_past_days, and the shipped
    // template would then fail its own import.
    const sampleStartDate = (daysAgo: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - daysAgo);
      return d.toISOString().split('T')[0];
    };

    // Add example rows
    worksheet.addRow({
      fullName: 'Nguyen Van A',
      email: 'nguyenvana@example.com',
      phone: '0912345678',
      dateOfBirth: '1995-08-20',
      gender: 'MALE',
      idCard: '001201000123',
      address: '123 Le Loi, District 1, HCMC',
      department: 'Software Development',
      position: 'Developer',
      startDate: sampleStartDate(30),
      baseSalary: 15000000,
      salaryType: 'MONTHLY',
      timezone: 'Asia/Ho_Chi_Minh',
      phoneCountryCode: 'VN',
    });

    worksheet.addRow({
      fullName: 'Tran Thi B',
      email: 'tranthib@example.com',
      phone: '0987654321',
      dateOfBirth: '1998-03-12',
      gender: 'FEMALE',
      idCard: '001201000456',
      address: '456 Nguyen Hue, District 1, HCMC',
      department: 'Human Resources',
      position: 'HR Specialist',
      startDate: sampleStartDate(15),
      baseSalary: 12000000,
      salaryType: 'MONTHLY',
      timezone: 'Asia/Ho_Chi_Minh',
      // Left blank on purpose in the second sample: an empty cell is valid and
      // means "fall back to the branch country / WhatsApp default".
      phoneCountryCode: '',
    });

    // Format example data rows nicely
    for (let rowIdx = 2; rowIdx <= 3; rowIdx++) {
      const row = worksheet.getRow(rowIdx);
      row.font = { name: 'Segoe UI', size: 10 };
      row.height = 20;
      row.alignment = { vertical: 'middle' };
      for (let col = 1; col <= worksheet.columns.length; col++) {
        row.getCell(col).border = {
          top: { style: 'thin', color: { argb: 'E5E7EB' } },
          left: { style: 'thin', color: { argb: 'E5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'E5E7EB' } },
          right: { style: 'thin', color: { argb: 'E5E7EB' } },
        };
      }
    }

    // Fetch active departments for select dropdown validation
    const activeDepts = await this.prisma.department.findMany({
      where: { isActive: true },
      select: { name: true },
    });

    // Create a hidden helper sheet to store list values (to avoid Excel's 255-char limit on literal formulas)
    const listSheet = workbook.addWorksheet('Lists', { state: 'hidden' });

    // Write departments to Column A of lists sheet
    activeDepts.forEach((dept, index) => {
      listSheet.getCell(`A${index + 1}`).value = dept.name;
    });

    // Write genders to Column B of lists sheet
    const genders = ['MALE', 'FEMALE', 'OTHER'];
    genders.forEach((gender, index) => {
      listSheet.getCell(`B${index + 1}`).value = gender;
    });

    const deptCount = activeDepts.length;
    const deptFormula =
      deptCount > 0
        ? `Lists!$A$1:$A$${deptCount}`
        : '"No departments available"';

    // Apply data validations to Gender (Col E) and Department (Col H) rows 2 to 250
    for (let rowIdx = 2; rowIdx <= 250; rowIdx++) {
      // Gender validation
      worksheet.getCell(`E${rowIdx}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['Lists!$B$1:$B$3'],
        showErrorMessage: true,
        errorTitle: 'Invalid Gender Input',
        error: 'Please choose MALE, FEMALE, or OTHER from the dropdown list.',
      };

      // Department validation
      worksheet.getCell(`H${rowIdx}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [deptFormula],
        showErrorMessage: true,
        errorTitle: 'Invalid Department Input',
        error:
          'Please select one of the registered departments from the dropdown list.',
      };
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=employee_import_template.xlsx',
    );

    await workbook.xlsx.write(res);
    res.end();
  }

  /** Parse and validate Excel sheet contents before importing */
  async previewImport(filePath: string) {
    try {
      const workbook = new Workbook();
      await workbook.xlsx.readFile(filePath);
      const worksheet = workbook.worksheets[0];

      const rows: any[] = [];
      const summary = {
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
      };

      if (!worksheet) {
        throw new BadRequestException('Excel file has no worksheets');
      }

      // Custom columns are located by header text rather than position, so a
      // file whose extra columns were reordered (or which predates them
      // entirely) still imports correctly.
      const customImportFields = await this.importableCustomFields();
      const headerRow = worksheet.getRow(1);
      const customColumnIndex = new Map<string, number>();
      if (customImportFields.length) {
        const normalize = (v: unknown) =>
          String(v ?? '')
            .replace(/\s*\*\s*$/, '')
            .trim()
            .toLowerCase();
        headerRow.eachCell((cell, colNumber) => {
          const header = normalize(cell.value);
          const match = customImportFields.find(
            (f) => normalize(f.label) === header,
          );
          // Skip the fixed block: a custom field relabelled to "Phone" must not
          // hijack a column the positional reader below also owns. Derived from
          // FIXED_IMPORT_COLUMNS so appending a fixed column cannot desync it.
          if (match && isCustomImportColumn(colNumber)) {
            customColumnIndex.set(match.fieldKey, colNumber);
          }
        });
      }

      // Pre-fetch departments for quick lookup
      const departments = await this.prisma.department.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
      });

      // Pre-fetch emails and ID cards to check duplicates
      const existingEmployees = await this.prisma.employee.findMany({
        select: { email: true, idCard: true },
      });
      const existingUsers = await this.prisma.user.findMany({
        select: { email: true },
      });

      const existingEmails = new Set([
        ...existingEmployees.map((e) => e.email.toLowerCase()),
        ...existingUsers.map((u) => u.email.toLowerCase()),
      ]);
      const existingIdCards = new Set(
        existingEmployees.map((e) => e.idCard.trim()),
      );

      // Resolved once, up here: eachRow below is a synchronous exceljs callback,
      // so the settings lookup cannot be awaited inside the row loop.
      const startDatePolicy =
        await this.settingsService.getEmploymentStartDatePolicy();

      worksheet.eachRow((row, rowNumber) => {
        // Skip header row
        if (rowNumber === 1) return;

        // Skip completely empty rows
        let hasValue = false;
        row.eachCell((cell) => {
          if (
            cell.value !== null &&
            cell.value !== undefined &&
            cell.value !== ''
          ) {
            hasValue = true;
          }
        });
        if (!hasValue) return;

        summary.totalRows++;
        const errors: string[] = [];

        const getCellValue = (colIndex: number): string => {
          const cell = row.getCell(colIndex);
          if (!cell || cell.value === null || cell.value === undefined)
            return '';
          if (typeof cell.value === 'object') {
            if ((cell.value as any).result !== undefined) {
              return String((cell.value as any).result).trim();
            }
            if (cell.value instanceof Date) {
              return cell.value.toISOString().split('T')[0];
            }
            return JSON.stringify(cell.value);
          }
          return String(cell.value).trim();
        };

        const fullName = getCellValue(1);
        const email = getCellValue(2);
        const phone = getCellValue(3);
        const dateOfBirthStr = getCellValue(4);
        const genderInput = getCellValue(5);
        const idCard = getCellValue(6);
        const address = getCellValue(7);
        const deptInput = getCellValue(8);
        const position = getCellValue(9);
        const startDateStr = getCellValue(10);
        const baseSalaryStr = getCellValue(11);
        const salaryTypeInput = getCellValue(12);
        const timezone = getCellValue(13) || 'Asia/Ho_Chi_Minh';
        // Blank is the honest answer for a sheet written before this column
        // existed: the branch country and the WhatsApp default then apply.
        const phoneCountryRaw = getCellValue(14);
        const phoneCountryCode = normalisePhoneRegion(phoneCountryRaw);
        if (phoneCountryRaw && !phoneCountryCode) {
          errors.push(
            `Phone Country "${phoneCountryRaw}" is not a valid ISO country code (e.g. OM, IN, SG)`,
          );
        }

        // 1. Full Name
        if (!fullName) {
          errors.push('Full Name is required');
        }

        // 2. Email
        if (!email) {
          errors.push('Email is required');
        } else {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(email)) {
            errors.push('Invalid email format');
          } else if (existingEmails.has(email.toLowerCase())) {
            errors.push(`Email "${email}" already exists`);
          }
        }

        // 3. Date of Birth
        let parsedDob: Date | null = null;
        if (!dateOfBirthStr) {
          errors.push('Date of Birth is required');
        } else {
          parsedDob = new Date(dateOfBirthStr);
          if (isNaN(parsedDob.getTime())) {
            errors.push('Date of Birth must be in YYYY-MM-DD format');
            parsedDob = null;
          } else {
            const age = Math.floor(
              (new Date().getTime() - parsedDob.getTime()) /
                (365.25 * 24 * 60 * 60 * 1000),
            );
            if (age < 18) {
              errors.push(
                'Employee must be at least 18 years old (Indian labor law)',
              );
            } else if (age > 100) {
              errors.push('Invalid Date of Birth (age > 100)');
            }
          }
        }

        // 4. Gender
        let gender = 'OTHER';
        if (genderInput) {
          const g = genderInput.toUpperCase();
          if (['MALE', 'FEMALE', 'OTHER'].includes(g)) {
            gender = g;
          } else {
            errors.push('Gender must be MALE, FEMALE, or OTHER');
          }
        }

        // 5. ID Card
        if (!idCard) {
          errors.push('ID Card is required');
        } else if (existingIdCards.has(idCard)) {
          errors.push(`ID Card "${idCard}" already exists`);
        }

        // 6. Department
        let departmentId = '';
        let departmentName = '';
        if (!deptInput) {
          errors.push('Department is required');
        } else {
          const dept = departments.find(
            (d) =>
              d.code.toLowerCase() === deptInput.toLowerCase() ||
              d.name.toLowerCase() === deptInput.toLowerCase(),
          );
          if (dept) {
            departmentId = dept.id;
            departmentName = dept.name;
          } else {
            errors.push(`Department "${deptInput}" not found or inactive`);
          }
        }

        // 7. Position
        if (!position) {
          errors.push('Position is required');
        }

        // 8. Start Date — same policy object as EmployeesService.create(), so a
        // row that previews clean cannot be rejected by the import itself.
        let parsedStartDate: Date | null = null;
        if (!startDateStr) {
          errors.push('Start Date is required');
        } else {
          const startCheck = checkEmploymentStartDate({
            startDate: startDateStr,
            dateOfBirth: dateOfBirthStr,
            policy: startDatePolicy,
          });
          if (startCheck.ok) {
            parsedStartDate = startCheck.date;
          } else {
            errors.push(startCheck.message);
          }
        }

        // 9. Base Salary
        let baseSalary = 0;
        if (!baseSalaryStr) {
          errors.push('Base Salary is required');
        } else {
          baseSalary = Number(baseSalaryStr);
          if (isNaN(baseSalary) || baseSalary < 0) {
            errors.push('Base Salary must be a positive number');
          }
        }

        // 10. Pay Basis. Blank means MONTHLY, matching the DB default; anything
        // else is rejected rather than silently coerced, since getting it wrong
        // re-reads Base Salary as a per-day rate (or vice versa).
        let salaryType = 'MONTHLY';
        if (salaryTypeInput) {
          const normalized = salaryTypeInput.toUpperCase();
          if (normalized !== 'MONTHLY' && normalized !== 'DAILY') {
            errors.push('Pay Basis must be MONTHLY or DAILY (or left blank)');
          } else {
            salaryType = normalized;
          }
        }

        // Custom fields, validated by the same engine the API uses so the
        // preview cannot pass a row the confirm step would then reject.
        const customValues: Record<string, unknown> = {};
        for (const [fieldKey, colIndex] of customColumnIndex) {
          const raw = getCellValue(colIndex);
          if (raw !== '') customValues[fieldKey] = raw;
        }
        let customFields: Record<string, unknown> | undefined;
        if (customImportFields.length) {
          const result = validateDynamicData(customValues, customImportFields, {
            partial: true,
            unknownKeys: 'drop',
          });
          if (!result.valid) {
            errors.push(...Object.values(result.errors));
          } else if (Object.keys(result.normalized).length) {
            customFields = result.normalized;
          }
        }

        const isValid = errors.length === 0;
        if (isValid) {
          summary.validRows++;
        } else {
          summary.invalidRows++;
        }

        rows.push({
          rowNumber,
          valid: isValid,
          errors,
          data: {
            fullName,
            email,
            phone: phone || null,
            dateOfBirth: parsedDob ? dateOfBirthStr : null,
            gender,
            idCard,
            address: address || null,
            departmentId,
            departmentName,
            position,
            startDate: parsedStartDate ? startDateStr : null,
            baseSalary,
            salaryType,
            timezone: timezone || null,
            phoneCountryCode: phoneCountryCode || null,
            ...(customFields ? { customFields } : {}),
          },
        });
      });

      // Wrapped in the standard envelope like every other endpoint.
      //
      // This returned a bare `{ summary, rows }`, which made the Excel import
      // silently impossible to use: the axios interceptor hands callers the
      // whole body, `ImportModal` reads `res.data`, and that was `undefined`.
      // The modal advanced to the preview step with an empty table and a
      // permanently disabled "Import 0 staff" button, so no spreadsheet could
      // be imported at all. `bulkImport` (the confirm half) already wraps, which
      // is why only preview broke.
      return {
        success: true,
        data: { summary, rows },
      };
    } finally {
      // Clean up temporary file asynchronously or synchronously
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch (err) {
        this.logger.error(
          `Failed to clean up uploaded import file: ${filePath}`,
          err.message,
        );
      }
    }
  }

  /** Confirm and import validated employees */
  async bulkImport(employees: CreateEmployeeDto[]) {
    const results: any[] = [];
    for (const dto of employees) {
      try {
        const res = await this.create(dto);
        results.push({
          email: dto.email,
          success: true,
          employeeCode: res.data.employeeCode,
        });
      } catch (err) {
        results.push({
          email: dto.email,
          success: false,
          error: err.message || 'Unknown error occurred',
        });
      }
    }
    return {
      success: true,
      data: results,
    };
  }

  /**
   * The workforce as a flow, not a stock.
   *
   * A headcount total is the same number most weeks and nobody acts on it.
   * Joiners and leavers are work: someone has to be onboarded, someone has to
   * be cleared. The net change is the figure a manager is actually asked about.
   *
   * Probation endings are the sharpest deadline HR owns — a confirmation date
   * that slips usually means the person is confirmed by default, which is a
   * decision nobody took.
   */
  async lifecycleStats() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
    const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [joiners, leavers, startingSoon, probation, active] = await Promise.all([
      this.prisma.employee.count({
        where: { startDate: { gte: monthStart, lte: monthEnd } },
      }),
      this.prisma.employee.count({
        where: { endDate: { gte: monthStart, lte: monthEnd } },
      }),
      // Already hired, not started — the onboarding queue.
      this.prisma.employee.findMany({
        where: { startDate: { gt: now, lte: in30 } },
        select: { id: true, fullName: true, startDate: true, department: { select: { name: true } } },
        orderBy: { startDate: 'asc' },
        take: 10,
      }),
      this.prisma.contract.findMany({
        where: {
          contractType: 'PROBATION',
          status: 'ACTIVE',
          endDate: { gte: now, lte: in30 },
        },
        select: {
          id: true,
          endDate: true,
          employee: { select: { id: true, fullName: true } },
        },
        orderBy: { endDate: 'asc' },
        take: 10,
      }),
      this.prisma.employee.count({ where: { status: 'ACTIVE' } }),
    ]);

    return {
      success: true,
      data: {
        activeHeadcount: active,
        joinersThisMonth: joiners,
        leaversThisMonth: leavers,
        netChangeThisMonth: joiners - leavers,
        startingSoon: startingSoon.map((e) => ({
          id: e.id,
          fullName: e.fullName,
          startDate: e.startDate,
          department: e.department?.name ?? null,
        })),
        probationEndingSoon: probation.map((c) => ({
          contractId: c.id,
          employeeId: c.employee?.id ?? null,
          fullName: c.employee?.fullName ?? null,
          endDate: c.endDate,
        })),
      },
    };
  }
}
