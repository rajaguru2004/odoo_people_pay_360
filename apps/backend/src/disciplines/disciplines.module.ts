import { Module } from '@nestjs/common';
import { DisciplinesController } from './disciplines.controller';
import { DisciplinesService } from './disciplines.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [DisciplinesController],
  providers: [DisciplinesService],
  exports: [DisciplinesService],
})
export class DisciplinesModule {}
