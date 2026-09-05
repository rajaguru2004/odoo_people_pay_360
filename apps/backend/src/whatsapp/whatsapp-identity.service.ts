import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionClient } from './evolution/evolution.client';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { firstRegion, isE164, maskPhone, normalisePhoneRegion, toE164 } from './utils/phone.util';
import { IDENTITY_SOURCE, IdentitySource } from './whatsapp.types';

export interface MyWhatsAppStatus {
  linked: boolean;
  phoneMasked: string;
  optedIn: boolean;
  verified: boolean;
  source: string | null;
  optedInAt: Date | null;
  /** Whether the HR profile holds a phone we could pre-fill the form with. */
  hasProfilePhone: boolean;
  profilePhoneMasked: string;
  /** PENDING | ACTIVE | BLOCKED | REVOKED. ACTIVE means the handset can ACT. */
  status: string | null;
  pinSet: boolean;
  enrollmentEnabled: boolean;
  inboundEnabled: boolean;
  requirePinForSensitive: boolean;
}

export interface OptInPreview {
  phoneE164: string;
  phoneMasked: string;
  /** null when the gateway is off or the lookup failed — never assume "no". */
  existsOnWhatsApp: boolean | null;
  alreadyLinkedToAnotherUser: boolean;
}

/**
 * WhatsApp delivery identities: normalisation, consent and number verification.
 *
 * Two states are tracked separately on purpose. `verified` is provider-derived
 * ("this number exists on WhatsApp"); `optedIn` is human consent. A number can
 * be real and unconsented, or consented and wrong, and conflating them is how
 * you end up messaging a stranger.
 */
@Injectable()
export class WhatsAppIdentityService {
  private readonly logger = new Logger(WhatsAppIdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: WhatsAppSettingsService,
    private readonly evolution: EvolutionClient,
  ) {}

  // ------------------------------------------------------------ self-service

  async getMine(userId: string): Promise<MyWhatsAppStatus> {
    return runWithBranchBypass(async () => {
      const [identity, user] = await Promise.all([
        this.prisma.whatsAppIdentity.findFirst({
          where: { userId },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { employee: { select: { phone: true } } },
        }),
      ]);

      const profilePhone = user?.employee?.phone ?? '';
      const cfg = await this.settings.get();
      return {
        linked: Boolean(identity),
        phoneMasked: identity ? maskPhone(identity.phoneE164) : '',
        optedIn: identity?.optedIn ?? false,
        verified: identity?.verified ?? false,
        source: identity?.source ?? null,
        optedInAt: identity?.optedInAt ?? null,
        hasProfilePhone: Boolean(profilePhone),
        profilePhoneMasked: profilePhone ? maskPhone(profilePhone) : '',
        // Two-way state. ACTIVE means this handset can ACT, not merely receive
        // — the distinction the profile page has to make visible, because
        // opting in and linking are two different decisions.
        status: identity?.status ?? null,
        pinSet: Boolean(identity?.pinHash),
        // Channel-level switches, so the page can hide what is unavailable
        // rather than offering a button that answers "not switched on".
        enrollmentEnabled: cfg.enrollmentEnabled,
        inboundEnabled: cfg.inboundEnabled,
        requirePinForSensitive: cfg.requirePinForSensitive,
      };
    });
  }

  /**
   * Step 1 of opt-in: normalise and check, but record nothing.
   *
   * The resolved E.164 is echoed back so a human confirms the exact number
   * before consent is stored. That confirmation is what makes a normalisation
   * mistake a visible correction rather than a message to a stranger.
   */
  async previewOptIn(userId: string, rawPhone: string): Promise<OptInPreview> {
    const region = await this.resolveRegion(userId);
    const phoneE164 = toE164(rawPhone, region);
    if (!phoneE164) {
      throw new BadRequestException(
        region
          ? 'That does not look like a valid phone number. Include the country code, e.g. +96890010000.'
          : 'Could not determine your country. Enter the number in full international format, e.g. +96890010000.',
      );
    }

    const owner = await runWithBranchBypass(() =>
      this.prisma.whatsAppIdentity.findUnique({
        where: { phoneE164 },
        select: { userId: true },
      }),
    );

    return {
      phoneE164,
      phoneMasked: maskPhone(phoneE164),
      existsOnWhatsApp: await this.checkExists(phoneE164),
      alreadyLinkedToAnotherUser: Boolean(owner && owner.userId !== userId),
    };
  }

