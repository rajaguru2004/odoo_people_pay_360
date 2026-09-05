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
import { LibraryItemsService } from './library-items.service';
import { CreateLibraryItemDto } from './dto/create-library-item.dto';
import { UpdateLibraryItemDto } from './dto/update-library-item.dto';
import { ListLibraryItemsDto } from './dto/list-library-items.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Library items')
@ApiBearerAuth('JWT-auth')
@Controller('library-items')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LibraryItemsController {
  constructor(private readonly service: LibraryItemsService) {}

  /**
   * Open to every authenticated caller: an employee filing leave has to be able
   * to see the list of leave types they may pick from.
   */
  @Get()
  @ApiOperation({ summary: 'List library items' })
  findAll(@Query() query: ListLibraryItemsDto) {
    return this.service.findAll(query);
  }

  // Literal before `:id`, or Nest parses "seed" as a uuid and answers 400.
  @Post('seed')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Re-create the default pick lists (idempotent)' })
  async seed() {
    await this.service.seedDefaults();
    return { success: true, message: 'Library defaults seeded' };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one library item' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Create a library item' })
  create(@Body() dto: CreateLibraryItemDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Update a library item' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLibraryItemDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Deactivate a library item',
    description:
      'Soft: balances and requests store the LABEL, so a hard delete would ' +
      'leave a year of history naming a type that no longer exists.',
  })
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivate(id);
  }
}
