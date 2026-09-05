import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import type { RequestMeta } from '../common/utils/request-meta.util';

/** What a controller sees on `req.user`. */
export interface Principal {
  id: string;
  email: string;
  role: UserRole;
  employeeId: string | null;
  departmentId: string | null;
  branchId: string | null;
}

/** Cost 12. Deliberately slow — that slowness is the whole defence. */
const BCRYPT_ROUNDS = 12;

/** Selected once, so a password hash can never reach a response by accident. */
const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  employeeId: true,
  lastLoginAt: true,
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      avatarUrl: true,
      timezone: true,
      branchId: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
  },
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto, meta: RequestMeta = {}) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // One message for "no such account" and for "wrong password", and the hash
    // comparison runs either way. Both matter: a different message turns this
    // endpoint into an account-enumeration oracle, and skipping bcrypt on the
    // missing-user path leaks the same thing through response timing.
    const hash = user?.passwordHash ?? (await this.dummyHash());
    const ok = await bcrypt.compare(dto.password, hash);
    if (!user || !ok) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('This account has been deactivated');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'LOGIN',
        entityType: 'User',
        entityId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });

    const full = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: USER_PUBLIC_SELECT,
    });

    return {
      accessToken: await this.signToken(user.id, user.role),
      user: full,
    };
  }

  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();

    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('An account with this email already exists');
    }
    if (dto.employeeId) {
      const linked = await this.prisma.user.findUnique({
        where: { employeeId: dto.employeeId },
      });
      if (linked)
        throw new ConflictException('That employee already has a login');
    }

    return this.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        role: dto.role,
        employeeId: dto.employeeId ?? null,
      },
      select: USER_PUBLIC_SELECT,
    });
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_PUBLIC_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (!(await bcrypt.compare(dto.oldPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (dto.oldPassword === dto.newPassword) {
      throw new BadRequestException(
        'The new password must differ from the current one',
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS) },
    });

    return { changed: true };
  }

  /**
   * Build the request principal from a token's subject.
   *
   * Lives here rather than in JwtStrategy so any non-HTTP entry point added
   * later (a queue consumer, a chat integration) resolves an IDENTICAL
   * `req.user`. A caller must not get wider scope because it arrived over a
   * different transport.
   */
  async buildPrincipal(userId: string): Promise<Principal> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        employeeId: true,
        employee: { select: { departmentId: true, branchId: true } },
      },
    });

    // Re-checked on EVERY request, not just at login: a token stays valid for
    // its full lifetime, so deactivating an account has to take effect here or
    // it does not take effect at all until the token expires.
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account is no longer active');
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      employeeId: user.employeeId,
      departmentId: user.employee?.departmentId ?? null,
      branchId: user.employee?.branchId ?? null,
    };
  }

  private signToken(sub: string, role: UserRole) {
    return this.jwt.signAsync({ sub, role });
  }

  /**
   * A throwaway hash to compare against when the account does not exist, so the
   * unknown-email path costs the same wall time as the wrong-password one.
   * Computed lazily and cached for the process lifetime.
   */
  private dummyHashCache: string | null = null;
  private async dummyHash(): Promise<string> {
    this.dummyHashCache ??= await bcrypt.hash(
      'invalid-account-placeholder',
      BCRYPT_ROUNDS,
    );
    return this.dummyHashCache;
  }
}