  /** Step 2 of opt-in: store consent against the number the user just confirmed. */
  async confirmOptIn(
    userId: string,
    phoneE164: string,
    source: IdentitySource = IDENTITY_SOURCE.SELF,
  ): Promise<MyWhatsAppStatus> {
    if (!isE164(phoneE164)) {
      throw new BadRequestException('Confirm the number shown in the previous step.');
    }
    const exists = await this.checkExists(phoneE164);
    // A definite "no" is worth blocking on; an unknown (gateway off / lookup
    // failed) must not stop an admin from linking a number they trust.
    if (exists === false) {
      throw new BadRequestException('That number is not registered on WhatsApp.');
    }

    return runWithBranchBypass(async () => {
      const owner = await this.prisma.whatsAppIdentity.findUnique({ where: { phoneE164 } });
      if (owner && owner.userId !== userId) {
        throw new ConflictException('That number is already linked to another account.');
      }

      const employee = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { employeeId: true, employee: { select: { branchId: true } } },
      });

      const now = new Date();
      const data = {
        userId,
        employeeId: employee?.employeeId ?? null,
        branchId: employee?.employee?.branchId ?? null,
        phoneE164,
        source,
        optedIn: true,
        optedInAt: now,
        optedOutAt: null,
        verified: exists === true,
        verifiedAt: exists === true ? now : null,
        lastCheckedAt: now,
        failureCount: 0,
        lastError: null,
      };

      // One row per user in Phase 1: re-linking replaces the number rather than
      // accumulating identities (multi-number support arrives with Phase 2).
      const existing = await this.prisma.whatsAppIdentity.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (existing) {
        await this.prisma.whatsAppIdentity.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.whatsAppIdentity.create({ data });
      }

      return this.getMine(userId);
    });
  }

  /** Consent is withdrawn, but the row stays — opt-out history is a compliance artifact. */
  async optOut(userId: string): Promise<MyWhatsAppStatus> {
    await runWithBranchBypass(() =>
      this.prisma.whatsAppIdentity.updateMany({
        where: { userId, optedIn: true },
        data: { optedIn: false, optedOutAt: new Date() },
      }),
    );
    return this.getMine(userId);
  }

  // -------------------------------------------------------------------- admin

  async stats(): Promise<{
    total: number;
    optedIn: number;
    verified: number;
    deliverable: number;
    suspended: number;
  }> {
    return runWithBranchBypass(async () => {
      const [total, optedIn, verified, deliverable, suspended] = await Promise.all([
        this.prisma.whatsAppIdentity.count(),
        this.prisma.whatsAppIdentity.count({ where: { optedIn: true } }),
        this.prisma.whatsAppIdentity.count({ where: { verified: true } }),
        this.prisma.whatsAppIdentity.count({ where: { optedIn: true, verified: true } }),
        this.prisma.whatsAppIdentity.count({ where: { failureCount: { gte: 5 } } }),
      ]);
      return { total, optedIn, verified, deliverable, suspended };
    });
  }

  /**
   * Make the users in this batch reachable on the number HR already holds.
   *
   * Called from the outbox on the way to sending, so that switching the channel
   * on in the admin panel is genuinely all it takes — which is how the product
   * is meant to work. Nothing here asks the employee anything.
   *
   * Two rules keep that from becoming a compliance problem:
   *
   *  - It only ever CREATES. A user who already has an identity is left exactly
   *    as it is, so an explicit opt-out (row present, `optedIn: false`) is never
   *    resurrected by the next notification.
   *  - Numbers are confirmed against WhatsApp in one batched call before they
   *    are written, so a mistyped HR number does not become a message to a
   *    stranger. An unreachable gateway writes nothing and simply retries on the
   *    next notification.
   *
   * Returns the number of identities created. Never throws: a failure here must
   * degrade to "nobody new was enrolled", not take the notification down.
   */
  async autoEnrollUsers(userIds: string[]): Promise<number> {
    if (!userIds.length) return 0;

    try {
      return await runWithBranchBypass(async () => {
        const existing = await this.prisma.whatsAppIdentity.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true },
        });
        const known = new Set(existing.map((e) => e.userId));
        const missing = userIds.filter((id) => !known.has(id));
        if (!missing.length) return 0;

        const users = await this.prisma.user.findMany({
          where: { id: { in: missing }, employee: { phone: { not: null }, status: 'ACTIVE' } },
          select: {
            id: true,
            employeeId: true,
            employee: { select: { id: true, phone: true, branchId: true } },
          },
        });
        if (!users.length) return 0;

        const candidates: Array<{ userId: string; employeeId: string; branchId: string | null; e164: string }> = [];
        const seen = new Set<string>();
        for (const u of users) {
          const region = await this.resolveRegion(u.id);
          const e164 = toE164(u.employee?.phone, region);
          // A number two employees share cannot identify either of them.
          if (!e164 || seen.has(e164)) continue;
          seen.add(e164);
          candidates.push({
            userId: u.id,
            employeeId: u.employee!.id,
            branchId: u.employee?.branchId ?? null,
            e164,
          });
        }
        if (!candidates.length) return 0;

        const cfg = await this.settings.ensureCredentials();
        if (!cfg) return 0;
        const existence = await this.evolution.checkNumbers(
          cfg,
          candidates.map((c) => c.e164),
        );

        const now = new Date();
        let created = 0;
        for (const c of candidates) {
          const hit = existence.get(c.e164);
          if (!hit?.exists) continue;

          // Another employee may already hold this number.
          const owner = await this.prisma.whatsAppIdentity.findUnique({
            where: { phoneE164: c.e164 },
            select: { id: true },
          });
          if (owner) continue;

          try {
            await this.prisma.whatsAppIdentity.create({
              data: {
                userId: c.userId,
                employeeId: c.employeeId,
                branchId: c.branchId,
                phoneE164: c.e164,
                // Records WHY this row exists: the number came from the HR
                // record under an admin-enabled channel, not from the employee.
                source: IDENTITY_SOURCE.EMPLOYEE_PHONE,
                optedIn: true,
                optedInAt: now,
                verified: true,
                verifiedAt: now,
                waJid: hit.jid ?? null,
                lastCheckedAt: now,
              },
            });
            created++;
          } catch {
            // Lost a race on the unique number — somebody else has it now.
          }
        }

        if (created) {
          this.logger.log(`Auto-enrolled ${created} WhatsApp recipient(s) from employee records.`);
        }
        return created;
      });
    } catch (e) {
      this.logger.warn(`Auto-enrolment skipped: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * Turn the phone numbers already on employee records into delivery identities.
   *
   * This exists because there was no way to do it. `IDENTITY_SOURCE.ADMIN` was
   * declared but nothing ever wrote it: the only routes to an identity were an
   * employee opting in from their own profile and the inbound webhook. So a
   * tenant with eleven employees, eleven phone numbers on file and a correctly
   * configured channel still delivered to nobody, and nothing in the product
   * said why.
   *
   * `commit: false` (the default) reports exactly what would happen and writes
   * nothing — the same shape as the standalone backfill script, which this
   * replaces for operators who do not have a shell.
   *
   * Consent: rows are written `optedIn` with `source: ADMIN`, which records that
   * the EMPLOYER asserted it rather than the employee. That is a real decision,
   * so the caller has to pass `confirmConsent` to make it; without it the numbers
   * are linked and verified but left opted OUT, which delivers nothing until each
   * person opts in from their profile.
   */
  async enrollFromEmployeePhones(opts: {
    commit?: boolean;
    confirmConsent?: boolean;
    employeeIds?: string[];
  }): Promise<{
    committed: boolean;
    optedIn: boolean;
    considered: number;
    results: Array<{
      employeeId: string;
      employeeCode: string | null;
      name: string;
      phoneMasked: string;
      outcome: 'linked' | 'updated' | 'skipped';
      verified: boolean;
      reason?: string;
    }>;
  }> {
    const commit = Boolean(opts.commit);
    const optIn = Boolean(opts.confirmConsent);

    return runWithBranchBypass(async () => {
      const employees = await this.prisma.employee.findMany({
        where: {
          status: 'ACTIVE',
          phone: { not: null },
          user: { isNot: null },
          ...(opts.employeeIds?.length ? { id: { in: opts.employeeIds } } : {}),
        },
        select: {
          id: true,
          employeeCode: true,
          fullName: true,
          phone: true,
          branchId: true,
          user: { select: { id: true } },
        },
        orderBy: { employeeCode: 'asc' },
      });

      const results: Array<{
        employeeId: string;
        employeeCode: string | null;
        name: string;
        phoneMasked: string;
        outcome: 'linked' | 'updated' | 'skipped';
        verified: boolean;
        reason?: string;
      }> = [];

      // Resolved first so a number that appears twice across employees is a
      // reported conflict rather than a unique-constraint crash mid-run: one
      // WhatsApp account must map to exactly one person, or an employee reads
      // somebody else's leave decisions.
      const parsed: Array<{ emp: (typeof employees)[number]; e164: string }> = [];
      const seen = new Map<string, string>();

      for (const emp of employees) {
        const region = await this.resolveRegion(emp.user!.id);
        const e164 = toE164(emp.phone, region);
        if (!e164) {
          results.push({
            employeeId: emp.id,
            employeeCode: emp.employeeCode,
            name: emp.fullName,
            phoneMasked: emp.phone ?? '',
            outcome: 'skipped',
            verified: false,
            reason: region
              ? `“${emp.phone}” is not a valid number for ${region}. Fix it on their profile.`
              : `“${emp.phone}” has no country code and no country could be determined.`,
          });
          continue;
        }
        const clash = seen.get(e164);
        if (clash) {
          results.push({
            employeeId: emp.id,
            employeeCode: emp.employeeCode,
            name: emp.fullName,
            phoneMasked: maskPhone(e164),
            outcome: 'skipped',
            verified: false,
            reason: `Shares a number with ${clash}. One WhatsApp account can belong to only one person.`,
          });
          continue;
        }
        seen.set(e164, emp.fullName);
        parsed.push({ emp, e164 });
      }

      // One batched lookup rather than one call per employee — the same reason
      // verifyPending() batches.
      const cfg = await this.settings.ensureCredentials();
      const existence = cfg
        ? await this.evolution.checkNumbers(cfg, parsed.map((p) => p.e164))
        : new Map<string, { exists: boolean; jid?: string }>();

      const now = new Date();
      for (const { emp, e164 } of parsed) {
        const hit = existence.get(e164);
        const verified = hit?.exists === true;

        if (hit?.exists === false) {
          results.push({
            employeeId: emp.id,
            employeeCode: emp.employeeCode,
            name: emp.fullName,
            phoneMasked: maskPhone(e164),
            outcome: 'skipped',
            verified: false,
            reason: 'That number is not registered on WhatsApp.',
          });
          continue;
        }

        const owner = await this.prisma.whatsAppIdentity.findUnique({ where: { phoneE164: e164 } });
        if (owner && owner.userId !== emp.user!.id) {
          results.push({
            employeeId: emp.id,
            employeeCode: emp.employeeCode,
            name: emp.fullName,
            phoneMasked: maskPhone(e164),
            outcome: 'skipped',
            verified: false,
            reason: 'Already linked to a different account.',
          });
          continue;
        }

        const existing = await this.prisma.whatsAppIdentity.findFirst({
          where: { userId: emp.user!.id },
          orderBy: { createdAt: 'asc' },
        });

        // Never revoke consent somebody gave themselves: an employee who opted
        // in from their profile keeps that, and a re-run cannot quietly undo it.
        const data = {
          userId: emp.user!.id,
          employeeId: emp.id,
          branchId: emp.branchId ?? null,
          phoneE164: e164,
          source: existing?.source ?? IDENTITY_SOURCE.ADMIN,
          optedIn: optIn || Boolean(existing?.optedIn),
          optedInAt: optIn || existing?.optedIn ? (existing?.optedInAt ?? now) : null,
          optedOutAt: optIn ? null : (existing?.optedOutAt ?? null),
          verified,
          verifiedAt: verified ? now : null,
          waJid: hit?.jid ?? null,
          lastCheckedAt: cfg ? now : null,
          failureCount: 0,
          lastError: null,
        };

        if (commit) {
          if (existing) {
            await this.prisma.whatsAppIdentity.update({ where: { id: existing.id }, data });
          } else {
            await this.prisma.whatsAppIdentity.create({ data });
          }
        }

        results.push({
          employeeId: emp.id,
          employeeCode: emp.employeeCode,
          name: emp.fullName,
          phoneMasked: maskPhone(e164),
          outcome: existing ? 'updated' : 'linked',
          verified,
          reason: cfg ? undefined : 'Could not check WhatsApp — left unconfirmed.',
        });
      }

      if (commit) {
        this.logger.log(
          `Admin enrolled ${results.filter((r) => r.outcome !== 'skipped').length} WhatsApp ` +
            `identities from employee phone numbers (optedIn=${optIn}).`,
        );
      }

      // Skips are collected in the parse pass and links in the write pass, so
      // without this the report is ordered by internal phase rather than by the
      // employee list the operator is reading it against.
      const order = new Map(employees.map((e, i) => [e.id, i]));
      results.sort((a, b) => (order.get(a.employeeId) ?? 0) - (order.get(b.employeeId) ?? 0));

      return { committed: commit, optedIn: optIn, considered: employees.length, results };
    });
  }

  /**
   * Batch-verify numbers that have never been checked (or failed).
   * Evolution's /chat/whatsappNumbers takes a list, so this is far cheaper than
   * one call per employee.
   */
  async verifyPending(limit = 200): Promise<{ checked: number; verified: number }> {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) return { checked: 0, verified: 0 };

    return runWithBranchBypass(async () => {
      const pending = await this.prisma.whatsAppIdentity.findMany({
        where: { verified: false },
        orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
        take: limit,
        select: { id: true, phoneE164: true },
      });
      if (!pending.length) return { checked: 0, verified: 0 };

      let verified = 0;
      const now = new Date();
      for (let i = 0; i < pending.length; i += 50) {
        const batch = pending.slice(i, i + 50);
        const results = await this.evolution.checkNumbers(
          cfg,
          batch.map((p) => p.phoneE164),
        );
        for (const row of batch) {
          const hit = results.get(row.phoneE164);
          // No entry means the lookup failed for that number; leave it pending
          // rather than recording a false negative.
          if (!hit) continue;
          if (hit.exists) verified++;
          await this.prisma.whatsAppIdentity.update({
            where: { id: row.id },
            data: {
              verified: hit.exists,
              verifiedAt: hit.exists ? now : null,
              waJid: hit.jid ?? null,
              lastCheckedAt: now,
              ...(hit.exists ? { failureCount: 0, lastError: null } : {}),
            },
          });
        }
      }
      return { checked: pending.length, verified };
    });
  }

  /** Admin roster. Phone numbers are masked unless explicitly unmasked. */
  async list(params: {
    search?: string;
    optedIn?: boolean;
    verified?: boolean;
    branchIds?: string[] | null;
    skip?: number;
    take?: number;
    unmask?: boolean;
  }) {
    const { search, optedIn, verified, branchIds, skip = 0, take = 50, unmask = false } = params;

    return runWithBranchBypass(async () => {
      const where: any = {};
      if (optedIn !== undefined) where.optedIn = optedIn;
      if (verified !== undefined) where.verified = verified;
      // Branch isolation is explicit here rather than via the Prisma $use
      // middleware — see the BRANCH_SCOPE note on the model in schema.prisma.
      if (branchIds) where.branchId = { in: branchIds };
      if (search?.trim()) {
        const q = search.trim();
        where.OR = [
          { phoneE164: { contains: q } },
          { user: { email: { contains: q, mode: 'insensitive' } } },
          { user: { employee: { fullName: { contains: q, mode: 'insensitive' } } } },
        ];
      }

      const [rows, total] = await Promise.all([
        this.prisma.whatsAppIdentity.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: Math.min(take, 200),
          include: {
            user: {
              select: {
                email: true,
                employee: { select: { fullName: true, employeeCode: true } },
              },
            },
          },
        }),
        this.prisma.whatsAppIdentity.count({ where }),
      ]);

      return {
        total,
        rows: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          employeeId: r.employeeId,
          employeeName: r.user?.employee?.fullName ?? null,
          employeeCode: r.user?.employee?.employeeCode ?? null,
          email: r.user?.email ?? null,
          phone: unmask ? r.phoneE164 : maskPhone(r.phoneE164),
          source: r.source,
          optedIn: r.optedIn,
          optedInAt: r.optedInAt,
          verified: r.verified,
          verifiedAt: r.verifiedAt,
          failureCount: r.failureCount,
          lastError: r.lastError,
          createdAt: r.createdAt,
        })),
      };
    });
  }

  // ----------------------------------------------------------------- internal

  /**
   * Ask Evolution whether a number exists on WhatsApp.
   * Returns null when we could not find out — the caller must not treat that
   * as "does not exist".
   */
  private async checkExists(phoneE164: string): Promise<boolean | null> {
    // Credentials, not the kill switch: employees should be able to link and
    // verify their number during the pilot, before delivery is switched on.
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) return null;
    const res = await this.evolution.checkNumbers(cfg, [phoneE164]);
    const hit = res.get(phoneE164);
    return hit ? hit.exists : null;
  }

  /**
   * Default region for parsing a national number.
   * Employee's own phone country -> branch column -> global whatsapp setting ->
   * payroll_country. The branch-then-global tail is the same chain
   * SystemSettingsService uses for office hours and geofencing; the employee
   * column sits in front of it because a workforce spread over several countries
   * has people whose number belongs to neither their branch nor the default.
   */
  private async resolveRegion(userId: string): Promise<string> {
    const cfg = await this.settings.get();
    const user = await runWithBranchBypass(() =>
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          employee: {
            select: { phoneCountryCode: true, branch: { select: { country: true } } },
          },
        },
      }),
    );
    const early = firstRegion(
      user?.employee?.phoneCountryCode,
      user?.employee?.branch?.country,
      cfg.defaultRegion,
    );
    if (early) return early;

    const row = await runWithBranchBypass(() =>
      this.prisma.systemSetting.findUnique({ where: { key: 'payroll_country' } }),
    ).catch(() => null);
    return normalisePhoneRegion(row?.value);
  }
}
