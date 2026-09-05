import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LeaveAttachmentsController } from './leave-attachments.controller';
import { LeaveAttachmentsService } from './leave-attachments.service';

@Module({
  imports: [PrismaModule],
  controllers: [LeaveAttachmentsController],
  providers: [LeaveAttachmentsService],
  exports: [LeaveAttachmentsService],
})
export class LeaveAttachmentsModule {}
