import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ContractStatus,
  EmployeeStatus,
  Prisma,
  RequestStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import { addDays, daysUntil, startOfUtcDay } from '../common/utils/expiry.util';
import {
  buildWorkforceTrend,
  trendWindowEnd,
  trendWindowStart,
} from '../common/utils/workforce-trend.util';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import {
  EmployeeSortBy,
  ListEmployeesDto,
  SortOrder,
} from './dto/list-employees.dto';

const EMPLOYEE_INCLUDE = {
  department: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, code: true, name: true } },
  manager: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  },
  supervisor: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  },
} satisfies Prisma.EmployeeInclude;

/** Every slice of the workforce, so the split always sums to the whole of it. */
const STATUS_LABELS: Record<EmployeeStatus, string> = {
  ACTIVE: 'Active',
  ON_LEAVE: 'On leave',
  SUSPENDED: 'Suspended',
  TERMINATED: 'Terminated',
};

/** Windows the movement trend is offered over. Anything else is a 400. */
const TREND_MONTH_OPTIONS = [6, 12];

/** How far ahead the hub looks for starters and probation reviews. */
const LOOKAHEAD_DAYS = 30;

/** Rows printed under a hub card before the reader is expected to open the list. */
const HUB_LIST_LIMIT = 10;

/**
 * The joined name these hub payloads print.
 *
 * Employee records carry `firstName` and `lastName` separately everywhere else
 * and the browser joins them — this aggregate is the exception, because its
 * rows are trimmed projections rather than employees and shipping two columns
 * per row so the screen can join them again buys nothing.
 */
function joinName(person: { firstName: string; lastName: string }): string {
  return [person.firstName, person.lastName].filter(Boolean).join(' ');
}

