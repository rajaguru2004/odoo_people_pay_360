import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditService } from './audit.service';
import { AuditLogsController } from './audit-logs.controller';
import { AuditInterceptor } from './audit.interceptor';

@Module({
  imports: [PrismaModule],
  controllers: [AuditLogsController],
  providers: [AuditService, AuditInterceptor],
  exports: [AuditService, AuditInterceptor],
})
export class AuditModule {}
