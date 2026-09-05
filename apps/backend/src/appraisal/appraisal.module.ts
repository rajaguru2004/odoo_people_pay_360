import { Module } from '@nestjs/common';
import { OpenRouterToolsClient } from '../copilot/llm/openrouter-tools.client';
import { InProcessToolTransport } from '../copilot/mcp/in-process.transport';
import { McpModule } from '../mcp/mcp.module';
import { AppraisalController } from './appraisal.controller';
import { AppraisalEventsService } from './appraisal-events.service';
import { AppraisalOrchestratorService } from './appraisal-orchestrator.service';
import { AppraisalService } from './appraisal.service';

/**
 * AI-powered Appraisal & Ranking. Reuses the copilot's LLM client and the MCP
 * in-process tool transport (RBAC, confirm-gate, ALS branch scope, audit all
 * apply) under a dedicated background orchestrator with SSE progress streaming.
 */
@Module({
  imports: [McpModule],
  controllers: [AppraisalController],
  providers: [
    AppraisalService,
    AppraisalEventsService,
    AppraisalOrchestratorService,
    OpenRouterToolsClient,
    InProcessToolTransport,
  ],
  // The Talent hub reads run counts from `AppraisalService.stats()` rather than
  // re-querying `appraisal_runs`; nothing else about the module is exposed.
  exports: [AppraisalService],
})
export class AppraisalModule {}
