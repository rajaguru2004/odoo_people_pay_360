import { Module } from '@nestjs/common';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectRbacModule } from '../projects/rbac/project-rbac.module';

@Module({
  imports: [PrismaModule, ProjectRbacModule],
  controllers: [LabelsController],
  providers: [LabelsService],
  exports: [LabelsService],
})
export class LabelsModule {}
