import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { ChannelPrincipalService } from '../../common/channel/channel-principal.service';
import { HrmPrincipal } from '../../mcp/tool.types';
import { ToolCallerService } from '../../mcp/tool-caller.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TimezoneService } from '../../common/timezone/timezone.service';
import { ActionRegistryService } from '../../whatsapp/router/action-registry.service';
import { RenderCtx, WhatsAppActionDef } from '../../whatsapp/router/action.types';
import { ChannelVerificationTokenService } from '../../common/verification/channel-verification-token.service';
import {
  VerificationPurpose,
  resolveVerificationMode,
} from '../../common/verification/verification.types';
import { DiscordIdentityService } from '../identity/discord-identity.service';
import { DiscordSettingsService } from '../discord-settings.service';
import { toDiscordMarkdown } from '../render/discord-format';
import {
  buildCommands,
  commandNameToActionKey,
  HELP_COMMAND,
  LINK_COMMAND,
  WHOAMI_COMMAND,
} from './discord-command.registry';

export interface InteractionResult {
  content: string;
  /** Only the invoking user sees it — the default for anything ESS. */
  ephemeral: boolean;
  /**
   * Rendered as a link button under the reply. Used for the one thing Discord
   * cannot do in-chat: collect a GPS position.
   */
  linkButton?: { label: string; url: string };
}

/**
 * Turns one slash command into one reply.
 *
 * The gates are deliberately in the same order as the WhatsApp processor:
 * identify, authorise, act. Nothing calls a tool before a real principal and a
 * real branch context exist, and no business logic lives here — every action
 * resolves to an MCP tool through the shared catalogue.
 */
@Injectable()
export class DiscordInteractionService {
  private readonly logger = new Logger(DiscordInteractionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: DiscordSettingsService,
    private readonly identities: DiscordIdentityService,
    private readonly registry: ActionRegistryService,
    private readonly principals: ChannelPrincipalService,
    private readonly caller: ToolCallerService,
    private readonly audit: AuditService,
    private readonly verificationTokens: ChannelVerificationTokenService,
    private readonly tzSvc: TimezoneService,
  ) {}

  async handleCommand(args: {
    commandName: string;
    options: Record<string, string>;
    discordUserId: string;
    discordTag: string | null;
  }): Promise<InteractionResult> {
    const cfg = await this.settings.get();
    if (!cfg.inboundEnabled) {
      return this.reply('HR commands are not switched on yet.');
    }

    const { commandName, options, discordUserId, discordTag } = args;

    // Linking is the one command available before an identity exists.
    if (commandName === LINK_COMMAND) {
      if (!cfg.linkingEnabled) return this.reply('Account linking is currently turned off.');
      return this.handleLink(discordUserId, discordTag, options.code ?? '');
    }

    const identity = await this.identities.findActive(discordUserId);
    if (!identity) {
      // Identical reply whatever the reason — unlinked, revoked, or never
      // known. Never let the command surface be an oracle for who works here.
      return this.reply(
        'This Discord account is not linked to an HR profile.\n' +
          'Open the HR portal → Profile → Discord to get a code, then run `/link <code>`.',
      );
    }
    void this.identities.touch(identity.id);

    if (commandName === WHOAMI_COMMAND) return this.handleWhoami(identity.userId);
    if (commandName === HELP_COMMAND) return this.handleHelp(identity.userId, cfg);

    const actionKey = commandNameToActionKey(commandName, this.registry.getAll());
    const action = actionKey ? this.registry.getByKey(actionKey) : undefined;
    if (!action) return this.reply('That command is not available.');

    return this.runAction(action, identity, cfg);
  }

  // ------------------------------------------------------------------ actions

