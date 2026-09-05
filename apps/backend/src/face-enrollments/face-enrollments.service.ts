import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import {
  CreateFaceEnrollmentDto,
  DESCRIPTOR_LENGTH,
} from './dto/create-face-enrollment.dto';
import { ListFaceEnrollmentsDto } from './dto/list-face-enrollments.dto';
import { VerifyFaceDto } from './dto/verify-face.dto';
import { DEFAULT_MATCH_THRESHOLD, bestMatch } from './face-match.util';

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

/** The setting an administrator moves when matching is too strict or too loose. */
const MATCH_THRESHOLD_KEY = 'face_recognition_match_threshold';

@Injectable()
export class FaceEnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

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

  /**
   * Is this person enrolled, and how well?
   *
   * The self-service counterpart to `findByEmployee`, for the screen an
   * employee opens before a biometric punch. It answers with counts and dates
   * only — nothing here identifies a template well enough to reconstruct one.
   */
  async statusFor(employeeId: string | null) {
    // A user with no employee record — the shape a system administrator has —
    // is not enrolled rather than a failed query.
    if (!employeeId) {
      return {
        employeeId: null,
        isRegistered: false,
        totalRegistered: 0,
        bestQuality: null,
        lastEnrolledAt: null,
        threshold: await this.matchThreshold(),
      };
    }

    const rows = await this.prisma.faceEnrollment.findMany({
      where: { employeeId, isActive: true },
      select: { quality: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      employeeId,
      isRegistered: rows.length > 0,
      totalRegistered: rows.length,
      bestQuality: rows.length
        ? Math.max(...rows.map((row) => row.quality))
        : null,
      lastEnrolledAt: rows[0]?.createdAt ?? null,
      threshold: await this.matchThreshold(),
    };
  }

  /**
   * Match a probe against the enrolled templates.
   *
   * The probe arrives already computed — the recogniser runs on the terminal,
   * because a template built by a different model than the one that enrolled it
   * matches nobody. The comparison happens here rather than in the browser for
   * the reason the whole module exists: the stored templates would have to be
   * downloaded to compare them there, and biometric material that has been sent
   * to a browser is biometric material that has left the building.
   *
   * The response says who was matched and how confident the match was. On a
   * FAILURE it deliberately does not name the closest candidate: "you are 41%
   * like Fatma Al Rashdi" is a fact about Fatma that the person at the terminal
   * is not entitled to.
   */
  async verify(dto: VerifyFaceDto) {
    const threshold = await this.matchThreshold();

    if (dto.employeeId) {
      const employee = await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: { id: true },
      });
      if (!employee) throw new NotFoundException('Employee not found');
    }

    const candidates = await this.prisma.faceEnrollment.findMany({
      where: {
        isActive: true,
        ...(dto.employeeId ? { employeeId: dto.employeeId } : {}),
      },
      select: {
        employeeId: true,
        descriptor: true,
        quality: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            status: true,
          },
        },
      },
    });

    const outcome = bestMatch(dto.descriptor, candidates, threshold);

    if (!outcome.matched || !outcome.closest) {
      return {
        matched: false,
        threshold,
        // How many templates were even considered. Zero is a different problem
        // from "none of them was close enough", and without this the terminal
        // cannot tell the two apart.
        candidates: candidates.length,
        employee: null,
        confidence: null,
        distance: null,
      };
    }

    const { employee } = outcome.closest;
    return {
      matched: true,
      threshold,
      candidates: candidates.length,
      confidence: outcome.confidence,
      distance: outcome.distance,
      employeeId: employee.id,
      employee: {
        ...employee,
        fullName: [employee.firstName, employee.lastName]
          .filter(Boolean)
          .join(' '),
      },
    };
  }

  /** The configured threshold, falling back to the recogniser's calibration. */
  private matchThreshold(): Promise<number> {
    return this.settings.getNumber(
      MATCH_THRESHOLD_KEY,
      DEFAULT_MATCH_THRESHOLD,
    );
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
