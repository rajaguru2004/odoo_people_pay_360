import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsArray, IsString } from 'class-validator';
import { BankService } from './bank.service';
import { CreateBankDto, UpdateBankDto } from './dto/bank.dto';

class SetBranchCountriesDto {
  @IsArray()
  @IsString({ each: true })
  countries: string[];
}

@ApiTags('Bank Master')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('banks')
export class BankController {
  constructor(private readonly banks: BankService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'List banks (filter by country / active-only)' })
  list(
    @Query('country') country?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.banks.list(country, activeOnly === 'true');
  }

  @Get('branch-countries')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Branches with their allowed banking countries' })
  branchCountries() {
    return this.banks.listBranchCountries();
  }

  @Put('branch-countries/:branchId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Set a branch allowed banking countries (ISO-2)' })
  setBranchCountries(
    @CurrentUser() user: any,
    @Param('branchId') branchId: string,
    @Body() dto: SetBranchCountriesDto,
  ) {
    return this.banks.setBranchCountries(branchId, dto.countries, user.id);
  }

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a bank in the Bank Master' })
  create(@CurrentUser() user: any, @Body() dto: CreateBankDto) {
    return this.banks.create(dto, user.id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update a bank' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateBankDto,
  ) {
    return this.banks.update(id, dto, user.id);
  }

  @Patch(':id/deactivate')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Deactivate a bank' })
  deactivate(@CurrentUser() user: any, @Param('id') id: string) {
    return this.banks.deactivate(id, user.id);
  }
}
