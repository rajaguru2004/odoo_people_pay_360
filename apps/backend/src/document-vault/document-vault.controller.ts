import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { DocumentVaultService } from './document-vault.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

const EMPTY_VAULT = {
  items: [],
  summary: { total: 0, byKind: {}, expiringSoon: 0, expired: 0 },
};

@ApiTags('Document Vault')
@ApiBearerAuth('JWT-auth')
@Controller('document-vault')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DocumentVaultController {
  constructor(private readonly vault: DocumentVaultService) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Everything the caller holds: uploads, issued letters, visa records, contracts, payslips and training certificates',
  })
  mine(@CurrentUser() user: Principal) {
    // A user account need not be attached to an employee record. An empty vault
    // rather than an exception: the route is one their own role grants them.
    if (!user?.employeeId) return EMPTY_VAULT;
    return this.vault.forEmployee(user.employeeId, user);
  }

  @Get('employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: "One employee's vault",
    description:
      'HR only — a line manager has no business reading salary certificates or passport scans.',
  })
  forEmployee(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.vault.forEmployee(employeeId, user);
  }
}
