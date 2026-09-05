import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { BranchesService } from './branches.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Branches')
@ApiBearerAuth('JWT-auth')
@Controller('branches')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Branch')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Get all branches',
    description:
      'Lists active branches. ADMIN/HR_MANAGER may pass includeInactive=true to ' +
      'get retired ones as well — the only way to find a branch that was ' +
      'deactivated by mistake, since it is hidden from every list and picker.',
  })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Branches retrieved successfully' })
  findAll(
    @Request() req: any,
    @Query('includeInactive') includeInactive?: string,
  ) {
    // Honoured only for the roles that may also switch a branch back on. A
    // MANAGER asking for retired branches gets the active list rather than a
    // 403, so the shared pickers on this endpoint keep working untouched.
    const role = req?.user?.role;
    const maySeeRetired = role === 'ADMIN' || role === 'HR_MANAGER';
    return this.branchesService.findAll(
      maySeeRetired && includeInactive === 'true',
    );
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get a branch by id' })
  @ApiParam({ name: 'id', description: 'Branch ID' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.branchesService.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create a branch' })
  @ApiResponse({ status: 201, description: 'Branch created successfully' })
  create(@Body() dto: CreateBranchDto, @Request() req: any) {
    return this.branchesService.create(dto, req.user?.id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update a branch' })
  @ApiParam({ name: 'id', description: 'Branch ID' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto) {
    return this.branchesService.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete a branch (soft delete)' })
  @ApiParam({ name: 'id', description: 'Branch ID' })
  delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.branchesService.delete(id);
  }
}
