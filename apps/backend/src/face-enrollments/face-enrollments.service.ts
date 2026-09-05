import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import {
  CreateFaceEnrollmentDto,
  DESCRIPTOR_LENGTH,
} from './dto/create-face-enrollment.dto';
import { ListFaceEnrollmentsDto } from './dto/list-face-enrollments.dto';
import { VerifyFaceDto } from './dto/verify-face.dto';
import { RegisterFaceDto } from './dto/register-face.dto';
import {
  DEFAULT_MATCH_THRESHOLD,
  bestMatch,
  euclideanDistance,
} from './face-match.util';
import { FaceDescriptorService } from './face-descriptor.service';
import { deleteFaceImage, saveFaceImage } from './face-image.store';
import type { Principal } from '../auth/auth.service';

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

/** The floor a capture has to clear to be worth enrolling at all. */
const MIN_QUALITY_KEY = 'face_recognition_min_quality';
const DEFAULT_MIN_QUALITY = 0.6;

/** How many templates one person may hold. */
const MAX_TEMPLATES_KEY = 'face_recognition_max_descriptors';
const DEFAULT_MAX_TEMPLATES = 5;

/** The angles the guided capture walks through, and the count a punch needs. */
export const REQUIRED_TEMPLATES = 3;

/**
 * Below this distance two captures are the same photograph in all but name.
 *
 * Enrolling both spends one of the five slots on nothing: matching already
 * succeeds for that pose, and the poses it fails on are still missing. The
 * guided flow asks for a turned head at step two precisely to clear this.
 */
const DUPLICATE_DISTANCE = 0.3;

/** What the gallery draws. No descriptor, by construction. */
const GALLERY_SELECT = {
  id: true,
  employeeId: true,
  imageUrl: true,
  quality: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.FaceEnrollmentSelect;

@Injectable()
export class FaceEnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly recogniser: FaceDescriptorService,
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

  /**
   * Enrol from a photograph.
   *
   * The counterpart to {@link create}, and the one the screens use. `create`
   * takes a template from a terminal that computed its own; this takes the
   * frame a browser captured and computes the template here, because the portal
   * has no recogniser and a template it fabricated would match nobody.
   *
   * The photo is turned into a template, checked against what the person
   * already holds, and only then written. A copy is kept for the gallery; the
   * frame itself is not otherwise retained.
   */
  async register(dto: RegisterFaceDto, user: Principal) {
    const employeeId = dto.employeeId ?? user.employeeId;
    if (!employeeId) {
      throw new BadRequestException(
        'This account has no employee record, so there is nobody to enrol.',
      );
    }

    // Enrolling somebody else is an HR act. An employee may only ever add a
    // template to their own record, whatever id they put in the body.
    if (
      employeeId !== user.employeeId &&
      user.role !== UserRole.ADMIN &&
      user.role !== UserRole.HR_MANAGER
    ) {
      throw new ForbiddenException('You may only enrol your own face.');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, firstName: true, lastName: true, employeeCode: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const [minQuality, maxTemplates] = await Promise.all([
      this.settings.getNumber(MIN_QUALITY_KEY, DEFAULT_MIN_QUALITY),
      this.settings.getNumber(MAX_TEMPLATES_KEY, DEFAULT_MAX_TEMPLATES),
    ]);

    const existing = await this.prisma.faceEnrollment.findMany({
      where: { employeeId },
      select: { descriptor: true },
    });

    if (existing.length >= maxTemplates) {
      throw new BadRequestException(
        `That is the limit of ${maxTemplates} templates. Delete one before adding another.`,
      );
    }

    const { descriptor, quality } = await this.recogniser.extract(
      dto.image,
      minQuality,
    );

    const duplicate = existing.some(
      (row) =>
        euclideanDistance(descriptor, row.descriptor) < DUPLICATE_DISTANCE,
    );
    if (duplicate) {
      throw new BadRequestException(
        'That is too close to a capture already on file. Take the next one from a different angle.',
      );
    }

    const imageUrl = await saveFaceImage(employeeId, dto.image, Date.now());

    const saved = await this.prisma.faceEnrollment.create({
      data: { employeeId, descriptor, quality, imageUrl },
      select: GALLERY_SELECT,
    });

    const totalRegistered = existing.length + 1;
    return {
      ...saved,
      totalRegistered,
      maxAllowed: maxTemplates,
      required: REQUIRED_TEMPLATES,
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        fullName: [employee.firstName, employee.lastName]
          .filter(Boolean)
          .join(' '),
      },
    };
  }

  /**
   * The signed-in employee's own gallery.
   *
   * The self-service counterpart to `findByEmployee`, which is HR-only because
   * it answers about anybody. This one can only ever answer about the caller.
   */
  async mine(employeeId: string | null) {
    if (!employeeId) return [];
    return this.prisma.faceEnrollment.findMany({
      where: { employeeId },
      select: GALLERY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * How many templates each employee holds.
   *
   * Counted in the database and returned whole, so the enrolment table can say
   * "3/5" on every row without asking per employee — and without the count
   * being the length of whatever page happened to load.
   */
  async countsByEmployee() {
    const groups = await this.prisma.faceEnrollment.groupBy({
      by: ['employeeId'],
      _count: { _all: true },
    });
    const [maxAllowed] = await Promise.all([
      this.settings.getNumber(MAX_TEMPLATES_KEY, DEFAULT_MAX_TEMPLATES),
    ]);
    return {
      maxAllowed,
      required: REQUIRED_TEMPLATES,
      counts: groups.map((group) => ({
        employeeId: group.employeeId,
        count: group._count._all,
      })),
    };
  }

  /**
   * Delete a template, as the person it belongs to or as HR.
   *
   * An employee managing their own gallery is the point of the self-service
   * screen, so this is not `@Roles`-gated — but the ownership check is here
   * rather than on the decorator, because whether a caller may delete this row
   * depends on whose row it is and a decorator cannot see that.
   */
  async removeFor(id: string, user: Principal) {
    const enrollment = await this.prisma.faceEnrollment.findUnique({
      where: { id },
      select: { id: true, employeeId: true, imageUrl: true },
    });
    if (!enrollment) throw new NotFoundException('Face enrolment not found');

    const isHr =
      user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER;
    if (!isHr && enrollment.employeeId !== user.employeeId) {
      throw new ForbiddenException('You may only delete your own templates.');
    }

    // A hard delete, not a deactivation. Nothing downstream references an
    // enrolment the way a payslip references an employee, and biometric
    // material that is no longer wanted should stop existing.
    await this.prisma.faceEnrollment.delete({ where: { id } });
    // After the row, never before: an orphaned row pointing at a missing photo
    // renders a broken gallery, while an orphaned file is only bytes.
    await deleteFaceImage(enrollment.imageUrl);
    return { deleted: true };
  }

  /** The configured threshold, falling back to the recogniser's calibration. */
  private matchThreshold(): Promise<number> {
    return this.settings.getNumber(
      MATCH_THRESHOLD_KEY,
      DEFAULT_MATCH_THRESHOLD,
    );
  }
}
