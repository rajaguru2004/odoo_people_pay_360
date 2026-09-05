import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { DepartmentChangeRequestsService } from './department-change-requests.service';
import { CreateDepartmentChangeRequestDto } from './dto/create-department-change-request.dto';
import { ListDepartmentChangeRequestsDto } from './dto/list-department-change-requests.dto';
import { ReviewDepartmentChangeRequestDto } from './dto/review-department-change-request.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { Principal } from '../../auth/auth.service';

/**
 * Registered ahead of DepartmentsController in DepartmentsModule.
 *
 * Both live under `departments`, and Express matches in registration order —
 * with the other controller first, `change-requests` would be handed to its
 * `:id` route and rejected by ParseUUIDPipe before ever reaching here.
 */
@ApiTags('Departments')
@ApiBearerAuth('JWT-auth')
@Controller('departments/change-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DepartmentChangeRequestsController {
  constructor(private readonly service: DepartmentChangeRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'List department change requests' })
  findAll(@Query() query: ListDepartmentChangeRequestsDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one change request',
    description:
      'Includes an impact block counted live against the target department.',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Raise a department change request',
    description:
      'Open to any authenticated caller — raising is not the same as applying.',
  })
  create(
    @Body() dto: CreateDepartmentChangeRequestDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.create(dto, user);
  }

  @Patch(':id/review')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Approve or reject a change request',
    description: 'Approving applies the change to the department.',
  })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDepartmentChangeRequestDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.review(id, dto, user);
  }

  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Withdraw a pending change request',
    description: 'The requester may cancel their own; an admin may cancel any.',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.cancel(id, user);
  }
}
