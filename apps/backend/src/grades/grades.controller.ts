import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { GradesService } from './grades.service';

@ApiTags('Employee grades')
@ApiBearerAuth('JWT-auth')
@Controller('grades')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Grade')
export class GradesController {
  constructor(private readonly service: GradesService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  list(@Query('includeInactive') includeInactive?: string) {
    return this.service.list(includeInactive === 'true');
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: Record<string, unknown>, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: any,
  ) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Retire a grade',
    description: 'Deactivates rather than deletes: employees reference it.',
  })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.deactivate(id, user);
  }

  @Put(':id/components')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Set the salary template',
    description:
      'A template, never a payroll input: it pre-fills SalaryComponent rows on ' +
      'hire. The engine still reads only SalaryComponent.',
  })
  setComponents(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { components: Array<Record<string, unknown>> },
    @CurrentUser() user: any,
  ) {
    return this.service.setComponents(id, dto?.components ?? [], user);
  }

  @Get(':id/template')
  @Roles('ADMIN', 'HR_MANAGER')
  template(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('basic') basic: string,
  ) {
    return this.service.templateFor(id, Number(basic) || 0);
  }

  @Post('assign/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Put an employee on a grade',
    description:
      'Refused when their salary sits outside the band, naming both figures.',
  })
  assign(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: { gradeId: string | null },
    @CurrentUser() user: any,
  ) {
    return this.service.assign(employeeId, dto?.gradeId ?? null, user);
  }
}
