import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Audit Logs')
@ApiBearerAuth('JWT-auth')
@Controller('audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AuditLogsController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Get all audit logs (Admin only)' })
  async findAll(@Query() query: QueryAuditLogsDto) {
    return this.auditService.findAll(query);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Activity in the last N hours (Admin only)',
    description: 'Aggregated in the database, so the figures are not capped by a page size.',
  })
  async stats(@Query('hours') hours?: string) {
    const parsed = Number(hours);
    return this.auditService.stats(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 720) : 24);
  }

  @Get('resources')
  @ApiOperation({ summary: 'Get list of active resource types logged (Admin only)' })
  async getResources() {
    const resources = await this.auditService.getResourceTypes();
    return {
      success: true,
      data: resources,
    };
  }
}