  private async runAction(
    action: WhatsAppActionDef,
    identity: { id: string; userId: string; discordUserId: string },
    cfg: any,
  ): Promise<InteractionResult> {
    if (!action.tool) return this.reply('That command is not available.');

    return this.principals
      .runAs('discord', identity.discordUserId, identity.userId, async (user) => {
        if (!action.roles.includes(user.role as any)) {
          return this.reply('You do not have access to that.');
        }
        if (action.requiresEmployee && !user.employeeId) {
          return this.reply('Your account is not linked to an employee record.');
        }

        const isWrite = action.confirmPolicy !== 'none';
        if (isWrite && !cfg.mutationsEnabled) {
          return this.reply('Changes are not available from Discord yet — please use the HR portal.');
        }

        // Same preflight the WhatsApp channel runs, so a policy the channel
        // cannot satisfy reads as guidance rather than a raw domain exception.
        if (action.preflight) {
          // Set only when the action needs something Discord cannot carry —
          // a position, a camera frame, or both.
          let verifyUrl: string | null = null;
          let verifyLabel = 'Continue in browser';

          const getSetting = (key: string, fallback = '') =>
            this.prisma.systemSetting
              .findUnique({ where: { key } })
              .then((r) => r?.value ?? fallback)
              .catch(() => fallback);

          const geofenceRequired = await this.geofenceRequired(user);
          // The same resolver AttendancesService reads through, so the
          // preflight cannot promise something the service then refuses.
          const verificationMode = await resolveVerificationMode(
            getSetting,
            purposeOf(action.key),
          );

          const refusal = await action.preflight({
            getSetting,
            hasEmployee: Boolean(user.employeeId),
            geofenceRequired,
            verificationMode,
            todayStatus: () => this.todayStatus(user),
            timeZone: await this.timeZoneFor(user),
            faceProofPrompt: async () => {
              verifyLabel = 'Verify and continue';
              verifyUrl = await this.issueVerificationLink(action, identity, user, {
                requireFace: true,
                requireLocation: geofenceRequired,
                ttlMinutes: cfg.verificationLinkTtlMinutes,
              });
              return (
                'Your company checks who is punching in, and Discord has no camera.\n' +
                `Open this once to take a photo${geofenceRequired ? ' and share your location' : ''}: ${verifyUrl}\n` +
                '_The link works once and expires shortly._'
              );
            },
            locationPrompt: async () => {
              verifyLabel = 'Check in with location';
              verifyUrl = await this.issueVerificationLink(action, identity, user, {
                requireFace: false,
                requireLocation: true,
                ttlMinutes: cfg.verificationLinkTtlMinutes,
              });
              return (
                'Your branch checks where you are when you check in, and Discord ' +
                'cannot share a location.\n' +
                `Open this once and it will check you in: ${verifyUrl}\n` +
                '_The link works once and expires shortly._'
              );
            },
          });

          if (refusal) {
            return verifyUrl
              ? { ...this.reply(refusal), linkButton: { label: verifyLabel, url: verifyUrl } }
              : this.reply(refusal);
          }
        }

        // A slash command is a single deliberate act with no arguments to
        // preview, so writes confirm on the first call — the same reasoning
        // that lets `CHECK IN` auto-confirm on WhatsApp. Anything that needs a
        // preview has a flow, and flows are not exposed as slash commands.
        const payload = await this.caller.call(user, action.tool!.name, {
          ...(action.tool!.staticArgs ?? {}),
          ...(isWrite ? { confirm: true } : {}),
        });

        if (payload?.error) return this.reply(this.renderError(payload));

        const ctx = await this.renderCtx(user);
        const out = action.render(payload, ctx);
        return this.reply(toDiscordMarkdown(out.plain));
      })
      .catch(async (e) => {
        if ((e as any)?.status === 401 || /inactive|not found/i.test((e as Error).message ?? '')) {
          await this.identities.revoke(identity.userId);
          return this.reply('This Discord account is no longer linked to an active HR profile.');
        }
        this.logger.error(`Discord action ${action.key} failed: ${(e as Error).message}`);
        return this.reply('Something went wrong at our end.');
      });
  }

  // -------------------------------------------------------------------- link

