import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PayslipsService } from './payslips.service';
import { ListPayslipsDto } from './dto/list-payslips.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Payroll')
@ApiBearerAuth('JWT-auth')
@Controller('payslips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayslipsController {
  constructor(private readonly payslips: PayslipsService) {}

  // `my` and `my/:id` come first. `:id` would otherwise swallow the literal
  // segment and answer 400 for every self-service request.
  @Get('my')
  @ApiOperation({ summary: 'My own payslips — settled runs only' })
  findMine(@CurrentUser() user: Principal, @Query() query: ListPayslipsDto) {
    return this.payslips.findMine(user, query);
  }

  @Get('my/:id')
  @ApiOperation({ summary: 'One of my own payslips' })
  findMineOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.payslips.findMineOne(id, user);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'List payslips' })
  findAll(@Query() query: ListPayslipsDto) {
    return this.payslips.findAll(query);
  }

  @Get('employee/:employeeId')
  @ApiOperation({ summary: "One employee's payslips" })
  findByEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() user: Principal,
    @Query() query: ListPayslipsDto,
  ) {
    return this.payslips.findByEmployee(employeeId, user, query);
  }

  // No `@Roles` on purpose. Whether this is allowed depends on WHOSE payslip it
  // is, and a decorator cannot see that — the service narrows it against the
  // principal, the same way `attendances` does.
  @Get(':id')
  @ApiOperation({ summary: 'One payslip — own, or any for a payroll role' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.payslips.findOne(id, user);
  }
}
