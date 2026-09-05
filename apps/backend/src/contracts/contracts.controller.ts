import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';
import { ListContractsDto } from './dto/list-contracts.dto';
import { RenewContractDto } from './dto/renew-contract.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Contracts')
@ApiBearerAuth('JWT-auth')
@Controller('contracts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Get()
  @ApiOperation({ summary: 'List contracts' })
  findAll(@Query() query: ListContractsDto) {
    return this.contractsService.findAll(query);
  }

  // Declared before `:id`. Express matches in declaration order, so with `:id`
  // first the literal segment would be handed to ParseUUIDPipe and every
  // request to the expiry report would 400.
  @Get('expiring')
  @ApiOperation({ summary: 'Contracts running out inside the given window' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  expiring(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    return this.contractsService.expiring(days);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one contract with its termination history' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.contractsService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Create a contract' })
  create(@Body() dto: CreateContractDto) {
    return this.contractsService.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Update a contract' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContractDto,
  ) {
    return this.contractsService.update(id, dto);
  }

  @Post(':id/renew')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Renew a contract',
    description: 'Closes the current one and returns its successor.',
  })
  renew(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RenewContractDto) {
    return this.contractsService.renew(id, dto);
  }
}
