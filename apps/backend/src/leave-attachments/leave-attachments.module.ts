import { Module } from '@nestjs/common';
import { LeaveAttachmentsController } from './leave-attachments.controller';
import { LeaveAttachmentsService } from './leave-attachments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [LeaveAttachmentsController],
  providers: [LeaveAttachmentsService],
  exports: [LeaveAttachmentsService],
})
export class LeaveAttachmentsModule {}
