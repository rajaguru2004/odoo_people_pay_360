import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import {
  CreateFaceEnrollmentDto,
  DESCRIPTOR_LENGTH,
} from './dto/create-face-enrollment.dto';
import { ListFaceEnrollmentsDto } from './dto/list-face-enrollments.dto';

/**
 * Everything about an enrolment EXCEPT the descriptor.
 *
 * The descriptor is biometric material. It is a select-list rather than a
 * delete-after-the-fact because a projection that has to be remembered is one
 * somebody eventually forgets: with this list, adding an endpoint cannot leak
 * it by accident. The screens only need to know that an enrolment exists, how
 * good it is and when it was taken — the template itself is matched against
 * inside the recogniser and never travels.
 */
const ENROLLMENT_SELECT = {
  id: true,
  employeeId: true,
  quality: true,
  imageUrl: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      department: { select: { id: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
  },
} satisfies Prisma.FaceEnrollmentSelect;

@Injectable()
export class FaceEnrollmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListFaceEnrollmentsDto) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.FaceEnrollmentWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.activeOnly === false ? {} : { isActive: true }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.faceEnrollment.findMany({
        where,
        select: ENROLLMENT_SELECT,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.faceEnrollment.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  async findByEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    return this.prisma.faceEnrollment.findMany({
      where: { employeeId },
      select: ENROLLMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateFaceEnrollmentDto) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    // The DTO already enforces the width and finiteness; this guards the one
    // case class-validator's `each` cannot see — a value that survived
    // transformation as something other than a number.
    if (
      dto.descriptor.length !== DESCRIPTOR_LENGTH ||
      dto.descriptor.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    ) {
      throw new BadRequestException(
        `descriptor must be exactly ${DESCRIPTOR_LENGTH} finite numbers`,
      );
    }

    return this.prisma.faceEnrollment.create({
      data: {
        employeeId: dto.employeeId,
        descriptor: dto.descriptor,
        quality: dto.quality,
        imageUrl: dto.imageUrl ?? null,
      },
      select: ENROLLMENT_SELECT,
    });
  }

  async remove(id: string) {
    const enrollment = await this.prisma.faceEnrollment.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!enrollment) throw new NotFoundException('Face enrolment not found');

    // A hard delete, not a deactivation. Nothing downstream references an
    // enrolment the way a payslip references an employee, and biometric
    // material that is no longer wanted should stop existing.
    await this.prisma.faceEnrollment.delete({ where: { id } });
    return { deleted: true };
  }
}
