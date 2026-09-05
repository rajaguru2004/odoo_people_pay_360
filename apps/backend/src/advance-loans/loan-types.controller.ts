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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LoanTypesService } from './loan-types.service';
import { CreateLoanTypeDto, UpdateLoanTypeDto } from './dto/loan-type.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { AllowReadOnly, LoanReadOnlyGuard } from './loan-readonly.guard';

/**
 * The loan product catalogue.
 *
 * Reads are open to every role that can file or decide a request: the terms are
 * what an employee is agreeing to, so hiding the catalogue from them would mean
 * the create form could not explain its own limits. Writes are ADMIN — a
 * product changes what every future loan costs.
 *
 * `LoanReadOnlyGuard` is on the class for the same reason as every other loan
 * controller: an account the auditor settings declare read-only must not be
 * able to edit the product terms it is auditing.
 */
@ApiTags('Salary Advances & Loans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, LoanReadOnlyGuard)
@Controller('loan-types')
@AuditResource('LoanType')
export class LoanTypesController {
  constructor(private readonly service: LoanTypesService) {}

  @Get()
  @AllowReadOnly()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'List loan products available to the caller' })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    description:
      'Admin-only view of retired products. Ignored for non-admin callers: a ' +
      'retired product cannot be chosen, so offering it would only produce a refusal.',
  })
  findAll(@Query('includeInactive') includeInactive?: string) {
    return this.service.findAll(includeInactive === 'true');
  }

  @Get(':id')
  @AllowReadOnly()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'One loan product, with its full terms' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a loan product' })
  create(@Body() dto: CreateLoanTypeDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Edit a loan product',
    description:
      'Terms are snapshotted onto a request at approval, so editing a product ' +
      'never rewrites a live loan — it changes what the NEXT request inherits.',
  })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLoanTypeDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/activate')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Return a retired product to the catalogue' })
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.setActive(id, true);
  }

  @Post(':id/deactivate')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Retire a product — existing loans are untouched',
  })
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.setActive(id, false);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Delete a product that no loan has ever used',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
