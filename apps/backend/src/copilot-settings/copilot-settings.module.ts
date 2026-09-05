import { Global, Module } from '@nestjs/common';
import { CopilotSettingsController } from './copilot-settings.controller';
import { CopilotSettingsService } from './copilot-settings.service';

/**
 * Global so both McpModule and CopilotModule can inject CopilotSettingsService
 * without extra import wiring. PrismaModule is already @Global().
 */
@Global()
@Module({
  controllers: [CopilotSettingsController],
  providers: [CopilotSettingsService],
  exports: [CopilotSettingsService],
})
export class CopilotSettingsModule {}
