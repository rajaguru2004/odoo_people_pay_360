import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { ProfileTemplateService } from './profile-template.service';
import { ProfileTemplateResolverService } from './profile-template-resolver.service';
import { ProfileTemplateController } from './profile-template.controller';

/**
 * Exports the resolver so EmployeesModule can validate and route writes against
 * the same resolved template the frontend rendered from.
 */
@Module({
  imports: [PrismaModule, AuditModule, SystemSettingsModule],
  controllers: [ProfileTemplateController],
  providers: [ProfileTemplateService, ProfileTemplateResolverService],
  exports: [ProfileTemplateService, ProfileTemplateResolverService],
})
export class ProfileTemplatesModule {}
