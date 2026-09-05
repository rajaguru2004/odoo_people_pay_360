import { Module } from '@nestjs/common';
import { SupervisorsService } from './supervisors.service';
import { SupervisorsController } from './supervisors.controller';

@Module({
  controllers: [SupervisorsController],
  providers: [SupervisorsService],
  exports: [SupervisorsService],
})
export class SupervisorsModule {}
