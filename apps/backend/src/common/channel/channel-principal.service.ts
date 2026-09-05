import { Injectable } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service';
import { runWithBranchStore, setBranchContext } from '../branch/branch-context';
import { resolveBranchContext } from '../branch/branch-scope.util';
import { ActorChannelName, runWithChannel } from '../context/channel-context';
import { HrmPrincipal } from '../../mcp/tool.types';

/**
 * Run work as a real authenticated user from a non-HTTP channel.
 *
 * Extracted from the first channel implementation so a second channel cannot
 * get this subtly wrong. The ORDER is the whole job, and it mirrors HTTP exactly:
 *
 *  1. Build the principal FIRST, with a null branch context — otherwise the
 *     Prisma `$use` middleware would scope the very lookup that establishes
 *     scope.
 *  2. Only then set the branch context, because ToolExecutorService fail-closes
 *     with `BranchContextMissing` if it is still null when a tool runs.
 *
 * The ALS store is opened HERE rather than in a controller: channel processing
 * is detached from the HTTP response, and the request's store ends when that
 * response is sent.
 */
@Injectable()
export class ChannelPrincipalService {
  constructor(private readonly auth: AuthService) {}

  /**
   * @param ref short, non-sensitive actor id for the audit trail (a masked
   *            phone, an external account id) — never a full phone number.
   * @throws UnauthorizedException when the user is missing or deactivated.
   */
  async runAs<T>(
    channel: ActorChannelName,
    ref: string,
    userId: string,
    fn: (user: HrmPrincipal) => Promise<T>,
  ): Promise<T> {
    return runWithBranchStore(async () =>
      runWithChannel({ channel, ref }, async () => {
        // Rebuilt per message, never cached: a deactivated account or a revoked
        // branch grant takes effect on the very next interaction.
        const user = (await this.auth.buildPrincipal(userId)) as HrmPrincipal;

        // No X-Branch-Id equivalent off HTTP, so `requested` is undefined: the
        // caller gets their own envelope and nothing wider.
        const { ctx } = resolveBranchContext(user as any, undefined);
        setBranchContext(ctx);

        return fn(user);
      }),
    );
  }

  /**
   * For work with no principal yet — resolving who an account belongs to, or
   * replying to a stranger. Branch context stays null, which makes the `$use`
   * middleware pass through exactly as it does before login on HTTP.
   *
   * Never call a tool from in here: with a null context the executor fail-closes.
   */
  async runUnauthenticated<T>(
    channel: ActorChannelName,
    ref: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return runWithBranchStore(async () => runWithChannel({ channel, ref }, fn));
  }
}
