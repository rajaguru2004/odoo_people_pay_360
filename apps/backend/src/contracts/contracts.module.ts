import { Module } from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { ContractsController } from './contracts.controller';
import { TerminationRequestService } from './termination-request.service';
import { TerminationRequestController } from './termination-request.controller';

@Module({
  // TerminationRequestController comes FIRST. Routes are matched in
  // registration order, and `contracts/terminations` would otherwise be handed
  // to ContractsController's `:id` handler before this controller ever sees it.
  controllers: [TerminationRequestController, ContractsController],
  providers: [ContractsService, TerminationRequestService],
  exports: [ContractsService, TerminationRequestService],
})
export class ContractsModule {}
