import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { AuditService } from '../../audit/audit.service';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { PrismaService } from '../../prisma/prisma.service';
import { EvolutionClient } from '../evolution/evolution.client';
import { WhatsAppSettingsService } from '../whatsapp-settings.service';
import { WhatsAppRateLimitService } from '../runtime/whatsapp-rate-limit.service';
import { firstRegion, isE164, maskPhone, normalisePhoneRegion, toE164 } from '../utils/phone.util';
import { IDENTITY_STATUS } from '../whatsapp.types';
import { bold, italic, lines } from '../render/wa-format';

/**
 * Linking a handset to an account.
 *
 * Three legs, and each proves something different:
 *
 *  1. the employee is signed in on the web — proves the ACCOUNT;
 *  2. they read a code we sent to the number — proves the HANDSET;
 *  3. the handset replies START — proves the WhatsApp account is live and
 *     consenting, and is the only thing the inbound channel is trusted for.
 *
 * Closing the loop on the web (step 2 is entered in the browser, not over
 * WhatsApp) is what stops somebody holding only the SIM from enrolling.
 */
@Injectable()
export class WhatsAppEnrollmentService {
  private readonly logger = new Logger(WhatsAppEnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: WhatsAppSettingsService,
    private readonly evolution: EvolutionClient,
    private readonly rates: WhatsAppRateLimitService,
    private readonly audit: AuditService,
  ) {}

  /** Step 1: send a code to the number the employee entered. */
  async start(
    userId: string,
    rawPhone: string,
    ip?: string,
  ): Promise<{ enrollmentId: string; phoneMasked: string; expiresInMinutes: number }> {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) throw new BadRequestException('WhatsApp is not configured yet.');
    if (!(await this.settings.get()).enrollmentEnabled) {
      throw new BadRequestException('WhatsApp linking is currently turned off.');
    }

    const region = await this.regionFor(userId);
    const phoneE164 = toE164(rawPhone, region);
    if (!phoneE164) {
      throw new BadRequestException(
        'That does not look like a valid number. Include the country code, e.g. +919952982836.',
      );
    }

    // Two axes so neither a single account nor a single number can be used to
    // pump codes at people.
    if (!this.rates.allow(`enroll:user:${userId}`, 3, 60 * 60_000)) {
      throw new BadRequestException('Too many attempts. Try again in an hour.');
    }
    if (!this.rates.allow(`enroll:phone:${phoneE164}`, 3, 60 * 60_000)) {
      throw new BadRequestException('Too many attempts for that number. Try again in an hour.');
    }

