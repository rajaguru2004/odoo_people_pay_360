import { AsyncLocalStorage } from 'async_hooks';

/**
 * Which channel the current actor is acting through.
 *
 * Modelled on `common/branch/branch-context.ts` and for the same reason: the
 * information is needed deep inside code (the MCP audit helper) that has no
 * request handle and whose signature cannot grow a parameter without touching
 * every call site.
 *
 * Stamping it here means every existing audit path — web, /mcp over HTTP, the
 * copilot — records its channel with no migration and no changes at the call
 * sites.
 */
export type ActorChannelName = 'web' | 'mcp' | 'copilot' | 'system';

export interface ActorChannel {
  channel: ActorChannelName;
  /**
   * Short, non-sensitive identifier for the specific actor within the channel —
   * a conversation id for the copilot, say. Never a full phone number: it lands
   * in `audit_logs.userAgent`.
   */
  ref?: string;
}

const als = new AsyncLocalStorage<ActorChannel>();

export function runWithChannel<T>(ctx: ActorChannel, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function getActorChannel(): ActorChannel | null {
  return als.getStore() ?? null;
}

/** `copilot/c-8f21`, for the audit row's userAgent column. */
export function channelUserAgent(): string | undefined {
  const c = getActorChannel();
  if (!c) return undefined;
  return c.ref ? `${c.channel}/${c.ref}` : c.channel;
}
