import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EmployeeProfileService } from './employee-profile.service';
import { UpdateEmployeeProfileDto } from './dto/update-employee-profile.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

/**
 * The self-service half of an employee record.
 *
 * Mounted on `employees` beside the HR-facing controller rather than on a path
 * of its own, because it answers about the same resource and the screens
 * already address it that way. The two are not interchangeable: `PATCH
 * /employees/:id` is HR asserting facts about somebody, and `PATCH
 * /employees/:id/profile` is a person maintaining their own contact details.
 * Keeping them apart is what lets the second one be open to the employee at all.
 */
@ApiTags('Employee Profile')
@ApiBearerAuth('JWT-auth')
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeeProfileController {
  constructor(private readonly service: EmployeeProfileService) {}

  @Get(':id/profile')
  @ApiOperation({
    summary: 'An employee profile',
    description:
      'The record as its owner sees it, with the current contract and how much of the self-maintained half is filled in. An employee may read their own; anyone else needs an HR role.',
  })
  findOne(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(id, user);
  }

  @Patch(':id/profile')
  @ApiOperation({
    summary: 'Update contact and personal details',
    description:
      'Only the fields a person maintains about themselves. Position, department, salary and status are asserted by HR through PATCH /employees/:id.',
  })
  update(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeProfileDto,
  ) {
    return this.service.update(id, dto, user);
  }
}
