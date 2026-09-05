import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { getScopedBranchIds } from '../common/branch/branch-scope.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionClient } from './evolution/evolution.client';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import { WhatsAppOutboxService } from './whatsapp-outbox.service';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { listTemplates, WHATSAPP_TEMPLATES } from './templates/whatsapp-template.registry';
import { isE164, maskPhone, toE164 } from './utils/phone.util';
import { UpdateWhatsAppSettingsDto } from './dto/update-whatsapp-settings.dto';
import {
  QueryIdentitiesDto,
  QueryOutboxDto,
  TestSendDto,
} from './dto/whatsapp-requests.dto';
import {
  buildWebhookUrl,
  ConnectionStateResult,
  QrResult,
  WhatsAppPublicConfig,
  WhatsAppWebhookConfig,
  WHATSAPP_WEBHOOK_EVENTS,
  WHATSAPP_WEBHOOK_HEADER,
  WHATSAPP_WEBHOOK_PATH,
} from './whatsapp.types';

/**
 * Admin-side orchestration: audit trail, branch filtering for the log views, and
 * the connection / test-send helpers. Kept out of the controller so the HTTP
 * layer stays a thin mapping, and out of the delivery services so those have no
 * dependency on request-scoped concepts.
 */
@Injectable()
export class WhatsAppAdminService {
  private readonly logger = new Logger(WhatsAppAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: WhatsAppSettingsService,
    private readonly identities: WhatsAppIdentityService,
    private readonly outbox: WhatsAppOutboxService,
    private readonly evolution: EvolutionClient,
    private readonly audit: AuditService,
  ) {}

  async updateSettings(dto: UpdateWhatsAppSettingsDto, user: any): Promise<WhatsAppPublicConfig> {
    const before = await this.settings.getPublic();
    const after = await this.settings.update(dto);

    // The audit payload records that the key changed, never what it changed to.
    // Which updates were switched on or off is recorded explicitly: it changes
    // what employees receive, so "who turned off payslip alerts" must be answerable.
    void this.audit.log({
      userId: user?.id,
      action: 'WHATSAPP_SETTINGS_UPDATED',
      resourceType: 'WhatsAppSettings',
      oldData: this.auditable(before),
      newData: {
        ...this.auditable(after),
        apiKeyChanged: Boolean(dto.apiKey?.trim()) || Boolean(dto.clearApiKey),
        ...diffTemplates(before.disabledTemplates, after.disabledTemplates),
      },
    });

    return after;
  }

