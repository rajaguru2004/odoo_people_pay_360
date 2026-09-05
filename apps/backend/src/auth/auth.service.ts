import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
    private configService: ConfigService,
  ) {}

  /**
   * Build the authenticated principal for a user id.
   *
   * This is what `req.user` is, and it was previously inlined in
   * JwtStrategy.validate — which made it unreachable from any non-HTTP entry
   * point. Every non-HTTP entry point needs exactly the same object (a tool
   * call must not have weaker scope because it arrived over a different
   * transport), so the query lives here and the strategy delegates.
   *
   * Everything scope-related is derived from the DB on every call and never
   * trusted from a token: revoking a branch grant or a department takes effect
   * immediately, on every channel.
   */
  async buildPrincipal(userId: string, departmentIdFallback?: string | null) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        employeeId: true,
        isActive: true,
        isGlobalBranchAccess: true,
        branchAccess: { select: { branchId: true } },
        employee: {
          select: {
            branchId: true,
            departmentId: true,
            // Every active department this employee heads. Drives multi-department
            // manager authority (a manager may head more than one department).
            managedDepartments: {
              where: { isActive: true },
              select: { id: true },
            },
            // Every active employee this person supervises. Drives supervisor
            // approval authority — a data-driven assignment, NOT an RBAC role.
            supervisees: {
              where: { status: 'ACTIVE' },
              select: { id: true },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }

    const homeBranchId = user.employee?.branchId ?? null;
    const accessibleBranchIds: string[] | 'ALL' = user.isGlobalBranchAccess
      ? 'ALL'
      : Array.from(
          new Set([
            ...user.branchAccess.map((b) => b.branchId),
            ...(homeBranchId ? [homeBranchId] : []),
          ]),
        );

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      employeeId: user.employeeId,
      isActive: user.isActive,
      // Prefer the fresh DB departmentId; fall back to the token for old tokens.
      departmentId: user.employee?.departmentId ?? departmentIdFallback ?? null,
      managedDepartmentIds: user.employee?.managedDepartments.map((d) => d.id) ?? [],
      supervisedEmployeeIds: user.employee?.supervisees.map((s) => s.id) ?? [],
      homeBranchId,
      accessibleBranchIds,
      isGlobalBranchAccess: user.isGlobalBranchAccess,
    };
  }

  async register(dto: RegisterDto) {
    // Check if email exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    // Check if employeeId exists and not linked
    if (dto.employeeId) {
      const employee = await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        include: { user: true },
      });

      if (!employee) {
        throw new BadRequestException('Employee not found');
      }

      if (employee.user) {
        throw new ConflictException('Employee already has an account');
      }
    }

    // Hash password
    const passwordHash = await this.hashPassword(dto.password);

    // Create user
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        role: dto.role,
        employeeId: dto.employeeId,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
            gender: true,
            department: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
      },
    });

    // Send verification email (don't wait for it)
    this.sendVerificationEmail(user.id).catch((err) => {
      console.error('Failed to send verification email:', err);
    });

    const token = this.generateToken(user);

    return {
      success: true,
      message:
        'User registered successfully. Please check your email to verify your account.',
      data: {
        user: this.sanitizeUser(user),
        accessToken: token,
      },
    };
  }

  async login(dto: LoginDto) {
    // Find user
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: {
        branchAccess: {
          select: { branch: { select: { id: true, code: true, name: true } } },
        },
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
            gender: true,
            timezone: true,
            dateFormat: true,
            branchId: true,
            branch: { select: { id: true, code: true, name: true } },
            department: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Email does not exist in the system');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account has been disabled');
    }

    // Verify password
    const isPasswordValid = await this.comparePassword(
      dto.password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Incorrect password');
    }

    const token = this.generateToken(user);

    return {
      success: true,
      message: 'Login successful',
      data: {
        user: this.sanitizeUser(user),
        accessToken: token,
      },
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Verify old password
    const isOldPasswordValid = await this.comparePassword(
      dto.oldPassword,
      user.passwordHash,
    );

    if (!isOldPasswordValid) {
      throw new BadRequestException('Old password is incorrect');
    }

    // Hash new password
    const newPasswordHash = await this.hashPassword(dto.newPassword);

    // Update password
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });

    return {
      success: true,
      message: 'Password changed successfully',
    };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        branchAccess: {
          select: { branch: { select: { id: true, code: true, name: true } } },
        },
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
            gender: true,
            timezone: true,
            dateFormat: true,
            branchId: true,
            branch: { select: { id: true, code: true, name: true } },
            department: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      success: true,
      data: this.sanitizeUser(user),
    };
  }

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.isActive) {
      return null;
    }

    const isPasswordValid = await this.comparePassword(
      password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }

  private async comparePassword(
    plainPassword: string,
    hashedPassword: string,
  ): Promise<boolean> {
    return bcrypt.compare(plainPassword, hashedPassword);
  }

  private generateToken(user: any): string {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      employeeId: user.employeeId,
      // departmentId from linked employee record (null for users without employee)
      departmentId: user.employee?.departmentId ?? null,
    };

    return this.jwtService.sign(payload);
  }

  private sanitizeUser(user: any) {
    const { passwordHash, branchAccess, ...sanitized } = user;

    // Fold the branch envelope into a clean shape for the frontend picker.
    const branches = new Map<string, { id: string; code: string; name: string }>();
    const homeBranch = user.employee?.branch;
    if (homeBranch) branches.set(homeBranch.id, homeBranch);
    for (const grant of branchAccess ?? []) {
      if (grant.branch) branches.set(grant.branch.id, grant.branch);
    }

    return {
      ...sanitized,
      isGlobalBranchAccess: !!user.isGlobalBranchAccess,
      homeBranchId: user.employee?.branchId ?? null,
      // Surface the employee's personal display timezone at the top level so the
      // frontend's getDisplayTZ (user.timezone → company) resolves without
      // digging into the nested employee object. null = inherit company TZ.
      timezone: user.employee?.timezone ?? null,
      // Personal date-display format preference (null = app default).
      dateFormat: user.employee?.dateFormat ?? null,
      accessibleBranches: Array.from(branches.values()),
    };
  }

  // =====================================================
  // EMAIL VERIFICATION METHODS
  // =====================================================

  async sendVerificationEmail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('User does not exist');
    }

    if (user.isEmailVerified) {
      throw new BadRequestException('Email has already been verified');
    }

    // Generate verification token (JWT with 24h expiration)
    const verificationToken = this.jwtService.sign(
      { sub: user.id, email: user.email, type: 'email-verification' },
      { expiresIn: '24h' },
    );

    // Save token to database
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerificationToken: verificationToken },
    });

    // Send verification email
    const frontendUrl =
      this.configService.get('FRONTEND_URL') || 'http://localhost:3000';
    const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}`;

    await this.mailService.sendMail({
      to: user.email,
      subject: 'Email Verification - Ess Portal',
      template: 'email-verification',
      context: {
        email: user.email,
        verificationUrl,
      },
    });

    return {
      success: true,
      message: 'Verification email has been sent',
    };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    try {
      // Verify JWT token
      const payload = this.jwtService.verify(dto.token);

      if (payload.type !== 'email-verification') {
        throw new BadRequestException('Invalid token');
      }

      // Find user with this token
      const user = await this.prisma.user.findFirst({
        where: {
          id: payload.sub,
          emailVerificationToken: dto.token,
        },
      });

      if (!user) {
        throw new BadRequestException('Invalid or expired token');
      }

      if (user.isEmailVerified) {
        throw new BadRequestException('Email has already been verified');
      }

      // Update user
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
          emailVerificationToken: null, // Clear token after verification
        },
      });

      // Send success email
      const frontendUrl =
        this.configService.get('FRONTEND_URL') || 'http://localhost:3000';
      const loginUrl = `${frontendUrl}/login`;

      await this.mailService.sendMail({
        to: user.email,
        subject: 'Email Verified - Ess Portal',
        template: 'email-verified-success',
        context: {
          email: user.email,
          loginUrl,
        },
      });

      return {
        success: true,
        message: 'Email verified successfully',
      };
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new BadRequestException(
          'Token expired. Please request a new verification email',
        );
      }
      if (error.name === 'JsonWebTokenError') {
        throw new BadRequestException('Invalid token');
      }
      throw error;
    }
  }

  async resendVerificationEmail(dto: ResendVerificationDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new BadRequestException('Email does not exist in the system');
    }

    if (user.isEmailVerified) {
      throw new BadRequestException('Email has already been verified');
    }

    // Send verification email
    await this.sendVerificationEmail(user.id);

    return {
      success: true,
      message: 'Verification email has been resent',
    };
  }
}
