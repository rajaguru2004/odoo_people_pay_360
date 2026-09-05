import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { GarnishmentsController } from './garnishments.controller';
import { GarnishmentsService } from './garnishments.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [GarnishmentsController],
  providers: [GarnishmentsService],
  // PayrollsModule consumes this to fill the garnishment rung of the recovery
  // ladder. One-way: this module never imports PayrollsModule.
  exports: [GarnishmentsService],
})
export class GarnishmentsModule {}
