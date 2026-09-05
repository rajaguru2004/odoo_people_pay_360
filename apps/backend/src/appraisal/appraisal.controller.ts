import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { getBranchContext } from '../common/branch/branch-context';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { HrmPrincipal } from '../mcp/tool.types';
import { AppraisalEventsService } from './appraisal-events.service';
import { AppraisalOrchestratorService } from './appraisal-orchestrator.service';
import { AppraisalService } from './appraisal.service';
import type { AppraisalStreamEvent } from './appraisal.types';
import { CreateAppraisalRunDto } from './dto/create-appraisal-run.dto';

@ApiTags('appraisal')
@ApiBearerAuth('JWT-auth')
@Controller('appraisal')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'HR_MANAGER')
export class AppraisalController {
  constructor(
    private readonly appraisal: AppraisalService,
    private readonly orchestrator: AppraisalOrchestratorService,
    private readonly events: AppraisalEventsService,
  ) {}

  @Post('runs')
  @ApiOperation({ summary: 'Start an autonomous AI appraisal run' })
  async createRun(@CurrentUser() user: HrmPrincipal, @Body() dto: CreateAppraisalRunDto) {
    const run = await this.appraisal.createRun(user, dto);
    // Background execution continues after this response; the captured branch
    // context is re-established inside the orchestrator's own ALS store.
    this.orchestrator.launch(run.id, user, getBranchContext());
    return run;
  }

  @Get('stats')
  @ApiOperation({ summary: 'Appraisal runs by state, and whether one is in flight' })
  stats() {
    return this.appraisal.stats();
  }

  @Get('runs')
  @ApiOperation({ summary: 'List appraisal runs (history)' })
  listRuns(@CurrentUser() user: HrmPrincipal) {
    return this.appraisal.listRuns(user);
  }

  @Get('runs/:id')
  @ApiOperation({ summary: 'Get a run with all employee results' })
  getRun(@CurrentUser() user: HrmPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.appraisal.getRun(user, id);
  }

  @Get('runs/:id/results/:resultId')
  @ApiOperation({ summary: 'Get one employee appraisal result' })
  getResult(
    @CurrentUser() user: HrmPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
  ) {
    return this.appraisal.getResult(user, id, resultId);
  }

  @Post('runs/:id/cancel')
  @ApiOperation({ summary: 'Request cancellation of a running appraisal' })
  async cancel(@CurrentUser() user: HrmPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.appraisal.assertCancellable(user, id);
    this.orchestrator.requestCancel(id);
    return { cancelRequested: true };
  }

  @Delete('runs/:id')
  @ApiOperation({ summary: 'Delete a finished appraisal run' })
  deleteRun(@CurrentUser() user: HrmPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.appraisal.deleteRun(user, id);
  }

  @Get('runs/:id/stream')
  @ApiOperation({ summary: 'Live progress stream (SSE) with replay via ?afterSeq=' })
  async stream(
    @Req() req: any,
    @Res() res: any,
    @CurrentUser() user: HrmPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('afterSeq') afterSeqRaw?: string,
  ) {
    const meta = await this.appraisal.getRunMeta(user, id);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let lastSeq = Number(afterSeqRaw) || 0;
    const write = (e: AppraisalStreamEvent) => {
      if (e.seq <= lastSeq) return;
      lastSeq = e.seq;
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    // Subscribe BEFORE replaying so no live event slips through the gap;
    // buffered live events are flushed after replay (seq guard dedupes).
    const buffer: AppraisalStreamEvent[] = [];
    let replaying = true;
    const unsubscribe = this.events.subscribe(id, (e) => {
      if (replaying) {
        buffer.push(e);
        return;
      }
      write(e);
      if (e.type === 'final') cleanup();
    });
    req.on('close', cleanup);

    try {
      const past = await this.events.replay(id, lastSeq);
      past.forEach(write);
      replaying = false;
      buffer.forEach(write);
      const sawFinal = [...past, ...buffer].some((e) => e.type === 'final');
      if (meta.isTerminal || sawFinal) cleanup();
    } catch {
      cleanup();
    }
  }
}
