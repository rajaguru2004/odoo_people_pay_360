import {
  Body,
  Controller,
  Delete,
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
import { HolidaysService } from './holidays.service';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { ListHolidaysDto } from './dto/list-holidays.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Holidays')
@ApiBearerAuth('JWT-auth')
@Controller('holidays')
@UseGuards(JwtAuthGuard, RolesGuard)
export class HolidaysController {
  constructor(private readonly holidaysService: HolidaysService) {}

  @Get()
  @ApiOperation({
    summary: 'List holidays',
    description:
      "With a branchId: company-wide rows plus that branch's, the branch row winning on a shared date.",
  })
  findAll(@Query() query: ListHolidaysDto) {
    return this.holidaysService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one holiday' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.holidaysService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Add a holiday' })
  create(@Body() dto: CreateHolidayDto) {
    return this.holidaysService.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Edit a holiday' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHolidayDto,
  ) {
    return this.holidaysService.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Delete a holiday' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.holidaysService.remove(id);
  }
}
