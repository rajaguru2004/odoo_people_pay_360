import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ApprovalEngineService } from './approval-engine.service';
import { ApprovalWorkflowService } from './approval-workflow.service';
import { ApprovalWorkflowController } from './approval-workflow.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ApprovalWorkflowController],
  providers: [ApprovalEngineService, ApprovalWorkflowService],
  exports: [ApprovalEngineService, ApprovalWorkflowService],
})
export class ApprovalsModule {}
