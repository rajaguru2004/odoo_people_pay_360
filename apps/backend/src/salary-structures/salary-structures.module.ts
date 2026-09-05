import { Module } from '@nestjs/common';
import { SalaryStructuresService } from './salary-structures.service';
import { SalaryStructuresController } from './salary-structures.controller';

@Module({
  controllers: [SalaryStructuresController],
  providers: [SalaryStructuresService],
  exports: [SalaryStructuresService],
})
export class SalaryStructuresModule {}
