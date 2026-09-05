import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { RewardsService } from './rewards.service';
import { CreateRewardDto } from './dto/create-reward.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Rewards')
@ApiBearerAuth('JWT-auth')
@Controller('rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Reward')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get all rewards' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @Query() query: { employeeId?: string; page?: number; limit?: number },
  ) {
    return this.rewardsService.findAll(query);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get rewards by employee' })
  @ApiParam({ name: 'employeeId' })
  findByEmployee(@Param('employeeId') employeeId: string) {
    return this.rewardsService.findByEmployee(employeeId);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Create reward' })
  create(@Body() dto: CreateRewardDto, @CurrentUser() user: any) {
    return this.rewardsService.create(dto, user.id, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete reward' })
  @ApiParam({ name: 'id' })
  delete(@Param('id') id: string) {
    return this.rewardsService.delete(id);
  }
}
