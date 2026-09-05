import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { LibraryType } from '@prisma/client';
import { LibraryItemsService } from './library-items.service';
import { CreateLibraryItemDto } from './dto/create-library-item.dto';
import { UpdateLibraryItemDto } from './dto/update-library-item.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Library Items')
@Controller('library-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class LibraryItemsController {
  constructor(private readonly libraryItemsService: LibraryItemsService) {}

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a new library item (Admin only)' })
  @ApiResponse({ status: 201, description: 'Created successfully' })
  async create(@Body() createLibraryItemDto: CreateLibraryItemDto) {
    const item = await this.libraryItemsService.create(createLibraryItemDto);
    return {
      success: true,
      data: item,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Get all library items (Authenticated only)' })
  @ApiQuery({ name: 'type', enum: LibraryType, required: false })
  @ApiQuery({ name: 'activeOnly', type: Boolean, required: false })
  @ApiResponse({ status: 200, description: 'Retrieved successfully' })
  async findAll(
    @Query('type') type?: LibraryType,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const isActive = activeOnly === 'true' ? true : activeOnly === 'false' ? false : undefined;
    const items = await this.libraryItemsService.findAll(type, isActive);
    return {
      success: true,
      data: items,
    };
  }

  @Post('seed')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Run default seeding for positions (Admin only)' })
  @ApiResponse({ status: 200, description: 'Seeded successfully' })
  async seed() {
    await this.libraryItemsService.seedDefaultPositions();
    return {
      success: true,
      message: 'Seeded defaults successfully',
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single library item (Authenticated only)' })
  @ApiResponse({ status: 200, description: 'Retrieved successfully' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const item = await this.libraryItemsService.findOne(id);
    return {
      success: true,
      data: item,
    };
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update a library item (Admin only)' })
  @ApiResponse({ status: 200, description: 'Updated successfully' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateLibraryItemDto: UpdateLibraryItemDto,
  ) {
    const item = await this.libraryItemsService.update(id, updateLibraryItemDto);
    return {
      success: true,
      data: item,
    };
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a library item (Admin only)' })
  @ApiResponse({ status: 200, description: 'Deleted successfully' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.libraryItemsService.remove(id);
    return {
      success: true,
      message: 'Item deleted successfully',
    };
  }
}