/** `YYYY-MM-DD` from a date-only column, without a zone conversion on the way. */
function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListEmployeesDto) {
    const { page, limit, skip, take } = resolvePagination(query);
    const insensitive = Prisma.QueryMode.insensitive;

    const where: Prisma.EmployeeWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.managerId ? { managerId: query.managerId } : {}),
      ...(query.supervisorId ? { supervisorId: query.supervisorId } : {}),
      ...(query.search
        ? {
            OR: [
              { employeeCode: { contains: query.search, mode: insensitive } },
              { firstName: { contains: query.search, mode: insensitive } },
              { lastName: { contains: query.search, mode: insensitive } },
              { workEmail: { contains: query.search, mode: insensitive } },
            ],
          }
        : {}),
    };

    // The cast is safe because `sortBy` is an enum, not free text: only the
    // four scalar columns on ListEmployeesDto can reach the computed key.
    const orderBy = {
      [query.sortBy ?? EmployeeSortBy.EMPLOYEE_CODE]:
        query.sortOrder ?? SortOrder.ASC,
    } as Prisma.EmployeeOrderByWithRelationInput;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        include: EMPLOYEE_INCLUDE,
        skip,
        take,
        orderBy,
      }),
      this.prisma.employee.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  async findOne(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: EMPLOYEE_INCLUDE,
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  /** Everyone this person signs off — the approval chain, not the org chart. */
  async findTeam(id: string) {
    await this.findOne(id);
    return this.prisma.employee.findMany({
      where: { supervisorId: id },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        position: true,
        avatarUrl: true,
        status: true,
        workEmail: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });
  }

  async create(dto: CreateEmployeeDto) {
    const existing = await this.prisma.employee.findUnique({
      where: { employeeCode: dto.employeeCode },
    });
    if (existing)
      throw new ConflictException(
        `Employee code ${dto.employeeCode} is already in use`,
      );

    await this.assertNationalIdFree(dto.nationalId);

    return this.prisma.employee.create({
      data: this.toData(dto),
      include: EMPLOYEE_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateEmployeeDto) {
    await this.findOne(id);

    await this.assertNationalIdFree(dto.nationalId, id);

    // A cycle here (A reports to B, B reports to A) would make every org-chart
    // walk and every approval-chain walk non-terminating. The one-hop self
    // check is the cheap half; the walk below catches the rest.
    if (dto.managerId) {
      if (dto.managerId === id)
        throw new BadRequestException(
          'An employee cannot report to themselves',
        );
      await this.assertNoReportingCycle(id, dto.managerId);
    }

    // The supervisor chain is walked separately because it is a separate
    // graph — see the note on `supervisorId` in the schema. A structure with no
    // manager cycle can still contain a supervisor cycle, and it is the
    // supervisor chain that every approval walks.
    if (dto.supervisorId) {
      if (dto.supervisorId === id)
        throw new BadRequestException(
          'An employee cannot supervise themselves',
        );
      await this.assertNoSupervisorCycle(id, dto.supervisorId);
    }

    return this.prisma.employee.update({
      where: { id },
      data: this.toData(dto),
      include: EMPLOYEE_INCLUDE,
    });
  }

  /** Soft-exit. The record stays: payslips reference it and must keep resolving. */
  async terminate(id: string, exitDate?: string) {
    await this.findOne(id);
    return this.prisma.employee.update({
      where: { id },
      data: {
        status: 'TERMINATED',
        exitDate: exitDate ? new Date(exitDate) : new Date(),
      },
      include: EMPLOYEE_INCLUDE,
    });
  }

  /**
   * Everything the People hub renders, in one round of queries.
   *
   * The screen is a dashboard of eight cards; letting it fetch them one
   * endpoint at a time would put eight round trips and eight separate `today`
   * values on the wire, and two cards computed a second apart either side of
   * midnight would disagree about the same month.
   */
  async getPeopleHubSummary(months: number) {
    if (!TREND_MONTH_OPTIONS.includes(months)) {
      throw new BadRequestException(
        `The trend window must be one of ${TREND_MONTH_OPTIONS.join(' or ')} months`,
      );
    }

    const now = new Date();
    const today = startOfUtcDay(now);
    const lookahead = addDays(today, LOOKAHEAD_DAYS);
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const nextMonthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    const windowStart = trendWindowStart(months, now);
    const windowEnd = trendWindowEnd(now);

    const [
      totalWorkforce,
      byStatus,
      startingSoon,
      probationEndingSoon,
      contractTotals,
      expiringContracts,
      terminationCounts,
      hires,
      exits,
    ] = await Promise.all([
      this.prisma.employee.count(),
      this.prisma.employee.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.employee.findMany({
        where: {
          status: EmployeeStatus.ACTIVE,
          hireDate: { gte: today, lte: lookahead },
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          hireDate: true,
          department: { select: { name: true } },
        },
        orderBy: { hireDate: 'asc' },
      }),
      // Live contracts only. A probation date on a contract that has been
      // renewed or terminated is a review nobody has to do.
      this.prisma.contract.findMany({
        where: {
          status: ContractStatus.ACTIVE,
          probationEndDate: { gte: today, lte: lookahead },
        },
        select: {
          id: true,
          probationEndDate: true,
          employee: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { probationEndDate: 'asc' },
      }),
      this.contractTotals(today, lookahead),
      this.prisma.contract.findMany({
        where: {
          status: ContractStatus.ACTIVE,
          endDate: { gte: today, lte: lookahead },
        },
        select: {
          id: true,
          endDate: true,
          employee: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { endDate: 'asc' },
        // The card prints a shortlist; `contracts.expiringSoon` alongside it is
        // the real total, so a long tail is counted without being shipped.
        take: HUB_LIST_LIMIT,
      }),
      this.terminationCounts(monthStart, nextMonthStart),
      this.prisma.employee.findMany({
        where: { hireDate: { gte: windowStart, lt: windowEnd } },
        select: { hireDate: true },
      }),
      this.prisma.employee.findMany({
        where: { exitDate: { gte: windowStart, lt: windowEnd } },
        select: { exitDate: true },
      }),
    ]);

    const counts = new Map(byStatus.map((g) => [g.status, g._count._all]));
    const active = counts.get(EmployeeStatus.ACTIVE) ?? 0;

    const trend = buildWorkforceTrend({
      months,
      hireDates: hires
        .map((row) => row.hireDate)
        .filter((date): date is Date => date !== null),
      exitDates: exits
        .map((row) => row.exitDate)
        .filter((date): date is Date => date !== null),
      currentHeadcount: active,
      now,
    });

    // This month and last month are the final two buckets of the same trend.
    // Counting them separately would be two more queries answering a question
    // the trend has already answered, with its own chance of disagreeing.
    const thisMonth = trend.buckets[trend.buckets.length - 1];
    const previousMonth = trend.buckets[trend.buckets.length - 2];

    const totalLeavers = trend.buckets.reduce((sum, b) => sum + b.leavers, 0);
    const knownHeadcounts = trend.buckets
      .map((b) => b.headcountEnd)
      .filter((value): value is number => value !== null);
    const averageHeadcount = knownHeadcounts.length
      ? knownHeadcounts.reduce((sum, value) => sum + value, 0) /
        knownHeadcounts.length
      : 0;

    return {
      months,
      headcount: {
        active,
        inactive: totalWorkforce - active,
        byStatus: byStatus.map((group) => ({
          status: group.status,
          count: group._count._all,
        })),
      },
      lifecycle: {
        joinersThisMonth: thisMonth.joiners,
        leaversThisMonth: thisMonth.leavers,
        netChangeThisMonth: thisMonth.net,
        previousMonth: {
          joiners: previousMonth.joiners,
          leavers: previousMonth.leavers,
        },
        startingSoon: startingSoon
          .filter(
            (row): row is typeof row & { hireDate: Date } => !!row.hireDate,
          )
          .map((row) => ({
            id: row.id,
            fullName: joinName(row),
            startDate: dateOnly(row.hireDate),
            department: row.department?.name ?? null,
          })),
        probationEndingSoon: probationEndingSoon
          .filter(
            (row): row is typeof row & { probationEndDate: Date } =>
              !!row.probationEndDate,
          )
          .map((row) => ({
            contractId: row.id,
            employeeId: row.employee?.id ?? null,
            fullName: row.employee ? joinName(row.employee) : null,
            endDate: dateOnly(row.probationEndDate),
          })),
      },
      contracts: {
        ...contractTotals,
        expiring: expiringContracts
          .filter((row): row is typeof row & { endDate: Date } => !!row.endDate)
          .map((row) => ({
            id: row.id,
            employeeId: row.employee?.id ?? null,
            fullName: row.employee ? joinName(row.employee) : null,
            endDate: dateOnly(row.endDate),
            daysUntilExpiry: daysUntil(row.endDate, now),
          })),
      },
      terminations: terminationCounts,
      // Mutually exclusive by construction and covering every status, so the
      // slices add up to the workforce whatever the data contains.
      statusSplit: (Object.keys(STATUS_LABELS) as EmployeeStatus[]).map(
        (key) => ({
          key,
          label: STATUS_LABELS[key],
          count: counts.get(key) ?? 0,
        }),
      ),
      trend: {
        months: trend.months,
        buckets: trend.buckets,
        netChange: trend.netChange,
        // Leavers over the average headcount across the window. `null` rather
        // than 0 when there is nothing to divide by: 0% reads as "nobody left",
        // which is a claim an empty window cannot support.
        turnoverRate:
          averageHeadcount > 0
            ? Math.round((totalLeavers / averageHeadcount) * 1000) / 10
            : null,
      },
    };
  }

  private async contractTotals(today: Date, horizon: Date) {
    // Nothing sweeps contract statuses nightly the way legal documents are
    // swept, so a contract whose end date has passed is still marked ACTIVE in
    // the table. The date decides which bucket it lands in here, not the column.
    const [total, active, expired, expiringSoon] =
      await this.prisma.$transaction([
        this.prisma.contract.count(),
        this.prisma.contract.count({
          where: {
            status: ContractStatus.ACTIVE,
            OR: [{ endDate: null }, { endDate: { gte: today } }],
          },
        }),
        this.prisma.contract.count({
          where: {
            OR: [
              { status: ContractStatus.EXPIRED },
              {
                status: ContractStatus.ACTIVE,
                endDate: { lt: today },
              },
            ],
          },
        }),
        this.prisma.contract.count({
          where: {
            status: ContractStatus.ACTIVE,
            endDate: { gte: today, lte: horizon },
          },
        }),
      ]);

    return { total, active, expired, expiringSoon };
  }

  private async terminationCounts(monthStart: Date, nextMonthStart: Date) {
    const [awaitingApproval, thisMonth] = await this.prisma.$transaction([
      this.prisma.terminationRequest.count({
        where: { status: RequestStatus.PENDING },
      }),
      // Requests RAISED this month — how much offboarding work landed on the
      // desk. Who actually left is `lifecycle.leaversThisMonth`, and the two
      // are deliberately different numbers.
      this.prisma.terminationRequest.count({
        where: { createdAt: { gte: monthStart, lt: nextMonthStart } },
      }),
    ]);

    return { awaitingApproval, thisMonth };
  }

  private async assertNationalIdFree(nationalId?: string, exceptId?: string) {
    if (!nationalId) return;
    const clash = await this.prisma.employee.findUnique({
      where: { nationalId },
      select: { id: true },
    });
    // The column is unique, so without this the second record fails deep in
    // Prisma and the caller gets a raw constraint name instead of a sentence.
    if (clash && clash.id !== exceptId) {
      throw new ConflictException(
        `National id ${nationalId} already belongs to another employee`,
      );
    }
  }

  /** Walk up from the proposed manager; meeting `employeeId` means a cycle. */
  private async assertNoReportingCycle(employeeId: string, managerId: string) {
    const seen = new Set<string>();
    let cursor: string | null = managerId;

    while (cursor && !seen.has(cursor)) {
      if (cursor === employeeId) {
        throw new BadRequestException(
          'That manager reports (directly or indirectly) to this employee',
        );
      }
      seen.add(cursor);
      // The explicit annotation breaks the circular inference between `cursor`
      // (narrowed by the loop condition) and the row it is reassigned from.
      const next: { managerId: string | null } | null =
        await this.prisma.employee.findUnique({
          where: { id: cursor },
          select: { managerId: true },
        });
      cursor = next?.managerId ?? null;
    }
  }

  /**
   * The same walk over the supervisor column.
   *
   * It cannot reuse the manager walk: the two columns describe different
   * graphs, and a loop in the supervisor one makes every approval-chain walk
   * non-terminating even while the org chart is perfectly well formed.
   */
  private async assertNoSupervisorCycle(
    employeeId: string,
    supervisorId: string,
  ) {
    const seen = new Set<string>();
    let cursor: string | null = supervisorId;

    while (cursor && !seen.has(cursor)) {
      if (cursor === employeeId) {
        throw new BadRequestException(
          'That supervisor is supervised (directly or indirectly) by this employee',
        );
      }
      seen.add(cursor);
      const next: { supervisorId: string | null } | null =
        await this.prisma.employee.findUnique({
          where: { id: cursor },
          select: { supervisorId: true },
        });
      cursor = next?.supervisorId ?? null;
    }
  }

  /**
   * `hireDate`, `dateOfBirth` and `exitDate` are all date-only columns. Prisma
   * will not take the DTO's ISO string for them, and a string that did get
   * through would be parsed as an instant — putting a birthday on the previous
   * day for anyone west of Greenwich.
   */
  private toData<T extends CreateEmployeeDto | UpdateEmployeeDto>(dto: T) {
    const { hireDate, dateOfBirth, exitDate, ...rest } = dto;
    return {
      ...rest,
      ...(hireDate ? { hireDate: new Date(hireDate) } : {}),
      ...(dateOfBirth ? { dateOfBirth: new Date(dateOfBirth) } : {}),
      ...(exitDate ? { exitDate: new Date(exitDate) } : {}),
    };
  }
}
