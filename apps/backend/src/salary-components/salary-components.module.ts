import { Module } from '@nestjs/common';
import { SalaryComponentsController } from './salary-components.controller';
import { SalaryComponentsService } from './salary-components.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SalaryComponentsController],
  providers: [SalaryComponentsService],
  exports: [SalaryComponentsService],
})
export class SalaryComponentsModule {}
