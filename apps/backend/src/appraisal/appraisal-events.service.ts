import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppraisalStreamEvent } from './appraisal.types';

type Listener = (e: AppraisalStreamEvent) => void;

/**
 * Progress-event hub for appraisal runs. Every event is persisted (monotonic
 * `seq` per run) so SSE clients can replay after a reconnect or page refresh,
 * then fanned out to live in-process subscribers. Single-process by design —
 * matches the rest of this backend (no queue/socket infra).
 */
@Injectable()
export class AppraisalEventsService {
  private readonly logger = new Logger(AppraisalEventsService.name);
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly seqs = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async emit(
    runId: string,
    type: AppraisalStreamEvent['type'],
    payload: Record<string, unknown> = {},
  ): Promise<AppraisalStreamEvent> {
    const seq = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, seq);
    const event: AppraisalStreamEvent = {
      seq,
      type,
      at: new Date().toISOString(),
      ...payload,
    };
    try {
      await this.prisma.appraisalEvent.create({
        data: { runId, seq, type, payload: payload as any },
      });
    } catch (e) {
      // Never let event persistence kill the run — live subscribers still get it.
      this.logger.warn(`persist event failed (run ${runId} seq ${seq}): ${(e as Error).message}`);
    }
    const subs = this.listeners.get(runId);
    if (subs) for (const fn of subs) fn(event);
    return event;
  }

  subscribe(runId: string, fn: Listener): () => void {
    let subs = this.listeners.get(runId);
    if (!subs) {
      subs = new Set();
      this.listeners.set(runId, subs);
    }
    subs.add(fn);
    return () => {
      subs!.delete(fn);
      if (!subs!.size) this.listeners.delete(runId);
    };
  }

  async replay(runId: string, afterSeq = 0): Promise<AppraisalStreamEvent[]> {
    const rows = await this.prisma.appraisalEvent.findMany({
      where: { runId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type as AppraisalStreamEvent['type'],
      at: r.createdAt.toISOString(),
      ...(r.payload as Record<string, unknown>),
    }));
  }

  /** Drop the in-memory seq counter once a run reaches a terminal state. */
  release(runId: string): void {
    this.seqs.delete(runId);
  }
}
