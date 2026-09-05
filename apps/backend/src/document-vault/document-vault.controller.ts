import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DocumentVaultService } from './document-vault.service';

@ApiTags('Document Vault')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('document-vault')
export class DocumentVaultController {
  constructor(private readonly vault: DocumentVaultService) {}

  @Get('me')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Everything the current user holds: uploads, generated letters, visa records, contracts, payslips and training certificates',
  })
  mine(@CurrentUser() user: any) {
    if (!user?.employeeId) {
      return { success: true, data: { items: [], summary: { total: 0, byKind: {}, expiringSoon: 0, expired: 0 } } };
    }
    return this.vault.forEmployee(user.employeeId, user);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary:
      "An employee's vault. HR only — a line manager has no business reading salary certificates or passport scans.",
  })
  forEmployee(
    @CurrentUser() user: any,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.vault.forEmployee(employeeId, user);
  }
}
