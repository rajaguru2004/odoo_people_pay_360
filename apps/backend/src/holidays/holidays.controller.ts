import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
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
import { HolidaysService } from './holidays.service';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { CopyYearDto } from './dto/copy-year.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Holidays')
@ApiBearerAuth('JWT-auth')
@Controller('holidays')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Holiday')
export class HolidaysController {
  constructor(private readonly holidaysService: HolidaysService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get holidays',
    description:
      'List holidays visible to the caller (company-wide + accessible branches). Optionally filter by year and branch.',
  })
  @ApiQuery({ name: 'year', required: false, type: Number, example: 2026 })
  @ApiQuery({ name: 'branchId', required: false, type: String })
  findAll(@Query('year') year?: number, @Query('branchId') branchId?: string) {
    return this.holidaysService.findAll(year ? +year : undefined, branchId);
  }

  @Get('year/:year')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get holidays by year' })
  @ApiParam({ name: 'year', description: 'Year', example: 2026 })
  findByYear(@Param('year') year: number) {
    return this.holidaysService.findByYear(+year);
  }

  @Get('work-days/:month/:year')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get work-day breakdown for a month',
    description:
      'Working days, weekly-off days and holidays for a month, optionally scoped to a branch.',
  })
  @ApiParam({ name: 'month', description: 'Month (1-12)' })
  @ApiParam({ name: 'year', description: 'Year' })
  @ApiQuery({ name: 'branchId', required: false, type: String })
  async getWorkDays(
    @Param('month') month: number,
    @Param('year') year: number,
    @Query('branchId') branchId?: string,
  ) {
    const data = await this.holidaysService.getWorkDaysBreakdown(
      +month,
      +year,
      branchId,
    );
    return { success: true, data };
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get a holiday by id' })
  @ApiParam({ name: 'id', description: 'Holiday UUID' })
  findOne(@Param('id') id: string) {
    return this.holidaysService.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create holiday' })
  @ApiResponse({ status: 201, description: 'Holiday created' })
  @ApiResponse({ status: 409, description: 'Holiday already exists in scope' })
  create(@Body() createHolidayDto: CreateHolidayDto) {
    return this.holidaysService.create(createHolidayDto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update holiday' })
  @ApiParam({ name: 'id', description: 'Holiday UUID' })
  update(@Param('id') id: string, @Body() dto: UpdateHolidayDto) {
    return this.holidaysService.update(id, dto);
  }

  @Post('copy-year')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Copy holidays into another year',
    description:
      'Copies holidays from one year to another (dates shift to the target year). Existing dates are skipped.',
  })
  copyYear(@Body() dto: CopyYearDto) {
    return this.holidaysService.copyYear(
      dto.fromYear,
      dto.toYear,
      dto.branchId,
      dto.onlyRecurring,
    );
  }

  @Post('init-year/:year')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Initialize a year from recurring holidays',
    description: "Seeds the year from the previous year's recurring holidays",
  })
  @ApiParam({ name: 'year', description: 'Year', example: 2026 })
  initYear(@Param('year') year: number) {
    return this.holidaysService.initYearHolidays(+year);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete holiday' })
  @ApiParam({ name: 'id', description: 'Holiday UUID' })
  delete(@Param('id') id: string) {
    return this.holidaysService.delete(id);
  }
}
