import { Injectable } from '@nestjs/common';
import { HrmPrincipal } from '../../mcp/tool.types';
import { WaOutbound } from '../router/action.types';

/**
 * The seam a future natural-language layer plugs into. Defined now, bound to a
 * null implementation, so the deterministic router has exactly one place to
 * hand off and the boundary is visible in review.
 *
 * Guardrails, to be preserved by whoever implements it:
 *  - reachable ONLY from the router's no-match branch;
 *  - never as a retry for a failed deterministic action;
 *  - never inside an active flow;
 *  - never for a callback id;
 *  - never in the approval-token path.
 *
 * The implementation belongs in a separate module so WhatsAppModule never
 * depends on LLM code. It maps onto AgentLoopService.run(ctx), which is already
 * transport-agnostic — and because the deterministic path already owns the
 * confirm UI, the AI path inherits confirm-first, server-side arguments, the
 * CAS and the TTL without reimplementing any of it.
 */
export const WHATSAPP_AI_PORT = Symbol('WHATSAPP_AI_PORT');

export interface WhatsAppAiRequest {
  user: HrmPrincipal;
  session: { id: string; remoteJid: string; identityId: string | null };
  text: string;
  /** WhatsAppInboundMessage.id — correlates the reply with the message. */
  correlationId: string;
}

export interface WhatsAppAiPort {
  /**
   * @returns false when the layer declines, in which case the router renders
   * the help menu exactly as if the port were absent.
   */
  handle(
    req: WhatsAppAiRequest,
    emit: (out: WaOutbound) => Promise<void>,
    pend: (toolName: string, args: Record<string, unknown>, preview: unknown) => Promise<void>,
  ): Promise<boolean>;
}

@Injectable()
export class NullWhatsAppAiPort implements WhatsAppAiPort {
  async handle(): Promise<boolean> {
    return false;
  }
}
