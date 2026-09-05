import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { LettersService } from './letters.service';
import { RequestLetterDto } from './dto/request-letter.dto';
import { RejectLetterDto } from './dto/reject-letter.dto';
import { UpsertLetterTemplateDto } from './dto/upsert-letter-template.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

const HR_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.HR_MANAGER];

@ApiTags('Letters')
@ApiBearerAuth('JWT-auth')
@Controller('letters')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LettersController {
  constructor(private readonly letters: LettersService) {}

  @Get('stats')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'The letter desk in four numbers' })
  stats() {
    return this.letters.stats();
  }

  @Get('templates')
  @ApiOperation({ summary: 'The letters that can be requested' })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  listTemplates(@Query('activeOnly') activeOnly?: string) {
    return this.letters.listTemplates(activeOnly === 'true');
  }

  @Put('templates')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create or reword a letter template' })
  upsertTemplate(
    @CurrentUser() user: Principal,
    @Body() dto: UpsertLetterTemplateDto,
  ) {
    return this.letters.upsertTemplate(dto, user.id);
  }

  @Get('my-requests')
  @ApiOperation({ summary: "The caller's own letter requests" })
  myRequests(@CurrentUser() user: Principal) {
    if (!user?.employeeId) return [];
    return this.letters.findByEmployee(user.employeeId);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'The whole letter queue' })
  @ApiQuery({ name: 'status', required: false })
  findAll(@Query('status') status?: string) {
    return this.letters.findAll({ status });
  }

  @Post()
  @ApiOperation({
    summary: 'Request a letter',
    description:
      'A template flagged requiresApproval:false issues immediately; anything stating pay waits for HR.',
  })
  @ApiQuery({
    name: 'employeeId',
    required: false,
    description: 'HR requesting on somebody else’s behalf',
  })
  request(
    @CurrentUser() user: Principal,
    @Body() dto: RequestLetterDto,
    @Query('employeeId') employeeIdOverride?: string,
  ) {
    const employeeId =
      employeeIdOverride && HR_ROLES.includes(user?.role)
        ? employeeIdOverride
        : user?.employeeId;
    return this.letters.request(employeeId, dto, user);
  }

  @Post(':id/issue')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Render, number and file the letter in the employee’s vault',
  })
  issue(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.letters.issue(id, user);
  }

  @Post(':id/reject')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Refuse a request. The reason reaches the employee verbatim.',
  })
  reject(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLetterDto,
  ) {
    return this.letters.reject(id, dto.reason, user);
  }
}

/**
 * Verification is unauthenticated on purpose — a bank checking a certificate
 * has no account here. It answers only whether the serial was issued and when;
 * never the name, the salary, or the document itself.
 */
@ApiTags('Letters')
@Controller('letters')
export class LetterVerificationController {
  constructor(private readonly letters: LettersService) {}

  @Public()
  @Get('verify/:serial')
  @ApiOperation({ summary: 'Confirm a letter serial was issued' })
  verify(@Param('serial') serial: string) {
    return this.letters.verify(serial);
  }
}
