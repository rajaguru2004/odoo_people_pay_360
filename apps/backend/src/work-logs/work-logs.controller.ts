import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { WorkLogsService } from './work-logs.service';
import {
  CreateWorkLogDto,
  UpdateWorkLogDto,
  StartTimerDto,
  StopTimerDto,
} from './dto/create-work-log.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Work Logs')
@ApiBearerAuth('JWT-auth')
@Controller('work-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('WorkLog')
export class WorkLogsController {
  constructor(private readonly service: WorkLogsService) {}

  @Get('my')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get my work logs' })
  findMine(@CurrentUser() user: any) {
    return this.service.findMine(user);
  }

  @Get('timer/status')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get current timer status' })
  timerStatus(@CurrentUser() user: any) {
    return this.service.getActiveTimerStatus(user);
  }

  @Get('task/:taskId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get work logs for a task' })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  findByTask(@Param('taskId') taskId: string, @CurrentUser() user: any) {
    return this.service.findByTask(taskId, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Create manual work log' })
  create(@Body() dto: CreateWorkLogDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Edit own work log' })
  @ApiParam({ name: 'id', description: 'Work Log UUID' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkLogDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Delete own work log' })
  @ApiParam({ name: 'id', description: 'Work Log UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }

  @Post('timer/start')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Start work timer for a task' })
  startTimer(@Body() dto: StartTimerDto, @CurrentUser() user: any) {
    return this.service.startTimer(dto, user);
  }

  @Post('timer/pause')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Pause active timer' })
  pauseTimer(@CurrentUser() user: any) {
    return this.service.pauseTimer(user);
  }

  @Post('timer/resume')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Resume paused timer' })
  resumeTimer(@CurrentUser() user: any) {
    return this.service.resumeTimer(user);
  }

  @Post('timer/stop')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Stop timer and create work log entry' })
  stopTimer(@Body() dto: StopTimerDto, @CurrentUser() user: any) {
    return this.service.stopTimer(dto, user);
  }
}
