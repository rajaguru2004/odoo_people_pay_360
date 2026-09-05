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
import { DisciplinesService } from './disciplines.service';
import { CreateDisciplineDto } from './dto/create-discipline.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Disciplines')
@ApiBearerAuth('JWT-auth')
@Controller('disciplines')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Discipline')
export class DisciplinesController {
  constructor(private readonly disciplinesService: DisciplinesService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get all disciplines' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @Query() query: { employeeId?: string; page?: number; limit?: number },
  ) {
    return this.disciplinesService.findAll(query);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get disciplines by employee' })
  @ApiParam({ name: 'employeeId' })
  findByEmployee(@Param('employeeId') employeeId: string) {
    return this.disciplinesService.findByEmployee(employeeId);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Create discipline' })
  create(@Body() dto: CreateDisciplineDto, @CurrentUser() user: any) {
    return this.disciplinesService.create(dto, user.id, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete discipline' })
  @ApiParam({ name: 'id' })
  delete(@Param('id') id: string) {
    return this.disciplinesService.delete(id);
  }
}
