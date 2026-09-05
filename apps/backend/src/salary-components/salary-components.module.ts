import { Module } from '@nestjs/common';
import { SalaryComponentsService } from './salary-components.service';
import { SalaryComponentsController } from './salary-components.controller';

@Module({
  controllers: [SalaryComponentsController],
  providers: [SalaryComponentsService],
  exports: [SalaryComponentsService],
})
export class SalaryComponentsModule {}
