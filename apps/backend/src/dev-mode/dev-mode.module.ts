import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { DevModeController } from './dev-mode.controller';
import { DevModeGuard } from './dev-mode.guard';
import { DevModeService } from './dev-mode.service';

/**
 * Global, because roughly a dozen controllers across unrelated modules need
 * `DevModeGuard` in their `@UseGuards(...)` and would otherwise each have to
 * import this module. Follows the same reasoning as CopilotSettingsModule.
 *
 * JwtModule is registered without options here — the secret is passed per call
 * in DevModeService, so it stays distinct from the access-token secret
 * configured in AuthModule.
 */
@Global()
@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [DevModeController],
  providers: [DevModeService, DevModeGuard],
  exports: [DevModeService, DevModeGuard],
})
export class DevModeModule {}
