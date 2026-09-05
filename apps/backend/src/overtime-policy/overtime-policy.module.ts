import { Module } from '@nestjs/common';
import { OvertimePolicyService } from './overtime-policy.service';
import { OvertimePolicyController } from './overtime-policy.controller';

/**
 * Exported because the overtime module resolves every request through this
 * engine — the rate card that classifies an employee's hours is one decision,
 * and a second copy of the chain would eventually disagree with this one.
 */
@Module({
  controllers: [OvertimePolicyController],
  providers: [OvertimePolicyService],
  exports: [OvertimePolicyService],
})
export class OvertimePolicyModule {}
