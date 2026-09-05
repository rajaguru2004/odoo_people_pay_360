import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { ApprovalEngineService } from './approval-engine.service';
import { ApprovalWorkflowService } from './approval-workflow.service';
import { ApprovalWorkflowController } from './approval-workflow.controller';

@Module({
  imports: [PrismaModule, NotificationsModule, AuditModule],
  controllers: [ApprovalWorkflowController],
  providers: [ApprovalEngineService, ApprovalWorkflowService],
  exports: [ApprovalEngineService, ApprovalWorkflowService],
})
export class ApprovalsModule {}
