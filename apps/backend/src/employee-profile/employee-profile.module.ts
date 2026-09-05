import { Module } from '@nestjs/common';
import { EmployeeProfileService } from './employee-profile.service';
import { EmployeeProfileController } from './employee-profile.controller';

@Module({
  controllers: [EmployeeProfileController],
  providers: [EmployeeProfileService],
  exports: [EmployeeProfileService],
})
export class EmployeeProfileModule {}
