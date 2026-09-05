import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Per-employee, period-bounded performance aggregates. Kept in its own module
 * (Prisma only, no domain-module imports) so both the MCP tool layer and the
 * appraisal orchestrator can consume it without dependency cycles.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
