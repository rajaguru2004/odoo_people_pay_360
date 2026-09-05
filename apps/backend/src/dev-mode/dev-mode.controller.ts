import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { DEV_MODE_AUDIT } from './dev-mode.constants';
import { DevModeService } from './dev-mode.service';
import { ElevateDto } from './dto/elevate.dto';

/**
 * Step-up elevation for developer-only settings.
 *
 * Note there is no `@AuditResource` on this controller: the generic interceptor
 * cannot tell a successful elevation from a failed one, and that distinction is
 * the whole point of auditing this surface. Every action here logs explicitly.
 */
@ApiTags('dev-mode')
@ApiBearerAuth('JWT-auth')
@Controller('dev-mode')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class DevModeController {
  constructor(
    private readonly devMode: DevModeService,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Whether developer mode is configured, and the current elevation' })
  status(@Req() req: any) {
    const elevation = this.devMode.elevationFor(req);
    return {
      success: true,
      data: {
        available: this.devMode.isAvailable(),
        enforced: this.devMode.isEnforced(),
        elevated: elevation !== null,
        expiresAt: elevation?.expiresAt ?? null,
        ttlMinutes: this.devMode.ttlMinutes(),
      },
    };
  }

  @Post('elevate')
  @ApiOperation({ summary: 'Exchange the developer password for a short-lived elevation token' })
  async elevate(@Body() dto: ElevateDto, @Req() req: any) {
    const ok = this.devMode.isAvailable() && (await this.devMode.verifyPassword(dto.password));

    if (!ok) {
      await this.audit.log({
        userId: req.user?.id,
        action: DEV_MODE_AUDIT.ELEVATE_FAILURE,
        resourceType: DEV_MODE_AUDIT.RESOURCE,
        ipAddress: ipOf(req),
        userAgent: req.headers?.['user-agent'],
        branchId: req.branchContext?.effectiveBranchId ?? null,
      });
      // Same message whether the hash is unset or the password is wrong — a
      // probing admin should not be able to tell that developer mode exists.
      throw new UnauthorizedException('Invalid credentials');
    }

    const result = this.devMode.elevate(req.user.id);

    await this.audit.log({
      userId: req.user.id,
      action: DEV_MODE_AUDIT.ELEVATE_SUCCESS,
      resourceType: DEV_MODE_AUDIT.RESOURCE,
      newData: { expiresAt: result.expiresAt },
      ipAddress: ipOf(req),
      userAgent: req.headers?.['user-agent'],
      branchId: req.branchContext?.effectiveBranchId ?? null,
    });

    return { success: true, data: result };
  }

  @Post('revoke')
  @ApiOperation({ summary: 'Drop the caller’s developer elevation' })
  async revoke(@Req() req: any) {
    const dropped = this.devMode.revokeAllForUser(req.user.id);

    if (dropped > 0) {
      await this.audit.log({
        userId: req.user.id,
        action: DEV_MODE_AUDIT.REVOKE,
        resourceType: DEV_MODE_AUDIT.RESOURCE,
        ipAddress: ipOf(req),
        userAgent: req.headers?.['user-agent'],
        branchId: req.branchContext?.effectiveBranchId ?? null,
      });
    }

    return { success: true, data: { revoked: dropped } };
  }
}

/** Mirrors the normalisation in AuditInterceptor so both sources agree. */
function ipOf(req: any): string | undefined {
  const raw =
    (req.headers?.['x-forwarded-for'] as string)?.split(',')[0].trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    undefined;
  if (!raw) return undefined;
  if (raw === '::1') return '127.0.0.1';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}
