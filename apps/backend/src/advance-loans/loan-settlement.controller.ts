import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiProperty,
} from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { LoanReadOnlyGuard } from './loan-readonly.guard';
import { LoanSettlementService } from './loan-settlement.service';

export class SettlementDecisionDto {
  @ApiProperty()
  @IsUUID()
  loanId: string;

  @ApiProperty({
    enum: [
      'RECOVER_FROM_FINAL_PAY',
      'RECOVER_FROM_GRATUITY',
      'RECOVER_FROM_LEAVE_ENCASHMENT',
      'PARTIAL',
      'WAIVE',
      'WRITE_OFF',
      'CARRY_AS_RECEIVABLE',
    ],
  })
  @IsIn([
    'RECOVER_FROM_FINAL_PAY',
    'RECOVER_FROM_GRATUITY',
    'RECOVER_FROM_LEAVE_ENCASHMENT',
    'PARTIAL',
    'WAIVE',
    'WRITE_OFF',
    'CARRY_AS_RECEIVABLE',
  ])
  action: any;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  amount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  reference?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}

export class SettleLoansDto {
  @ApiProperty({
    type: [SettlementDecisionDto],
    description:
      'EVERY outstanding loan must be named. A silent omission is how a ' +
      'receivable disappears at exit, so the request is refused otherwise.',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SettlementDecisionDto)
  decisions: SettlementDecisionDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}

export class ReverseSettlementDto {
  @ApiProperty()
  @IsString()
  @Length(5, 500)
  reason: string;
}

@ApiTags('Advance & Loan — settlement')
@ApiBearerAuth('JWT-auth')
@Controller('advance-loans/settlement')
// LoanReadOnlyGuard: settling and reversing a settlement move money, so a
// read-only auditor is refused there while both GETs stay open to them (§8).
@UseGuards(JwtAuthGuard, RolesGuard, LoanReadOnlyGuard)
@AuditResource('AdvanceLoan')
export class LoanSettlementController {
  constructor(private readonly settlement: LoanSettlementService) {}

  @Get('receivable')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Loans carried past an exit',
    description:
      'Resumed manually on rehire. Auto-resurrecting a debt is not a decision ' +
      'code should make.',
  })
  receivable() {
    return this.settlement.listReceivable();
  }

  @Get(':employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Everything an exiting employee still owes' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  quote(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.settlement.quote(employeeId);
  }

  @Post(':employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Record exit settlement decisions',
    description:
      'Records the DECISION and its ledger effect. The gratuity / leave ' +
      'encashment payout itself is external — this owns the receivable.',
  })
  @ApiResponse({ status: 400, description: 'An outstanding loan was not named' })
  settle(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: SettleLoansDto,
    @CurrentUser() user: any,
  ) {
    return this.settlement.settle(employeeId, user, dto as any);
  }

  @Post(':settlementId/reverse')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Reverse a settlement',
    description: 'Restores every loan from the pre-state snapshot taken when it was decided.',
  })
  reverse(
    @Param('settlementId', ParseUUIDPipe) settlementId: string,
    @Body() dto: ReverseSettlementDto,
    @CurrentUser() user: any,
  ) {
    return this.settlement.reverseSettlement(settlementId, user, dto);
  }
}