    return runWithBranchBypass(async () => {
      const owner = await this.prisma.whatsAppIdentity.findUnique({ where: { phoneE164 } });
      if (owner && owner.userId !== userId) {
        throw new ConflictException('That number is already linked to another account.');
      }

      const exists = await this.evolution.checkNumbers(cfg, [phoneE164]);
      if (exists.get(phoneE164)?.exists === false) {
        throw new BadRequestException('That number is not registered on WhatsApp.');
      }

      const code = String(randomInt(100000, 1000000));
      const row = await this.prisma.whatsAppEnrollment.create({
        data: {
          userId,
          phoneE164,
          codeHash: await bcrypt.hash(code, 10),
          expiresAt: new Date(Date.now() + 10 * 60_000),
          createdIp: ip && /^[\d.:a-fA-F]+$/.test(ip) ? ip : null,
        },
        select: { id: true },
      });

      // Sent directly rather than through the outbox: a verification code is
      // useless if it arrives after a queue drain, and it has a 10-minute life.
      await this.evolution.sendText(cfg, {
        toE164: phoneE164,
        text: lines(
          bold('HR portal verification'),
          `Your code is ${bold(code)}.`,
          italic('It expires in 10 minutes. If you did not request this, ignore this message.'),
        ),
      });

      return { enrollmentId: row.id, phoneMasked: maskPhone(phoneE164), expiresInMinutes: 10 };
    });
  }

  /** Step 2: the employee types the code on the web page. */
  async verify(
    userId: string,
    enrollmentId: string,
    code: string,
  ): Promise<{ status: string; phoneMasked: string; nextStep: string }> {
    return runWithBranchBypass(async () => {
      const row = await this.prisma.whatsAppEnrollment.findUnique({ where: { id: enrollmentId } });
      if (!row || row.userId !== userId) throw new NotFoundException('Verification not found.');
      if (row.consumedAt) throw new BadRequestException('That code has already been used.');
      if (row.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('That code has expired. Request a new one.');
      }
      if (row.attempts >= row.maxAttempts) {
        throw new BadRequestException('Too many incorrect attempts. Request a new code.');
      }

      const ok = await bcrypt.compare(code.replace(/\D/g, ''), row.codeHash);
      if (!ok) {
        await this.prisma.whatsAppEnrollment.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 } },
        });
        throw new BadRequestException('Incorrect code.');
      }

      await this.prisma.whatsAppEnrollment.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });

      const employee = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { employeeId: true, employee: { select: { branchId: true } } },
      });

      const data = {
        userId,
        employeeId: employee?.employeeId ?? null,
        branchId: employee?.employee?.branchId ?? null,
        phoneE164: row.phoneE164,
        source: 'SELF',
        // PENDING until the handset replies START. Verified/opted-in are set
        // then, not now — the web cannot consent on the handset's behalf.
        status: IDENTITY_STATUS.PENDING,
        verified: true,
        verifiedAt: new Date(),
        lastCheckedAt: new Date(),
        failureCount: 0,
        lastError: null,
      };

      const existing = await this.prisma.whatsAppIdentity.findFirst({ where: { userId } });
      const identity = existing
        ? await this.prisma.whatsAppIdentity.update({ where: { id: existing.id }, data })
        : await this.prisma.whatsAppIdentity.create({ data });

      const cfg = await this.settings.ensureCredentials();
      if (cfg) {
        await this.evolution.sendText(cfg, {
          toE164: row.phoneE164,
          text: lines(
            bold('Almost there'),
            'Reply ' + bold('START') + ' to finish linking this number to your HR account.',
          ),
        });
      }

      void this.audit.log({
        userId,
        action: 'WHATSAPP_ENROLL_VERIFIED',
        resourceType: 'WhatsAppIdentity',
        resourceId: identity.id,
        newData: { phone: maskPhone(row.phoneE164) },
      });

      return {
        status: identity.status,
        phoneMasked: maskPhone(row.phoneE164),
        nextStep: 'Reply START on WhatsApp to finish.',
      };
    });
  }

  /**
   * Set or replace the PIN. Web only — accepting a PIN over WhatsApp would let
   * the channel bootstrap its own step-up factor, which defeats the point.
   */
  async setPin(userId: string, pin: string): Promise<{ ok: true }> {
    const digits = pin.replace(/\D/g, '');
    if (digits.length !== 6) throw new BadRequestException('The PIN must be 6 digits.');
    if (/^(\d)\1{5}$/.test(digits) || digits === '123456' || digits === '654321') {
      throw new BadRequestException('Choose a less predictable PIN.');
    }

    return runWithBranchBypass(async () => {
      const identity = await this.prisma.whatsAppIdentity.findFirst({ where: { userId } });
      if (!identity) throw new NotFoundException('Link a WhatsApp number first.');

      await this.prisma.whatsAppIdentity.update({
        where: { id: identity.id },
        data: {
          pinHash: await bcrypt.hash(digits, 10),
          pinSetAt: new Date(),
          failedPinCount: 0,
          lockedUntil: null,
        },
      });
      void this.audit.log({
        userId,
        action: 'WHATSAPP_PIN_SET',
        resourceType: 'WhatsAppIdentity',
        resourceId: identity.id,
      });
      return { ok: true as const };
    });
  }

  /** Unlink. The row stays: consent history is a compliance artifact. */
  async revoke(userId: string, actorUserId?: string): Promise<{ ok: true }> {
    return runWithBranchBypass(async () => {
      await this.prisma.whatsAppIdentity.updateMany({
        where: { userId },
        data: {
          status: IDENTITY_STATUS.REVOKED,
          optedIn: false,
          optedOutAt: new Date(),
          revokedAt: new Date(),
          revokedById: actorUserId ?? userId,
          pinHash: null,
        },
      });
      void this.audit.log({
        userId: actorUserId ?? userId,
        action: 'WHATSAPP_REVOKED',
        resourceType: 'WhatsAppIdentity',
        newData: { targetUserId: userId },
      });
      return { ok: true as const };
    });
  }

  /**
   * Employee's own phone country -> branch country -> global whatsapp setting ->
   * payroll_country. Mirrors WhatsAppIdentityService.resolveRegion; the two must
   * agree or a number would enrol under one region and be looked up under another.
   */
  private async regionFor(userId: string): Promise<string> {
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
