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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { LettersService } from './letters.service';
import { RejectLetterDto } from './dto/reject-letter.dto';
import { RequestLetterDto } from './dto/request-letter.dto';
import { UpsertLetterTemplateDto } from './dto/upsert-letter-template.dto';

@ApiTags('Letters')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('letters')
@AuditResource('LetterRequest')
export class LettersController {
  constructor(private readonly letters: LettersService) {}

  @Get('stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Letter queue summary' })
  stats() {
    return this.letters.stats();
  }

  @Get('templates')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Available letter templates' })
  listTemplates(@Query('activeOnly') activeOnly?: string) {
    return this.letters.listTemplates(activeOnly === 'true');
  }

  @Put('templates')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create or update a letter template (admin-editable wording)' })
  upsertTemplate(@CurrentUser() user: any, @Body() dto: UpsertLetterTemplateDto) {
    return this.letters.upsertTemplate(dto, user.id);
  }

  @Get('my-requests')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: "The current user's own letter requests" })
  myRequests(@CurrentUser() user: any) {
    if (!user?.employeeId) return { success: true, data: [] };
    return this.letters.findByEmployee(user.employeeId);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'All letter requests' })
  findAll(@Query('status') status?: string) {
    return this.letters.findAll({ status });
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Request a letter. Templates flagged requiresApproval:false issue immediately; anything stating pay waits for HR.',
  })
  request(
    @CurrentUser() user: any,
    @Body() dto: RequestLetterDto,
    @Query('employeeId') employeeIdOverride?: string,
  ) {
    const employeeId =
      employeeIdOverride && ['ADMIN', 'HR_MANAGER'].includes(user?.role)
        ? employeeIdOverride
        : user.employeeId;
    return this.letters.request(employeeId, dto, user);
  }

  @Post(':id/issue')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary:
      'Render, serial-number and store the letter privately, and file it in the employee document vault',
  })
  issue(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.letters.issue(id, user);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary:
      'Reject a letter request. The reason is required and is sent to the employee verbatim.',
  })
  reject(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLetterDto,
  ) {
    // A whole DTO rather than `@Body('reason')`: the global ValidationPipe only
    // runs when the parameter's metatype is a class, so the primitive binding
    // this replaces was unvalidated by construction.
    return this.letters.reject(id, dto.reason, user);
  }
}

/**
 * Verification is deliberately unauthenticated — a bank checking a certificate
 * has no account here. It returns only whether the serial was issued and when;
 * never the name, the salary, or the document itself.
 */
@ApiTags('Letters')
@Controller('letters')
export class LetterVerificationController {
  constructor(private readonly letters: LettersService) {}

  @Public()
  @Get('verify/:serial')
  @ApiOperation({ summary: 'Confirm a letter serial was issued (no content disclosed)' })
  verify(@Param('serial') serial: string) {
    return this.letters.verify(serial);
  }
}
