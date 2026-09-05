import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateEmployeeProfileDto } from './dto/update-employee-profile.dto';
import type { Principal } from '../auth/auth.service';

/** Roles that may open somebody else's profile. */
const PROFILE_READER_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.HR_MANAGER];

const PROFILE_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  workEmail: true,
  personalEmail: true,
  phone: true,
  position: true,
  status: true,
  hireDate: true,
  exitDate: true,
  dateOfBirth: true,
  gender: true,
  nationality: true,
  nationalId: true,
  address: true,
  timezone: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
  department: { select: { id: true, code: true, name: true } },
  branch: {
    select: { id: true, code: true, name: true, timezone: true, city: true },
  },
  manager: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      avatarUrl: true,
    },
  },
  supervisor: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.EmployeeSelect;

type ProfileRow = Prisma.EmployeeGetPayload<{ select: typeof PROFILE_SELECT }>;

/**
 * What the completion bar counts.
 *
 * Only fields a person can actually do something about. Counting `employeeCode`
 * or `hireDate` — which HR sets and nobody else can touch — would show an
 * employee a bar they are unable to move, and a progress indicator that does
 * not respond to effort is worse than none.
 */
const SELF_MAINTAINED_FIELDS = [
  'phone',
  'personalEmail',
  'address',
  'dateOfBirth',
  'gender',
  'nationality',
] as const;

@Injectable()
export class EmployeeProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Somebody's own record, or an HR role.
   *
   * The same self-or-privileged shape the attendance and payroll services use.
   * It lives in the service rather than on the route because the answer depends
   * on WHOSE profile is being asked for, which `@Roles` cannot see.
   */
  private assertMayTouch(employeeId: string, user: Principal) {
    if (PROFILE_READER_ROLES.includes(user.role)) return;
    if (user.employeeId && user.employeeId === employeeId) return;
    throw new ForbiddenException('You can only view your own profile');
  }

  async findOne(employeeId: string, user: Principal) {
    this.assertMayTouch(employeeId, user);

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: PROFILE_SELECT,
    });
    if (!employee) throw new NotFoundException('Employee not found');

    // The current contract is part of "what am I on", which is the first thing
    // somebody opens their own profile to check. Only the ACTIVE one, and only
    // its terms — the document trail belongs to the contracts screens.
    const contract = await this.prisma.contract.findFirst({
      where: { employeeId, status: ContractStatus.ACTIVE },
      select: {
        id: true,
        contractNumber: true,
        contractType: true,
        workType: true,
        startDate: true,
        endDate: true,
        probationEndDate: true,
        workHoursPerWeek: true,
        noticePeriodDays: true,
        annualLeaveDays: true,
        salary: true,
        currency: true,
        status: true,
      },
      orderBy: { startDate: 'desc' },
    });

    return {
      ...this.withFullName(employee),
      contract,
      ...this.completion(employee),
    };
  }

  async update(
    employeeId: string,
    dto: UpdateEmployeeProfileDto,
    user: Principal,
  ) {
    this.assertMayTouch(employeeId, user);

    const existing = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Employee not found');

    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: {
        ...dto,
        // A date of birth is a DATE, not an instant. Truncating to the day here
        // means the value written is the day the person typed, whatever zone
        // their browser is in.
        ...(dto.dateOfBirth
          ? {
              dateOfBirth: new Date(
                `${dto.dateOfBirth.slice(0, 10)}T00:00:00Z`,
              ),
            }
          : {}),
      },
      select: PROFILE_SELECT,
    });

    return {
      ...this.withFullName(updated),
      ...this.completion(updated),
    };
  }

  /**
   * `fullName` alongside the parts.
   *
   * The column is `firstName`/`lastName`, and every screen that shows a person
   * wants one string. Joined here so a record missing one half still renders
   * something rather than "undefined Al Balushi".
   */
  private withFullName(employee: ProfileRow) {
    const named = <T extends { firstName: string; lastName: string } | null>(
      person: T,
    ) =>
      person
        ? {
            ...person,
            fullName: [person.firstName, person.lastName]
              .filter(Boolean)
              .join(' '),
          }
        : person;

    return {
      ...employee,
      fullName: [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' '),
      manager: named(employee.manager),
      supervisor: named(employee.supervisor),
    };
  }

  /** How much of the self-maintained half of the record has been filled in. */
  private completion(employee: ProfileRow) {
    const missing = SELF_MAINTAINED_FIELDS.filter((field) => {
      const value = employee[field];
      return value === null || value === undefined || value === '';
    });

    const filled = SELF_MAINTAINED_FIELDS.length - missing.length;
    return {
      profileCompletionPercentage: Math.round(
        (filled / SELF_MAINTAINED_FIELDS.length) * 100,
      ),
      // Named rather than counted, so the screen can point at what is missing
      // instead of leaving the reader to hunt for the blank field.
      missingFields: missing,
    };
  }
}
