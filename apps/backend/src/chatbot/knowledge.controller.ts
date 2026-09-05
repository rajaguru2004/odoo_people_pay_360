import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type {
  CreateKnowledgeDto,
  UpdateKnowledgeDto,
} from './knowledge.service';
import { KnowledgeService } from './knowledge.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Knowledge Base')
@Controller('knowledge')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create new knowledge' })
  @ApiResponse({ status: 201, description: 'Created successfully' })
  async create(@Body() dto: CreateKnowledgeDto, @Request() req) {
    return this.knowledgeService.create(dto, req.user.userId);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get knowledge list' })
  @ApiResponse({ status: 200, description: 'List retrieved successfully' })
  async findAll(
    @Query('category') category?: string,
    @Query('isActive') isActive?: string,
  ) {
    const isActiveBool =
      isActive === 'true' ? true : isActive === 'false' ? false : undefined;
    return this.knowledgeService.findAll(category, isActiveBool);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Get categories list' })
  @ApiResponse({ status: 200, description: 'List retrieved successfully' })
  async getCategories() {
    return this.knowledgeService.getCategories();
  }

  @Get('search')
  @ApiOperation({ summary: 'Search knowledge (RAG)' })
  @ApiResponse({ status: 200, description: 'Search successful' })
  async search(@Query('q') query: string, @Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit) : 5;
    return this.knowledgeService.search(query, limitNum);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get knowledge details' })
  @ApiResponse({ status: 200, description: 'Details retrieved successfully' })
  async findOne(@Param('id') id: string) {
    return this.knowledgeService.findOne(id);
  }

  @Put(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update knowledge' })
  @ApiResponse({ status: 200, description: 'Updated successfully' })
  async update(@Param('id') id: string, @Body() dto: UpdateKnowledgeDto) {
    return this.knowledgeService.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete knowledge' })
  @ApiResponse({ status: 200, description: 'Deleted successfully' })
  async remove(@Param('id') id: string) {
    return this.knowledgeService.remove(id);
  }
}
