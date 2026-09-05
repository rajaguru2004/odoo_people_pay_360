import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { AllowReadOnly, LoanReadOnlyGuard } from './loan-readonly.guard';
import { LoanPoliciesService } from './loan-policies.service';
import { UpsertLoanPolicyDto } from './dto/loan-policy.dto';

/**
 * Per-branch loan policy.
 *
 * `prisma.loanPolicy` was only ever `findMany`'d inside
 * `LoanPolicyService.resolve()`: the branch level of the resolution chain —
 * `LoanPolicy(branchId)` → `LoanPolicy(null)` → `SystemSetting` → default —
 * existed in code and was unreachable without direct database access.
 *
 * `GET /loan-policies/effective` is the useful read: it answers what a branch's
 * policy actually RESOLVES to, chain and all, rather than what one row happens
 * to contain. A screen that showed only the row would show mostly nulls and
 * explain nothing.
 */
@ApiTags('Salary Advances & Loans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, LoanReadOnlyGuard)
@Controller('loan-policies')
@AuditResource('LoanPolicy')
export class LoanPoliciesController {
  constructor(private readonly service: LoanPoliciesService) {}

  @Get()
  @AllowReadOnly()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Every stored policy row, global first' })
  findAll() {
    return this.service.findAll();
  }

  @Get('effective')
  @AllowReadOnly()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'What a branch’s policy resolves to, after the whole chain',
    description:
      'Branch row → global row → system setting → built-in default. This is ' +
      'what the engine will actually use, which is rarely what any single row says.',
  })
  @ApiQuery({ name: 'branchId', required: false, description: 'Omit for the company-wide answer' })
  effective(
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.service.effective(branchId ?? null);
  }

  @Post()
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Create or replace a branch policy',
    description:
      'Upsert on branchId, since a branch has exactly one policy. A null field ' +
      'means "defer to the level below", never "zero".',
  })
  upsert(@Body() dto: UpsertLoanPolicyDto) {
    return this.service.upsert(dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Drop a branch policy — the branch falls back to the company rules',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
