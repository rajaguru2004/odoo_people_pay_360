import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfileTemplatesModule } from '../profile-templates/profile-templates.module';

@Module({
  imports: [PrismaModule, ProfileTemplatesModule],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
