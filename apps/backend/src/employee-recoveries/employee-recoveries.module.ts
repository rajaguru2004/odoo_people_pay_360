import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { EmployeeRecoveriesController } from './employee-recoveries.controller';
import { EmployeeRecoveriesService } from './employee-recoveries.service';

/**
 * Employer recoveries through payroll.
 *
 * One-way: PayrollsModule imports this for the ladder seam. This module must
 * never import PayrollsModule back.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [EmployeeRecoveriesController],
  providers: [EmployeeRecoveriesService],
  exports: [EmployeeRecoveriesService],
})
export class EmployeeRecoveriesModule {}
