import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GarnishmentsService } from '../garnishments/garnishments.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { ContractValidationService } from './contract-validation.service';
import { CreateContractDto } from './dto/create-contract.dto';
import {
  UpdateContractDto,
  RenewContractDto,
  TerminateContractDto,
} from './dto/update-contract.dto';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { ClearanceService } from '../assets/clearance.service';
import { isDailyWage } from '../payrolls/payroll-earnings.util';
import { parseDateOnlyUTC } from '../common/utils/start-date-policy.util';
import { TimezoneService } from '../common/timezone/timezone.service';
import {
  CompanyCronGate,
  COMPANY_CRON_TICK,
} from '../common/timezone/company-cron.gate';

const CONTRACT_ALERT_RECIPIENT_ROLES = ['ADMIN', 'HR_MANAGER'];

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);
  /** Auto-expire fires at midnight in the COMPANY timezone, not the server's. */
  private readonly expireGate: CompanyCronGate;

  constructor(
    private prisma: PrismaService,
    private validationService: ContractValidationService,
    private mailService: MailService,
    private notificationsService: NotificationsService,
    private settingsService: SystemSettingsService,
    private clearance: ClearanceService,
    private tzSvc: TimezoneService,
    private readonly garnishments: GarnishmentsService,
  ) {
    this.expireGate = new CompanyCronGate(this.tzSvc, '00:00');
  }

  async create(dto: CreateContractDto) {
    // Validate employee
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });
    if (!employee) {
      throw new BadRequestException('Employee not found');
    }

    // Parse dates
    const startDate = new Date(dto.startDate);
    const endDate = dto.endDate ? new Date(dto.endDate) : null;

    // A backdated contract whose end date has already passed is born expired.
    // Writing it ACTIVE and waiting for the midnight autoExpireContracts cron
    // leaves it wrong for up to a day: it shows as current, blocks the next
    // contract, and is the one payroll picks. Same boundary as the cron (`lt`),
    // so a contract ending today is still ACTIVE.
    const todayUtc = parseDateOnlyUTC(new Date())!;
    const endDateOnly = parseDateOnlyUTC(endDate);
    const resolvedStatus =
      endDateOnly && endDateOnly < todayUtc ? 'EXPIRED' : 'ACTIVE';

    // Only a contract that would actually be current can collide with an
    // existing one. Without this scoping, entering an employee's historical
    // contract chain is impossible once they have a current contract.
    if (resolvedStatus === 'ACTIVE') {
      const activeContract = await this.prisma.contract.findFirst({
        where: {
          employeeId: dto.employeeId,
          status: 'ACTIVE',
        },
      });
      if (activeContract) {
        throw new ConflictException('Employee already has an active contract');
      }
    }

    // `contractNumber` is @unique, but nothing caught Prisma's P2002, so a
    // duplicate answered 500 with the raw driver error while every other
    // uniqueness conflict in People answers 409 with a sentence a user can act
    // on ('Team code already exists', 'Email already exists'). Checked up front
    // rather than caught, to match how the employee service reports its three.
    if (dto.contractNumber) {
      const existingNumber = await this.prisma.contract.findUnique({
        where: { contractNumber: dto.contractNumber },
        select: { id: true },
      });
      if (existingNumber) {
        throw new ConflictException(
          `Contract number "${dto.contractNumber}" already exists`,
        );
      }
    }

    // Labor-law-citation validation rules — neutralized per business decision:
    // these will become customizable toggles in the settings panel instead of
    // hardcoded contract-creation blockers. Left in place (commented) so the
    // exact rules/messages are easy to reinstate or wire up to settings later.
    //
    // if (dto.contractType === 'PROBATION') {
    //   if (!endDate) {
    //     throw new BadRequestException(
    //       'Probation contracts must have an end date',
    //     );
    //   }
    //   const validation = this.validationService.validateProbationDuration(
    //     startDate,
    //     endDate,
    //   );
    //   if (!validation.isValid) {
    //     throw new BadRequestException({
    //       message: validation.errorMessage,
    //       code: validation.errorCode,
    //       details: validation.details,
    //     });
    //   }
    // } else if (dto.contractType === 'FIXED_TERM') {
    //   if (!endDate) {
    //     throw new BadRequestException(
    //       'Fixed-term contracts must have an end date',
    //     );
    //   }
    //   const validation = this.validationService.validateFixedTermDuration(
    //     startDate,
    //     endDate,
    //   );
    //   if (!validation.isValid) {
    //     throw new BadRequestException({
    //       message: validation.errorMessage,
    //       code: validation.errorCode,
    //       details: validation.details,
    //     });
    //   }
    //
    //   // Validate contract conversion rules
    //   const conversionValidation =
    //     await this.validationService.validateContractConversion(
    //       dto.employeeId,
    //       dto.contractType,
    //     );
    //   if (!conversionValidation.isValid) {
    //     throw new BadRequestException({
    //       message: conversionValidation.errorMessage,
    //       code: conversionValidation.errorCode,
    //       details: conversionValidation.details,
    //     });
    //   }
    // } else if (dto.contractType === 'INDEFINITE') {
    //   if (endDate) {
    //     throw new BadRequestException(
    //       'Indefinite contracts must not have an end date',
    //     );
    //   }
    // }

    // Validate workType and workHoursPerWeek
    const workType = dto.workType || 'FULL_TIME';
    const workHoursPerWeek = dto.workHoursPerWeek || 40;

    // Neutralized per business decision (see note above):
    // if (workType === 'FULL_TIME') {
    //   workHoursPerWeek = 40;
    // } else if (workType === 'PART_TIME') {
    //   if (dto.workHoursPerWeek && dto.workHoursPerWeek < 1) {
    //     throw new BadRequestException(
    //       'Work hours must be at least 1 hour per week',
    //     );
    //   }
    // }

    // Generate contract number if not provided
    const contractNumber =
      dto.contractNumber || (await this.generateContractNumber());

    const contract = await this.prisma.contract.create({
      data: {
        employeeId: dto.employeeId,
        contractType: dto.contractType,
        contractNumber,
        startDate,
        endDate,
        salary: dto.salary,
        workType,
        workHoursPerWeek,
        terms: dto.terms || dto.notes, // Store both terms and notes in terms field for now
        status: resolvedStatus,
      },
      include: {
        employee: {
          select: { id: true, employeeCode: true, fullName: true },
        },
      },
    });

    // Mirror the contract salary onto the employee — unless they are paid daily.
    await this.syncEmployeeBaseSalary(dto.employeeId, dto.salary);

    return {
      success: true,
      message: 'Contract created successfully',
      data: contract,
    };
  }

  async findAll(query: {
    employeeId?: string;
    status?: string;
    page?: number | string;
    limit?: number | string;
    search?: string;
  }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { contractNumber: { contains: query.search, mode: 'insensitive' } },
        {
          employee: {
            fullName: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }

    const [contracts, total] = await Promise.all([
      this.prisma.contract.findMany({
        where,
        skip,
        take: limit,
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              position: true,
              department: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { startDate: 'desc' },
      }),
      this.prisma.contract.count({ where }),
    ]);

    return {
      success: true,
      data: contracts,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            phone: true,
            position: true,
            branchId: true,
            department: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });

    if (!contract) {
      throw new NotFoundException('Contract not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(contract.employee.branchId);

    return { success: true, data: contract };
  }

  async findByEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const contracts = await this.prisma.contract.findMany({
      where: { employeeId },
      orderBy: { startDate: 'desc' },
    });

    return { success: true, data: contracts };
  }

  async getStatistics() {
    const now = new Date();
    const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [total, active, expired, expiringSoon] = await Promise.all([
      this.prisma.contract.count(),
      this.prisma.contract.count({ where: { status: 'ACTIVE' } }),
      this.prisma.contract.count({ where: { status: 'EXPIRED' } }),
      this.prisma.contract.count({
        where: {
          status: 'ACTIVE',
          endDate: { gte: now, lte: thirtyDaysLater },
        },
      }),
    ]);

    return {
      success: true,
      data: { total, active, expired, expiringSoon },
    };
  }

  async update(id: string, dto: UpdateContractDto) {
    const contract = await this.prisma.contract.findUnique({
      where: { id },
      include: { employee: { select: { branchId: true } } },
    });
    if (!contract) {
      throw new NotFoundException('Contract not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(contract.employee.branchId);

    const updateData: any = { ...dto };
    if (dto.endDate) updateData.endDate = new Date(dto.endDate);

    const updated = await this.prisma.contract.update({
      where: { id },
      data: updateData,
      include: {
        employee: {
          select: { id: true, employeeCode: true, fullName: true },
        },
      },
    });

    // Update employee salary if changed
    if (dto.salary) {
      await this.syncEmployeeBaseSalary(contract.employeeId, dto.salary);
    }

    return {
      success: true,
      message: 'Contract updated successfully',
      data: updated,
    };
  }

  async renew(id: string, dto: RenewContractDto) {
    const contract = await this.prisma.contract.findUnique({
      where: { id },
      include: { employee: { select: { branchId: true } } },
    });
    if (!contract) {
      throw new NotFoundException('Contract not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(contract.employee.branchId);

    // Terminate old contract
    await this.prisma.contract.update({
      where: { id },
      data: { status: 'EXPIRED' },
    });

    // Create new contract
    const newContractNumber = await this.generateContractNumber();
    const newContract = await this.prisma.contract.create({
      data: {
        employeeId: contract.employeeId,
        contractType: dto.newContractType || contract.contractType,
        contractNumber: newContractNumber,
        startDate: contract.endDate || new Date(),
        endDate: new Date(dto.newEndDate),
        salary: dto.newSalary || contract.salary,
        status: 'ACTIVE',
      },
      include: {
        employee: {
          select: { id: true, employeeCode: true, fullName: true },
        },
      },
    });

    // Update employee salary
    if (dto.newSalary) {
      await this.syncEmployeeBaseSalary(contract.employeeId, dto.newSalary);
    }

    return {
      success: true,
      message: 'Contract renewed successfully',
      data: newContract,
    };
  }

  /**
   * Mirror a contract's salary onto Employee.baseSalary — but never for
   * daily-wage staff.
   *
   * A Contract has no pay basis of its own, so `salary` is just a number: HR
   * enters a monthly figure. For an employee whose baseSalary is a PER-DAY rate,
   * writing that number through turns e.g. 500/day into 13000/day, roughly a
   * 26x overpayment on the next payroll run. The contract still records its own
   * salary; only the employee's rate is left alone.
   */
  private async syncEmployeeBaseSalary(employeeId: string, salary: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { salaryType: true, employeeCode: true },
    });

    if (isDailyWage(employee?.salaryType)) {
      this.logger.log(
        `Contract salary ${salary} NOT copied to employee ${employee?.employeeCode ?? employeeId}: ` +
          `they are paid daily, so baseSalary is a per-day rate. Edit the daily rate on the employee record instead.`,
      );
      return;
    }

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { baseSalary: salary },
    });
  }

  /**
   * Direct termination, with no approval workflow. Still an offboarding path,
   * so it carries the same asset-clearance gate as the approved route —
   * otherwise this endpoint would be the way around it.
   */
  async terminate(
    id: string,
    dto: TerminateContractDto,
    actor?: { id?: string; role?: string },
  ) {
    const contract = await this.prisma.contract.findUnique({
      where: { id },
      include: { employee: { select: { branchId: true } } },
    });
    if (!contract) {
      throw new NotFoundException('Contract not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(contract.employee.branchId);

    await this.clearance.assertCleared(contract.employeeId, {
      actorUserId: actor?.id,
      actorRole: actor?.role,
      reason: dto.clearanceOverrideReason,
    });

    const endDate = new Date();

    const terminated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.contract.update({
        where: { id },
        data: {
          status: 'TERMINATED',
          terminatedReason: dto.reason,
          endDate,
        },
      });
      // R72: `INACTIVE` is the ONE value every offboarding path writes for
      // "this person has left" — this one,
      // `TerminationRequestService.approveTermination` and
      // `EmployeesService.delete`, which used to write `TERMINATED` and split
      // the leaver population in two. The CONTRACT above is `TERMINATED`;
      // that is the contract's status, not the person's.
      await tx.employee.update({
        where: { id: contract.employeeId },
        data: {
          status: 'INACTIVE',
          endDate,
        },
      });
      // G29: leaving does NOT clear what is owed. An unrecovered carry-forward
      // balance becomes a RECEIVABLE — a debt on record — rather than being
      // written off silently. `GarnishmentsService.waive` stays the only path
      // that erases one, and it demands a reason.
      await this.garnishments.markOutstandingAsReceivable(contract.employeeId, tx);

      return row;
    });

    return {
      success: true,
      message: 'Contract terminated successfully',
      data: terminated,
    };
  }

  async getExpiringContracts(days: number = 30) {
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + days);

    const contracts = await this.prisma.contract.findMany({
      where: {
        status: 'ACTIVE',
        endDate: {
          gte: today,
          lte: futureDate,
        },
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            position: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { endDate: 'asc' },
    });

    // Calculate days until expiry for each contract
    const expiringContracts = contracts.map((contract) => {
      const daysUntilExpiry = contract.endDate
        ? Math.ceil(
            (new Date(contract.endDate).getTime() - today.getTime()) /
              (1000 * 60 * 60 * 24),
          )
        : 0;

      return {
        contract,
        daysUntilExpiry,
      };
    });

    return {
      success: true,
      data: expiringContracts,
      meta: { total: expiringContracts.length, days },
    };
  }

  // Cron job: Auto-expire contracts daily at company-local midnight
  @Cron(COMPANY_CRON_TICK, { name: 'auto-expire-contracts' })
  async autoExpireContractsTick() {
    if (!(await this.expireGate.due())) return;
    return this.autoExpireContracts();
  }

  async autoExpireContracts() {
    // Day boundary in the company timezone — `endDate` is a @db.Date, so the
    // comparison must use the company's calendar day, not the server's.
    const today = await this.tzSvc.nowDateKeyCompany();

    const expiredContracts = await this.prisma.contract.updateMany({
      where: {
        status: 'ACTIVE',
        endDate: {
          not: null,
          lt: today,
        },
      },
      data: {
        status: 'EXPIRED',
      },
    });

    if (expiredContracts.count > 0) {
      console.log(`[Cron] Auto-expired ${expiredContracts.count} contracts`);
    }

    return {
      success: true,
      message: `Auto-expired ${expiredContracts.count} contracts`,
      count: expiredContracts.count,
    };
  }

  /**
   * Superseded by `RemindersModule` (see `sources/contract-reminder.source.ts`),
   * which alerts at configurable tiers and also notifies the employee. Kept as a
   * plain method — no longer scheduled — so existing callers and tests still
   * work.
   *
   * @deprecated Use `RemindersService.runAll()`.
   */
  async sendContractExpiryAlerts() {
    const alertDaysStr = await this.settingsService.getSetting(
      'contract_expiry_alert_days',
      '30',
    );
    const alertDays = parseInt(alertDaysStr, 10) || 30;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const alertHorizon = new Date(today);
    alertHorizon.setDate(alertHorizon.getDate() + alertDays);

    const expiringContracts = await this.prisma.contract.findMany({
      where: {
        status: 'ACTIVE',
        expiryAlertSentAt: null,
        endDate: { not: null, gte: today, lte: alertHorizon },
      },
      include: {
        employee: {
          select: {
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
      },
    });

    if (expiringContracts.length === 0) {
      return { success: true, message: 'No contracts due for expiry alert', count: 0 };
    }

    const recipients = await this.prisma.user.findMany({
      where: { role: { in: CONTRACT_ALERT_RECIPIENT_ROLES }, isActive: true },
      select: {
        id: true,
        email: true,
        employee: { select: { fullName: true } },
      },
    });

    for (const contract of expiringContracts) {
      const daysRemaining = Math.ceil(
        (new Date(contract.endDate!).getTime() - today.getTime()) /
          (1000 * 60 * 60 * 24),
      );
      const endDateStr = new Date(contract.endDate!).toLocaleDateString(
        'en-US',
      );

      for (const recipient of recipients) {
        try {
          await this.mailService.sendContractExpiringAdminAlert(
            recipient.email,
            {
              recipientName: recipient.employee?.fullName || 'there',
              employeeName: contract.employee.fullName,
              employeeCode: contract.employee.employeeCode,
              department: contract.employee.department?.name,
              contractType: contract.contractType,
              endDate: endDateStr,
              daysRemaining,
            },
          );

          await this.notificationsService.create({
            userId: recipient.id,
            title: 'Contract Expiring Soon',
            message: `${contract.employee.fullName}'s ${contract.contractType} contract expires in ${daysRemaining} day(s) on ${endDateStr}.`,
            type: NotificationType.CONTRACT_EXPIRING,
            link: `/dashboard/contracts/${contract.id}`,
          });
        } catch (error) {
          console.error(
            `[Cron] Failed to send contract expiry alert for contract ${contract.id} to ${recipient.email}: ${error.message}`,
          );
        }
      }

      await this.prisma.contract.update({
        where: { id: contract.id },
        data: { expiryAlertSentAt: new Date() },
      });
    }

    return {
      success: true,
      message: `Sent expiry alerts for ${expiringContracts.length} contract(s) to ${recipients.length} recipient(s)`,
      count: expiringContracts.length,
    };
  }

  private async generateContractNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.prisma.contract.count({
      where: {
        contractNumber: { startsWith: `HD-${year}` },
      },
    });
    return `HD-${year}-${(count + 1).toString().padStart(3, '0')}`;
  }
}