  private async handleLink(
    discordUserId: string,
    discordTag: string | null,
    code: string,
  ): Promise<InteractionResult> {
    const res = await this.identities.redeemLink(discordUserId, discordTag, code);
    if (!res.ok) return this.reply(res.reason);

    const employee = await this.prisma.user.findUnique({
      where: { id: res.userId },
      select: { email: true, employee: { select: { fullName: true } } },
    });
    return this.reply(
      `**Linked**\nThis Discord account is now connected to ` +
        `${employee?.employee?.fullName ?? employee?.email ?? 'your HR profile'}.\n` +
        'Run `/help` to see what you can do.',
    );
  }

  private async handleWhoami(userId: string): Promise<InteractionResult> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        role: true,
        employee: { select: { fullName: true, employeeCode: true, branch: { select: { name: true } } } },
      },
    });
    return this.reply(
      [
        '**Your HR profile**',
        `Name: ${u?.employee?.fullName ?? '—'}`,
        `Employee: ${u?.employee?.employeeCode ?? '—'}`,
        `Branch: ${u?.employee?.branch?.name ?? '—'}`,
        `Role: ${u?.role ?? '—'}`,
      ].join('\n'),
    );
  }

  private async handleHelp(userId: string, cfg: any): Promise<InteractionResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, employeeId: true },
    });
    const disabled = new Set<string>();
    if (!cfg.mutationsEnabled) {
      for (const a of this.registry.getAll()) if (a.confirmPolicy !== 'none') disabled.add(a.key);
    }
    const visible = this.registry
      .visibleFor(user?.role ?? 'EMPLOYEE', Boolean(user?.employeeId), disabled)
      .filter((a) => !a.flow && !a.needsActionToken);

    const commands = buildCommands(visible).filter(
      (c) => ![LINK_COMMAND, WHOAMI_COMMAND, HELP_COMMAND].includes(c.name),
    );
    return this.reply(
      ['**HR commands**', ...commands.map((c) => `\`/${c.name}\` — ${c.description}`)].join('\n'),
    );
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Today's attendance, via the same tool the `/attendance-today` command uses.
   *
   * Never throws: this only shapes a message, so a read that fails should let
   * the action proceed and be judged by the service, not block it.
   */
  private async todayStatus(
    user: HrmPrincipal,
  ): Promise<{ checkIn?: unknown; checkOut?: unknown } | null> {
    try {
      const payload = await this.caller.call(user, 'attendance_today_status', {});
      if (payload?.error) return null;
      return (payload?.data ?? payload) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Mint the one-time browser link for whatever this punch has to prove.
   *
   * For a check-in the tool is taken from `attendance.checkin_location` rather
   * than from the action that triggered this, so a link that carries
   * coordinates can only ever perform a check-in with coordinates — the browser
   * adds a position and a photo, never a choice of what happens.
   *
   * Both proofs go in ONE link because the capability is single-use: two round
   * trips would need two of them, and the second could be answered by somebody
   * standing somewhere else.
   */
  private async issueVerificationLink(
    action: WhatsAppActionDef,
    identity: { id: string; userId: string },
    user: { employeeId?: string | null },
    opts: { requireFace: boolean; requireLocation: boolean; ttlMinutes: number },
  ): Promise<string> {
    // The action itself is the target: the tool call carries the coordinates,
    // and the old coordinate-carrying twin action was retired with the
    // WhatsApp location attachment.
    const target = action;

    const { token } = await this.verificationTokens.issue({
      channel: 'discord',
      deliveryMode: 'LINK',
      identityId: identity.id,
      userId: identity.userId,
      employeeId: user.employeeId ?? null,
      purpose: purposeOf(target.key),
      requireFace: opts.requireFace,
      requireLocation: opts.requireLocation,
      actionKey: target.key,
      toolName: target.tool!.name,
      args: target.tool!.staticArgs ?? {},
      // Long enough to unlock a phone and allow the prompt, short enough that a
      // link left visible in a channel is dead before anyone acts on it.
      ttlSeconds: opts.ttlMinutes * 60,
    });
    return `${await this.appBaseUrl()}/verify/${token}`;
  }

  private async appBaseUrl(): Promise<string> {
    return this.prisma.systemSetting
      .findUnique({ where: { key: 'whatsapp.appBaseUrl' } })
      .then((r) => r?.value || process.env.FRONTEND_URL || 'http://localhost:3000')
      .catch(() => process.env.FRONTEND_URL || 'http://localhost:3000');
  }

  /**
   * Mirrors the WhatsApp processor. Read directly rather than through
   * SystemSettingsModule, to keep this module's dependency graph flat.
   */
  private async geofenceRequired(user: HrmPrincipal): Promise<boolean> {
    if (!user.employeeId) return false;
    const employee = await this.prisma.employee.findUnique({
      where: { id: user.employeeId },
      select: { branch: { select: { geofencingEnabled: true } } },
    });
    const branch = employee?.branch;
    return Boolean(
      branch?.geofencingEnabled != null
        ? branch.geofencingEnabled
        : await this.prisma.systemSetting
            .findUnique({ where: { key: 'geofencing_enabled' } })
            .then((r) => r?.value === 'true')
            .catch(() => false),
    );
  }

  private async renderCtx(user: HrmPrincipal): Promise<RenderCtx> {
    const [employee, symbol, appBaseUrl] = await Promise.all([
      user.employeeId
        ? this.prisma.employee.findUnique({
            where: { id: user.employeeId },
            select: { fullName: true, timezone: true },
          })
        : Promise.resolve(null),
      this.prisma.systemSetting
        .findUnique({ where: { key: 'payroll_currency_symbol' } })
        .then((r) => r?.value ?? '')
        .catch(() => ''),
      this.prisma.systemSetting
        .findUnique({ where: { key: 'whatsapp.appBaseUrl' } })
        .then((r) => r?.value ?? process.env.FRONTEND_URL ?? 'http://localhost:3000')
        .catch(() => 'http://localhost:3000'),
    ]);
    return {
      employeeId: user.employeeId ?? null,
      recipientName: employee?.fullName ?? user.email ?? '',
      appBaseUrl,
      currencySymbol: symbol,
      timeZone: await this.tzSvc.getEffectiveTZ(employee?.timezone ?? null),
      args: {},
    };
  }

  /**
   * The zone every date and time in a reply is rendered in.
   *
   * Attendance is stored as UTC instants, so without this a check-in at 20:26
   * in Chennai reads back as 14:56.
   */
  private async timeZoneFor(user: HrmPrincipal): Promise<string> {
    const employee = user.employeeId
      ? await this.prisma.employee
          .findUnique({ where: { id: user.employeeId }, select: { timezone: true } })
          .catch(() => null)
      : null;
    return this.tzSvc.getEffectiveTZ(employee?.timezone ?? null);
  }

  /** Never a stack trace or Prisma text — the user cannot act on either. */
  private renderError(payload: any): string {
    const err = payload?.error ?? {};
    const status = Number(err.status ?? 0);
    const code = String(err.code ?? '');
    if (status === 403 || code === 'Forbidden') return 'You do not have access to that.';
    if (status === 404 || code === 'NotFound' || code === 'UnknownTool') return 'I could not find that.';
    if (status === 400 || code === 'ValidationError') {
      return String(err.message || 'That request was not valid.');
    }
    this.logger.error(`Discord tool error: ${status} ${code} ${err.message ?? ''}`);
    return 'Something went wrong at our end.';
  }

  private reply(content: string): InteractionResult {
    // Ephemeral by default: ESS replies carry attendance times, leave balances
    // and pay periods, and a slash command is often run in a shared channel.
    return { content: content.slice(0, 2000), ephemeral: true };
  }
}

/**
 * Which punch an action performs.
 *
 * Mirrors the WhatsApp map deliberately: it binds a verification proof to one
 * specific act, and that binding is the runtime's to decide rather than the
 * shared catalogue's to declare.
 */
const ACTION_PURPOSES: Record<string, VerificationPurpose> = {
  'attendance.checkin': 'CHECKIN',
  'attendance.checkout': 'CHECKOUT',
  'attendance.lunch_start': 'LUNCH_OUT',
  'attendance.lunch_end': 'LUNCH_IN',
};

function purposeOf(actionKey: string): VerificationPurpose {
  return ACTION_PURPOSES[actionKey] ?? 'CHECKIN';
}
