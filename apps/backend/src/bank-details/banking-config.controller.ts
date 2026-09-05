import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
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
import { BankingConfigService } from './banking-config.service';
import { UpsertBankingFieldDto } from './dto/banking-config.dto';

@ApiTags('Country Banking Configuration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('banking-config')
export class BankingConfigController {
  constructor(private readonly config: BankingConfigService) {}

  @Get('fields')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Active banking fields for a country (form rendering)' })
  fields(@Query('country') country: string) {
    return this.config
      .getFieldsForCountry(country)
      .then((data) => ({ success: true, data }));
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List configured banking fields (all, optionally by country)' })
  list(@Query('country') country?: string) {
    return this.config.list(country);
  }

  @Put()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create or update a banking field for a country' })
  upsert(@CurrentUser() user: any, @Body() dto: UpsertBankingFieldDto) {
    return this.config.upsert(dto, user.id);
  }

  @Post('seed')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Seed default field configs for shipped countries' })
  seed(@CurrentUser() user: any) {
    return this.config.seedDefaults(user.id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a banking field' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.config.remove(id, user.id);
  }
}
