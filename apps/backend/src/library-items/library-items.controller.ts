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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { LibraryType, UserRole } from '@prisma/client';
import { LibraryItemsService } from './library-items.service';
import { CreateLibraryItemDto } from './dto/create-library-item.dto';
import { UpdateLibraryItemDto } from './dto/update-library-item.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Library Items')
@ApiBearerAuth('JWT-auth')
@Controller('library-items')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LibraryItemsController {
  constructor(private readonly libraryItems: LibraryItemsService) {}

  @Get()
  @ApiOperation({
    summary: 'List pick-list entries',
    description:
      'Readable by any signed-in caller — every form that draws a dropdown needs it.',
  })
  @ApiQuery({ name: 'type', enum: LibraryType, required: false })
  @ApiQuery({ name: 'activeOnly', type: Boolean, required: false })
  findAll(
    @Query('type') type?: LibraryType,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const isActive =
      activeOnly === 'true' ? true : activeOnly === 'false' ? false : undefined;
    return this.libraryItems.findAll(type, isActive);
  }

  @Post('seed')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Re-create the shipped defaults (idempotent)' })
  async seed() {
    await this.libraryItems.seedDefaults();
    return { seeded: true };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one pick-list entry' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.libraryItems.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Add a pick-list entry' })
  create(@Body() dto: CreateLibraryItemDto) {
    return this.libraryItems.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Edit a pick-list entry' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLibraryItemDto,
  ) {
    return this.libraryItems.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete a pick-list entry' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.libraryItems.remove(id);
  }
}
