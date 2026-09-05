import { Injectable } from '@nestjs/common';
import { ChannelPrincipalService } from '../../common/channel/channel-principal.service';
import { HrmPrincipal } from '../../mcp/tool.types';
import { maskPhone } from '../utils/phone.util';

/**
 * WhatsApp's view of ChannelPrincipalService.
 *
 * The ordering rules that make an off-HTTP tool call safe live in the shared
 * service — duplicating them per channel is exactly how the second channel ends
 * up subtly wrong. This adds only the WhatsApp-specific detail: the actor ref
 * is a MASKED phone number, because it lands in `audit_logs.userAgent`.
 */
@Injectable()
export class WhatsAppPrincipalService {
  constructor(private readonly principals: ChannelPrincipalService) {}

  async runAs<T>(
    userId: string,
    phoneE164: string | null,
    fn: (user: HrmPrincipal) => Promise<T>,
  ): Promise<T> {
    return this.principals.runAs('whatsapp', maskPhone(phoneE164 ?? ''), userId, fn);
  }

  async runUnauthenticated<T>(phoneE164: string | null, fn: () => Promise<T>): Promise<T> {
    return this.principals.runUnauthenticated('whatsapp', maskPhone(phoneE164 ?? ''), fn);
  }
}