  /**
   * Diagnostics run on credentials alone, not on the `enabled` kill switch —
   * an admin must be able to pair the instance and confirm it is live before
   * turning delivery on. `enabled` is reported separately so the UI can say
   * "connected, but sending is off" instead of conflating the two.
   */
  async connectionState(): Promise<
    ConnectionStateResult & { configured: boolean; sendingEnabled: boolean }
  > {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) {
      return {
        state: 'unknown',
        configured: false,
        sendingEnabled: false,
        error: 'Set the base URL, instance name and API key, then save.',
      };
    }
    return {
      ...(await this.evolution.connectionState(cfg)),
      configured: true,
      sendingEnabled: cfg.enabled,
    };
  }

  async qr(): Promise<QrResult & { configured: boolean }> {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) {
      return { configured: false, error: 'Set the base URL, instance name and API key, then save.' };
    }
    return { ...(await this.evolution.connect(cfg)), configured: true };
  }

  /**
   * The admin list of updates. `enabled` is the runtime switch; `alwaysOff`
   * marks the catch-all, which is governed by its own setting so that turning
   * it "on" here cannot quietly start forwarding every notification.
   */
  async templates() {
    const cfg = await this.settings.get();
    const disabled = new Set(cfg.disabledTemplates);
    return listTemplates().map((t) => ({
      ...t,
      enabled: !disabled.has(t.key),
      requiresCatchAllSetting: t.key === 'generic',
    }));
  }

  /**
   * Render a sample of a template and, unless previewOnly, queue it.
   *
   * The send goes through the outbox rather than straight to Evolution so that
   * an admin test is throttled, retried and logged exactly like real traffic —
   * a test that takes a different code path proves less than it appears to.
   */
  async testSend(dto: TestSendDto, user: any) {
    const cfg = await this.settings.get();
    const templateKey = dto.templateKey || 'generic';
    const template = WHATSAPP_TEMPLATES.get(templateKey);
    if (!template) throw new BadRequestException(`Unknown template '${templateKey}'.`);

    const rawPhone = dto.phone?.trim() || cfg.adminNumber;
    if (!rawPhone) {
      throw new BadRequestException('No number given and no admin number configured.');
    }
    // The admin number is stored as bare digits, so give the parser a '+' to work with.
    const phoneE164 = isE164(rawPhone)
      ? rawPhone
      : toE164(rawPhone.startsWith('+') ? rawPhone : `+${rawPhone.replace(/\D/g, '')}`, cfg.defaultRegion);
    if (!phoneE164) throw new BadRequestException(`Could not parse '${rawPhone}' as a phone number.`);

    const body = template.render({
      recipientName: 'Test Recipient',
      companyName: await this.settings.getCompanyName(),
      appBaseUrl: cfg.appBaseUrl,
      title: 'WhatsApp test message',
      message: 'This is a test from the HR portal. If you can read this, the channel works.',
      link: '/dashboard',
      data: {
        entityLabel: 'Passport',
        subjectName: 'Test Employee',
        expiryDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        daysRemaining: 30,
        fields: [{ label: 'Document no.', value: 'X1234567' }],
        period: 'August 2026',
        status: 'APPROVED',
      },
    });

    if (dto.previewOnly) {
      return { previewOnly: true, phone: maskPhone(phoneE164), templateKey, body };
    }

    const queued = await this.outbox.enqueueDirect({
      toE164: phoneE164,
      templateKey: `test:${templateKey}`,
      body,
      userId: user?.id,
    });

    void this.audit.log({
      userId: user?.id,
      action: 'WHATSAPP_TEST_SEND',
      resourceType: 'WhatsAppMessage',
      resourceId: queued.id,
      newData: { templateKey, to: maskPhone(phoneE164), queued: queued.queued },
    });

    return { ...queued, phone: maskPhone(phoneE164), templateKey, body };
  }

  /**
   * Point Evolution at our webhook and rotate the shared secret in one step.
   *
   * The secret travels in Evolution's arbitrary `headers` map, which it replays
   * on every callback — that is the only authentication the inbound endpoint
   * gets, because Evolution offers no HMAC over the body. It is returned here
   * exactly once and never again.
   */
  async registerWebhook(publicUrl: string, user: any) {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) throw new BadRequestException('Finish the WhatsApp setup first.');

    // An empty body means "use the address configured in settings", which is
    // what the admin page sends. An explicit URL still wins, so a one-off
    // override (a tunnel during development) needs no settings change.
    const target = publicUrl?.trim() || buildWebhookUrl(cfg.publicApiUrl);
    if (!target) {
      throw new BadRequestException(
        'Set the callback address in WhatsApp settings first, or pass one explicitly.',
      );
    }
    if (!/^https?:\/\//i.test(target)) {
      throw new BadRequestException('The callback URL must be absolute.');
    }
    if (process.env.NODE_ENV === 'production' && !/^https:\/\//i.test(target)) {
      // The secret is a bearer credential; over plain HTTP it is readable.
      throw new BadRequestException('The callback URL must use HTTPS.');
    }

    // Registering rotates the secret and writes the callback onto whichever
    // instance `instanceName` names. A typo therefore does not fail — it
    // reconfigures somebody ELSE'S instance and rotates their secret out from
    // under them, while this system goes on rejecting its own traffic. One
    // Evolution server here hosts three tenants, so that is a live hazard, not
    // a theoretical one. Check the name exists before touching anything.
    const known = await this.evolution.listInstanceNames(cfg);
    if (known && !known.includes(cfg.instanceName)) {
      throw new BadRequestException(
        `The account name '${cfg.instanceName}' does not exist on the WhatsApp service. ` +
          `Available: ${known.join(', ') || '(none)'}. Fix the account name under Setup first — ` +
          'registering now would reconfigure a different account and rotate its secret.',
      );
    }

    const secret = await this.settings.rotateWebhookSecret();
    const res = await this.evolution.setWebhook(cfg, {
      url: target,
      secret,
      events: [...WHATSAPP_WEBHOOK_EVENTS],
    });

    void this.audit.log({
      userId: user?.id,
      action: 'WHATSAPP_WEBHOOK_REGISTERED',
      resourceType: 'WhatsAppSettings',
      // `target`, not the request body: the body is empty on the normal path,
      // which would have made every audit row read "url: ''".
      newData: { url: target, ok: res.ok },
    });

    if (!res.ok) throw new BadRequestException(res.error ?? 'Could not register the callback.');
    return {
      ok: true,
      url: target,
      headerName: WHATSAPP_WEBHOOK_HEADER,
      events: [...WHATSAPP_WEBHOOK_EVENTS],
      // Shown once, never retrievable again — the stored copy is encrypted and
      // there is no decrypt-to-UI path. An admin who runs the WhatsApp service
      // by hand needs it to set the header there; one who used the button above
      // can ignore it, since Evolution already has it.
      secret,
    };
  }

  async webhookStatus() {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) return { configured: false };
    const found = await this.evolution.findWebhook(cfg);
    const pub = await this.settings.getPublic();
    return {
      configured: true,
      secretConfigured: pub.webhookSecretConfigured,
      url: found?.url ?? found?.webhook?.url ?? null,
      enabled: found?.enabled ?? found?.webhook?.enabled ?? null,
      events: found?.events ?? found?.webhook?.events ?? [],
    };
  }

  /**
   * Everything the admin page needs to wire inbound up: the address to paste
   * into the WhatsApp service, and whether that service already has it.
   *
   * Answers even when WhatsApp is not configured yet, because the URL is the
   * thing an admin needs BEFORE the connection exists — telling them to finish
   * setup first would be circular.
   */
  async webhookConfig(): Promise<WhatsAppWebhookConfig> {
    const cfg = await this.settings.get();
    const webhookUrl = buildWebhookUrl(cfg.publicApiUrl);

    const base: WhatsAppWebhookConfig = {
      webhookUrl,
      publicApiUrl: cfg.publicApiUrl,
      path: WHATSAPP_WEBHOOK_PATH,
      headerName: WHATSAPP_WEBHOOK_HEADER,
      events: [...WHATSAPP_WEBHOOK_EVENTS],
      secretConfigured: Boolean(cfg.webhookSecret),
      configured: Boolean(cfg.baseUrl && cfg.instanceName && cfg.apiKey),
      registeredUrl: null,
      registeredEnabled: null,
      registeredEvents: [],
      missingEvents: [],
      unknownInstance: null,
      matches: false,
      error: null,
    };

    if (!base.configured) return base;

    // A reachability failure is reported, not thrown: the page still has to
    // render the URL to copy, and "we could not ask" is a different state from
    // "it is not registered".
    try {
      // Asked alongside the webhook rather than only at register time, so a
      // wrong account name is visible on the page instead of only surfacing
      // when somebody presses Connect.
      const known = await this.evolution.listInstanceNames(cfg);
      const unknownInstance =
        known && cfg.instanceName && !known.includes(cfg.instanceName)
          ? { configured: cfg.instanceName, available: known }
          : null;

      const found = await this.evolution.findWebhook(cfg);
      const registeredUrl = found?.url ?? found?.webhook?.url ?? null;
      const registeredEvents: string[] = found?.events ?? found?.webhook?.events ?? [];
      const have = new Set(registeredEvents.map((e) => String(e).toUpperCase()));
      return {
        ...base,
        registeredUrl,
        registeredEnabled: found?.enabled ?? found?.webhook?.enabled ?? null,
        registeredEvents,
        // Only meaningful once we know the service is pointed at us at all;
        // listing "missing" events on somebody else's webhook is noise.
        missingEvents: registeredUrl
          ? WHATSAPP_WEBHOOK_EVENTS.filter((e) => !have.has(e))
          : [],
        unknownInstance,
        matches: Boolean(webhookUrl) && sameUrl(registeredUrl, webhookUrl),
      };
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
  }

  async listIdentities(q: QueryIdentitiesDto, user: any) {
    return this.identities.list({
      search: q.search,
      optedIn: q.optedIn,
      verified: q.verified,
      branchIds: this.branchFilterFor(user),
      skip: q.skip,
      take: q.take,
    });
  }

  /**
   * Delivery log. Recipient numbers are masked; a support view does not need
   * them in the clear, and the log is broader-read than the roster.
   */
  async listOutbox(q: QueryOutboxDto, user: any) {
    const branchIds = this.branchFilterFor(user);

    return runWithBranchBypass(async () => {
      const where: any = {};
      if (q.status) where.status = q.status;
      if (q.templateKey) where.templateKey = q.templateKey;
      if (branchIds) where.branchId = { in: branchIds };

      const take = Math.min(q.take ?? 50, 200);
      const [rows, total] = await Promise.all([
        this.prisma.whatsAppMessage.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: q.skip ?? 0,
          take,
        }),
        this.prisma.whatsAppMessage.count({ where }),
      ]);

      return {
        total,
        rows: rows.map((r) => ({
          id: r.id,
          templateKey: r.templateKey,
          notificationType: r.notificationType,
          to: maskPhone(r.toPhoneE164),
          status: r.status,
          attempts: r.attempts,
          maxAttempts: r.maxAttempts,
          nextAttemptAt: r.nextAttemptAt,
          sentAt: r.sentAt,
          providerMessageId: r.providerMessageId,
          lastError: r.lastError,
          createdAt: r.createdAt,
          bodyPreview: r.body.slice(0, 180),
        })),
      };
    });
  }

  /**
   * Explicit branch isolation.
   *
   * The whatsapp_* tables are intentionally absent from BRANCH_SCOPE (they are
   * read before any branch context exists), so the admin views filter here
   * against the denormalised branch_id instead of relying on the Prisma
   * middleware. Global-access users get null = no filter.
   */
  private branchFilterFor(user: any): string[] | null {
    if (user?.isGlobalBranchAccess) return null;
    const scoped = getScopedBranchIds();
    return scoped && scoped.length ? scoped : null;
  }

  /** Strip anything key-shaped before it reaches an audit row. */
  private auditable(cfg: WhatsAppPublicConfig) {
    const { apiKeyMasked, apiKeyConfigured, apiKeySource, adminNumber, ...rest } = cfg;
    return { ...rest, adminNumber: maskPhone(adminNumber), apiKeyConfigured, apiKeySource };
  }
}

/** Which updates were switched on / off in this save, for the audit row. */
function diffTemplates(before: string[], after: string[]) {
  const b = new Set(before);
  const a = new Set(after);
  const switchedOff = after.filter((k) => !b.has(k));
  const switchedOn = before.filter((k) => !a.has(k));
  return {
    ...(switchedOff.length ? { updatesSwitchedOff: switchedOff } : {}),
    ...(switchedOn.length ? { updatesSwitchedOn: switchedOn } : {}),
  };
}

/**
 * URL equality as an operator means it, not as a string comparison.
 *
 * A trailing slash, a capitalised host or an explicit :443 are the same
 * endpoint, and reporting "not wired up" over one of those would send an admin
 * to re-register a webhook that was already correct. Anything unparseable falls
 * back to an exact compare rather than guessing.
 */
function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.protocol === ub.protocol &&
      ua.host.toLowerCase() === ub.host.toLowerCase() &&
      ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
    );
  } catch {
    return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');
  }
}
