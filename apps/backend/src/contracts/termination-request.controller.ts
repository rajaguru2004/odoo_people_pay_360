import {
  Body,
  Controller,
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
import { TerminationRequestService } from './termination-request.service';
import { CreateTerminationDto } from './dto/create-termination.dto';
import { ListTerminationsDto } from './dto/list-terminations.dto';
import { ReviewTerminationDto } from './dto/review-termination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Contracts')
@ApiBearerAuth('JWT-auth')
@Controller('contracts/terminations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TerminationRequestController {
  constructor(private readonly terminations: TerminationRequestService) {}

  @Get()
  @ApiOperation({ summary: 'List termination requests' })
  findAll(@Query() query: ListTerminationsDto) {
    return this.terminations.findAll(query);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Raise a termination request',
    description: 'The employee record is untouched until somebody approves it.',
  })
  create(@Body() dto: CreateTerminationDto, @CurrentUser() user: Principal) {
    return this.terminations.create(dto, user.id);
  }

  @Patch(':id/review')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Approve or reject a termination request',
    description: 'Approving is what actually ends the employment.',
  })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewTerminationDto,
    @CurrentUser() user: Principal,
  ) {
    return this.terminations.review(id, dto, user.id);
  }
}
