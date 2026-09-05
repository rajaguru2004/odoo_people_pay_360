import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditResource } from '../audit/audit-resource.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { DevModeGuard } from '../dev-mode/dev-mode.guard';
import { RequireDeveloper } from '../dev-mode/require-developer.decorator';
import { CopilotSettingsService } from './copilot-settings.service';
import { TestConnectionDto } from './dto/test-connection.dto';
import { UpdateCopilotSettingsDto } from './dto/update-copilot-settings.dto';

/**
 * The LLM endpoint, key and model chain are operator configuration: they decide
 * where tenant HR data is sent for inference. Developer mode only.
 */
@ApiTags('copilot-settings')
@ApiBearerAuth('JWT-auth')
@Controller('copilot-settings')
@UseGuards(JwtAuthGuard, RolesGuard, DevModeGuard)
@Roles('ADMIN')
@RequireDeveloper()
@AuditResource('CopilotSetting')
export class CopilotSettingsController {
  constructor(private readonly settings: CopilotSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get MCP + HR Copilot settings (API key masked)' })
  async get() {
    return { success: true, data: await this.settings.getPublic() };
  }

  @Put()
  @ApiOperation({ summary: 'Update MCP + HR Copilot settings' })
  async update(@Body() dto: UpdateCopilotSettingsDto) {
    return { success: true, data: await this.settings.update(dto) };
  }

  @Post('available-models')
  @ApiOperation({ summary: 'List tool-capable models (accepts unsaved Base URL / key overrides)' })
  async availableModels(@Body() dto: TestConnectionDto) {
    return {
      success: true,
      data: await this.settings.availableModels({ baseUrl: dto.baseUrl, apiKey: dto.apiKey }),
    };
  }

  @Post('test-connection')
  @ApiOperation({ summary: 'Live-test the LLM endpoint (accepts unsaved form overrides)' })
  async testConnection(@Body() dto: TestConnectionDto) {
    return { success: true, data: await this.settings.testConnection(dto) };
  }
}
