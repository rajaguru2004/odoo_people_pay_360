import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { maskAccount } from '../bank-details/iban.util';
import { WpsPreflightService } from './wps-preflight.service';
import { WpsPayloadBuilder } from './wps-payload.builder';
import { WpsArtifact } from './types/wps-format.interface';

/** A GENERATING row older than this is assumed dead and reaped. */
const STALE_GENERATION_MS = 15 * 60 * 1000;

/** Statuses that mean a file for this payroll is still in play. */
const IN_FLIGHT = ['GENERATING', 'GENERATED', 'SUBMITTED'];
/** Statuses a new version may follow. */
const SUPERSEDABLE = ['REJECTED', 'PARTIALLY_REJECTED', 'CANCELLED'];

@Injectable()
export class WpsGenerationService {
  private readonly logger = new Logger(WpsGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly preflight: WpsPreflightService,
    private readonly builder: WpsPayloadBuilder,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Produce the wage file for a locked payroll.
   *
   * Order matters and is the whole safety story:
   *   1. reap dead GENERATING rows
   *   2. re-run the FULL pre-flight and refuse on any blocking problem — before
   *      allocating anything, so a refused attempt leaves no trace
   *   3. insert the GENERATING row; a unique partial index rejects a concurrent
   *      second caller (409)
   *   4. build the payload, re-validate, format
   *   5. hash, store privately, flip to GENERATED with the rows — in one txn
   *   6. any throw ⇒ FAILED with the reason. Never leave a GENERATING row behind.
   */
  async generate(
    payrollId: string,
    args: {
      userId: string;
      userName: string;
      runOptions?: Record<string, unknown>;
      acknowledgeWarnings?: string[];
    },
  ) {
    await this.reapStale();

    // State checks BEFORE data checks. "A file already exists for this payroll" is
    // both cheaper to answer and more useful than a list of data warnings the
    // operator cannot act on until they deal with the existing file.
    const existing = await this.prisma.wpsFile.findMany({
      where: { payrollId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, status: true },
    });

    const latest = existing[0];
    if (latest && IN_FLIGHT.includes(latest.status)) {
      throw new ConflictException(
        `A wage file for this payroll already exists (version ${latest.version}, ${latest.status}). Cancel it or record the bank's rejection before generating another.`,
      );
    }
    if (latest && !SUPERSEDABLE.includes(latest.status) && latest.status !== 'FAILED') {
      throw new ConflictException(
        `The latest wage file for this payroll is ${latest.status}; a new version is not allowed from that state.`,
      );
    }

    const version = latest ? latest.version + 1 : 1;
    const supersedes = latest && SUPERSEDABLE.includes(latest.status) ? latest.id : null;

    const { result, build } = await this.preflight.run(payrollId, args.runOptions ?? {});

    if (!result.canGenerate) {
      // No file, no row, no partial anything. The report tells them what to fix.
      throw new BadRequestException({
        message: `Cannot generate the wage file: ${result.blockedEmployees} of ${result.total} employees are blocked.`,
        preflight: result,
      });
    }

    const acknowledged = new Set(args.acknowledgeWarnings ?? []);
    const unacknowledged = result.requiresAcknowledgement.filter(
      (code) => !acknowledged.has(code),
    );
    if (unacknowledged.length > 0) {
      throw new BadRequestException({
        message:
          'These warnings must be acknowledged before generating: ' +
          unacknowledged.join(', '),
        requiresAcknowledgement: unacknowledged,
        preflight: result,
      });
    }

    // ── Claim the slot ──────────────────────────────────────────────────────
    let file: { id: string };
    try {
      file = await this.prisma.wpsFile.create({
        data: {
          branchId: build.branch.id,
          payrollId,
          configurationId: build.configurationId,
          format: build.format.key,
          specVersion: build.format.specVersion,
          status: 'GENERATING',
          version,
          previousVersionId: supersedes,
          currency: build.currency,
          currencyExponent: build.currencyExponent,
          paymentDate: build.paymentDate,
          periodMonth: build.period.month,
          periodYear: build.period.year,
          employeeCount: build.rows.length,
          totalMinor: new Prisma.Decimal(build.total.minor.toString()),
          runOptions: (args.runOptions ?? {}) as Prisma.InputJsonValue,
          employerSnapshot: this.strippedEmployer(build) as Prisma.InputJsonValue,
          preflightSnapshot: {
            ready: result.ready,
            total: result.total,
            warningEmployees: result.warningEmployees,
            acknowledgedWarnings: [...acknowledged],
            warnings: result.byEmployee
              .flatMap((e) => e.findings)
              .concat(result.runFindings)
              .filter((f) => f.severity === 'WARNING')
              .map((f) => ({ code: f.code, employeeId: f.employeeId, message: f.message })),
          } as Prisma.InputJsonValue,
          generatedBy: args.userId,
        },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // uniq_wps_generating_per_payroll, or (payrollId, version) — either way a
        // concurrent caller got there first.
        throw new ConflictException(
          'A wage file is already being generated for this payroll. Wait for it to finish.',
        );
      }
      throw err;
    }

    // ── Produce ─────────────────────────────────────────────────────────────
    try {
      const payroll = await this.prisma.payroll.findUnique({
        where: { id: payrollId },
        select: { lockedAt: true, approvedAt: true },
      });

      const payload = this.builder.toPayload(build, {
        runId: file.id,
        version,
        runOptions: args.runOptions ?? {},
        generatedBy: { userId: args.userId, name: args.userName },
        lockedAt: payroll!.lockedAt!,
        approvedAt: payroll!.approvedAt!,
      });

      // Belt and braces: the adapter's own rules, re-run on the exact payload it
      // is about to format. The pre-flight already passed, so anything here is a
      // genuine surprise and must not become a file.
      const late = build.format.validate(payload) ?? [];
      const lateBlocking = late.filter((f) => f.severity === 'BLOCKING');
      if (lateBlocking.length > 0) {
        throw new Error(
          `Format validation failed at generation time: ${lateBlocking
            .map((f) => `${f.code} ${f.message}`)
            .join('; ')}`,
        );
      }

      const artifacts = await build.format.generate(payload);
      const primary = artifacts.find((a) => a.role === 'PRIMARY');
      if (!primary) {
        throw new Error(`Format ${build.format.key} produced no PRIMARY artifact`);
      }

      const sha256 = sha(primary.bytes);
      // uploadPrivateFile, never uploadFile: the public bucket carries an
      // allow-all read policy, and this file holds every employee's pay and
      // account. The returned ref is `private://…` and is not a URL.
      const privateRef = await this.storage.uploadPrivateFile(
        primary.bytes,
        primary.fileName,
        'wps',
      );

      const companions = await Promise.all(
        artifacts
          .filter((a) => a.role === 'COMPANION')
          .map(async (a) => ({
            fileName: a.fileName,
            mimeType: a.mimeType,
            byteSize: a.bytes.length,
            sha256: sha(a.bytes),
            privateRef: await this.storage.uploadPrivateFile(a.bytes, a.fileName, 'wps'),
          })),
      );

      const rowData: Prisma.WpsFileRowCreateManyInput[] = payload.rows.map((r, i) => ({
        wpsFileId: file.id,
        employeeId: r.employeeId,
        payrollItemId: r.payrollItemId,
        bankDetailId: r.bank.bankDetailId,
        sequence: i + 1,
        employeeCodeSnapshot: r.employeeCode,
        employeeNameSnapshot: r.fullName,
        identifierSnapshot: Object.fromEntries(
          Object.entries(r.identifiers).map(([k, v]) => [k, v.number]),
        ) as Prisma.InputJsonValue,
        bankCodeSnapshot: r.bank.bankCode,
        // Masked only. The FK to the (append-only) bank detail reproduces the
        // exact account without duplicating the sensitive value.
        accountMasked: maskAccount(r.bank.iban ?? r.bank.accountNumber),
        basicMinor: new Prisma.Decimal(r.basic.minor.toString()),
        allowancesMinor: new Prisma.Decimal(r.allowances.minor.toString()),
        deductionsMinor: new Prisma.Decimal(r.deductions.minor.toString()),
        netMinor: new Prisma.Decimal(r.net.minor.toString()),
        currency: r.net.currency,
        status: 'INCLUDED',
      }));

      const ops: Prisma.PrismaPromise<any>[] = [
        this.prisma.wpsFile.update({
          where: { id: file.id },
          data: {
            status: 'GENERATED',
            fileName: primary.fileName,
            privateRef,
            mimeType: primary.mimeType,
            byteSize: primary.bytes.length,
            sha256,
            companions: companions.length
              ? (companions as unknown as Prisma.InputJsonValue)
              : undefined,
          },
        }),
        this.prisma.wpsFileRow.createMany({ data: rowData }),
      ];
      if (supersedes) {
        ops.push(
          this.prisma.wpsFile.update({
            where: { id: supersedes },
            data: { status: 'SUPERSEDED' },
          }),
        );
      }
      await this.prisma.$transaction(ops);

      await this.audit.log({
        userId: args.userId,
        action: 'WPS_FILE_GENERATED',
        resourceType: 'WpsFile',
        resourceId: file.id,
        branchId: build.branch.id,
        newData: {
          format: build.format.key,
          specVersion: build.format.specVersion,
          version,
          employeeCount: payload.rows.length,
          total: payload.total.minor.toString(),
          currency: payload.currency,
          fileName: primary.fileName,
          sha256,
        },
      });

      return this.prisma.wpsFile.findUnique({ where: { id: file.id } });
    } catch (err: any) {
      // Mark it FAILED rather than deleting: the error is the useful artifact, and
      // a vanished attempt looks like it never happened.
      await this.prisma.wpsFile
        .update({
          where: { id: file.id },
          data: {
            status: 'FAILED',
            generationError: String(err?.message ?? err).slice(0, 2000),
          },
        })
        .catch(() => undefined);

      await this.audit
        .log({
          userId: args.userId,
          action: 'WPS_GENERATION_FAILED',
          resourceType: 'WpsFile',
          resourceId: file.id,
          branchId: build.branch.id,
          newData: { error: String(err?.message ?? err).slice(0, 500) },
        })
        .catch(() => undefined);

      this.logger.error(`WPS generation failed for payroll ${payrollId}: ${err?.message}`);
      throw err;
    }
  }

  /**
   * Release slots held by a crashed process. Without this a killed request would
   * block that payroll forever, since the partial unique index has no TTL.
   */
  private async reapStale(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_GENERATION_MS);
    const { count } = await this.prisma.wpsFile.updateMany({
      where: { status: 'GENERATING', generatedAt: { lt: cutoff } },
      data: {
        status: 'FAILED',
        generationError: 'Generation timed out or the process died before finishing.',
      },
    });
    if (count > 0) this.logger.warn(`Reaped ${count} stale WPS generation(s)`);
  }

  /** Employer data for the snapshot with secret values removed. */
  private strippedEmployer(build: {
    format: { employerConfigSchema: { name: string; secret?: boolean }[] };
    employerSnapshot: Record<string, string>;
    employerLegalName: string;
  }) {
    const secrets = new Set(
      build.format.employerConfigSchema.filter((f) => f.secret).map((f) => f.name),
    );
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(build.employerSnapshot)) {
      data[k] = secrets.has(k) ? '••••' : v;
    }
    return { legalName: build.employerLegalName, data };
  }
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
