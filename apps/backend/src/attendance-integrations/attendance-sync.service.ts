import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { AttendancesService } from '../attendances/attendances.service';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceIntegrationsService } from './attendance-integrations.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ResolvedIntegrationConfig } from './types/attendance-provider.interface';
import { NormalizedAttendanceRecord } from './types/normalized-attendance';
import {
  ConflictPolicy,
  MAX_DETAIL_RECORDS,
  SYNC_OUTCOME_REASON,
  SyncOutcome,
  SyncRecordResult,
  SyncRunSummary,
} from './types/sync.types';

/** Exact default note written by createManualAttendance — see attendances.service.ts. */
const MANUAL_ENTRY_NOTE = 'Manually entered by admin';

/** Widest window a single sync will read, matching the tightest provider limit we know of. */
const MAX_WINDOW_DAYS = 31;

/**
 * Pulls attendance from external providers into our `attendances` table.
 *
 * Read-only mirror: nothing is ever pushed back, and no existing flow changes.
 * Employees keep checking in through ESS; where both exist, the conflict policy
 * decides. The engine is provider-agnostic — everything vendor-specific lives
 * behind the AttendanceProvider interface.
 */
@Injectable()
export class AttendanceSyncService {
  private readonly logger = new Logger(AttendanceSyncService.name);

  /**
   * Integrations currently mid-sync. A slow provider must not have a second run
   * stacked on top of it by the next cron tick — they would race on the same
   * (employeeId, date) rows.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly integrations: AttendanceIntegrationsService,
    private readonly attendances: AttendancesService,
  ) {}

  // ─────────────────────────── Cron ───────────────────────────

  /**
   * Fires every minute and runs only the integrations whose own interval has
   * elapsed — the same self-gating pattern the attendance crons already use, so
   * per-connection schedules are honoured without registering N cron jobs.
   *
   * Note: like every cron in this codebase this runs in-process, so N replicas
   * means N executions. Harmless here — the writes are idempotent upserts and
   * `inFlight` prevents self-overlap within a process.
   */
  @Cron('0 * * * * *', { name: 'attendance-provider-sync' })
  async scheduledSync(): Promise<void> {
    let due: {
      id: string;
      displayName: string;
      syncIntervalMinutes: number;
      lastSyncAt: Date | null;
    }[];

    try {
      due = await runWithBranchBypass(() =>
        this.prisma.attendanceIntegration.findMany({
          where: { enabled: true },
          select: {
            id: true,
            displayName: true,
            syncIntervalMinutes: true,
            lastSyncAt: true,
          },
        }),
      );
    } catch (e: any) {
      // Most likely the migration has not been applied yet. Warn once a minute
      // rather than throwing out of a cron tick.
      this.logger.warn(`Cannot list attendance integrations: ${e?.message}`);
      return;
    }

    const now = Date.now();
    for (const integration of due) {
      const elapsedMs = integration.lastSyncAt
        ? now - integration.lastSyncAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (elapsedMs < integration.syncIntervalMinutes * 60_000) continue;
      if (this.inFlight.has(integration.id)) continue;

      // Deliberately sequential and not awaited as a group: one slow provider
      // should not delay the tick, and each run guards itself via `inFlight`.
      void this.runSync(integration.id, 'CRON').catch((e) =>
        this.logger.error(
          `Scheduled sync failed for "${integration.displayName}": ${e?.message}`,
        ),
      );
    }
  }

  // ─────────────────────────── Entry points ───────────────────────────

  /** Manual "Sync now" from Settings. Writes. */
  async runManualSync(
    integrationId: string,
    fromISO: string,
    toISO: string,
    triggeredBy?: string,
  ): Promise<SyncRunSummary> {
    this.assertWindow(fromISO, toISO);
    return this.runSync(integrationId, 'MANUAL', { fromISO, toISO, triggeredBy });
  }

  /** Dry run — identical pipeline, no writes. The go-live gate. */
  async preview(
    integrationId: string,
    fromISO: string,
    toISO: string,
    triggeredBy?: string,
  ): Promise<SyncRunSummary> {
    this.assertWindow(fromISO, toISO);
    return this.runSync(integrationId, 'DRY_RUN', {
      fromISO,
      toISO,
      triggeredBy,
    });
  }

  // ─────────────────────────── Engine ───────────────────────────

  private async runSync(
    integrationId: string,
    trigger: 'CRON' | 'MANUAL' | 'DRY_RUN',
    opts?: { fromISO?: string; toISO?: string; triggeredBy?: string },
  ): Promise<SyncRunSummary> {
    if (this.inFlight.has(integrationId)) {
      throw new BadRequestException(
        'A sync is already running for this integration. Wait for it to finish.',
      );
    }
    this.inFlight.add(integrationId);

    const startedAt = Date.now();
    const dryRun = trigger === 'DRY_RUN';
    let runId: string | null = null;

    try {
      const row = await runWithBranchBypass(() =>
        this.prisma.attendanceIntegration.findUnique({
          where: { id: integrationId },
        }),
      );
      if (!row) throw new BadRequestException('Attendance integration not found');

      const cfg = this.integrations.resolveRow(row);
      if (!cfg.authSecret) {
        throw new BadRequestException(
          'No authentication secret configured for this integration.',
        );
      }

      const { fromISO, toISO } = this.resolveWindow(row, opts);
      const provider = this.registry.get(row.provider);

      // Open the run row up front so a crash mid-sync still leaves a trace.
      if (!dryRun || trigger === 'DRY_RUN') {
        const run = await runWithBranchBypass(() =>
          this.prisma.attendanceSyncRun.create({
            data: {
              integrationId,
              trigger,
              windowStart: this.dateOnly(fromISO),
              windowEnd: this.dateOnly(toISO),
              status: 'RUNNING',
              triggeredBy: opts?.triggeredBy ?? null,
            },
            select: { id: true },
          }),
        );
        runId = run.id;
      }

      this.logger.log(
        `[${trigger}] ${row.displayName}: reading ${fromISO} → ${toISO} from ${row.provider}`,
      );

      const fetched = await provider.fetchRange(cfg, fromISO, toISO);
      const records = await this.applyAll(
        row.branchId,
        row.displayName,
        row.conflictPolicy as ConflictPolicy,
        cfg,
        fetched,
        dryRun,
      );

      const summary = this.summarize(
        runId,
        integrationId,
        trigger,
        fromISO,
        toISO,
        fetched.length,
        records,
        startedAt,
        dryRun,
      );

      await this.closeRun(runId, summary, records, dryRun);
      if (!dryRun) await this.stampIntegration(integrationId, summary);

      this.logger.log(
        `[${trigger}] ${row.displayName}: ${summary.status} — ${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.unmapped} unmapped`,
      );
      return summary;
    } catch (e: any) {
      const message = (e?.message ?? 'Sync failed').toString().slice(0, 500);
      await this.failRun(runId, message);
      if (!dryRun) {
        await this.stampIntegrationError(integrationId, message);
      }
      throw e;
    } finally {
      this.inFlight.delete(integrationId);
    }
  }

  /**
   * Map + guard + write every fetched record.
   *
   * Runs inside runWithBranchBypass because the cron has no request context: the
   * Prisma branch middleware would otherwise scope every read to nothing and the
   * sync would silently find no employees.
   */
  private async applyAll(
    branchId: string,
    displayName: string,
    policy: ConflictPolicy,
    cfg: ResolvedIntegrationConfig,
    fetched: NormalizedAttendanceRecord[],
    dryRun: boolean,
  ): Promise<SyncRecordResult[]> {
    return runWithBranchBypass(async () => {
      const results: SyncRecordResult[] = [];
      // Resolution is cached per run: a 31-day backfill would otherwise re-query
      // the same employee once per day per person.
      const employeeCache = new Map<string, ResolvedEmployee | null>();

      for (const record of fetched) {
        try {
          results.push(
            await this.applyOne(
              branchId,
              displayName,
              policy,
              record,
              employeeCache,
              dryRun,
            ),
          );
        } catch (e: any) {
          results.push({
            externalEmployeeId: record.externalEmployeeId,
            externalEmployeeName: record.externalEmployeeName,
            date: record.businessDate,
            checkIn: record.checkIn?.toISOString() ?? null,
            checkOut: record.checkOut?.toISOString() ?? null,
            outcome: 'ERROR',
            reason: SYNC_OUTCOME_REASON.ERROR,
            error: (e?.message ?? String(e)).slice(0, 300),
          });
        }
      }
      return results;
    });
  }

  private async applyOne(
    branchId: string,
    displayName: string,
    policy: ConflictPolicy,
    record: NormalizedAttendanceRecord,
    cache: Map<string, ResolvedEmployee | null>,
    dryRun: boolean,
  ): Promise<SyncRecordResult> {
    const employee = await this.resolveEmployee(
      branchId,
      record.externalEmployeeId,
      cache,
      dryRun,
    );

    const base = {
      externalEmployeeId: record.externalEmployeeId,
      externalEmployeeName: record.externalEmployeeName,
      checkIn: record.checkIn?.toISOString() ?? null,
      checkOut: record.checkOut?.toISOString() ?? null,
    };

    if (!employee) {
      return {
        ...base,
        date: record.businessDate,
        outcome: 'UNMAPPED',
        reason: SYNC_OUTCOME_REASON.UNMAPPED,
      };
    }

    const withEmployee = {
      ...base,
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      employeeName: employee.fullName,
    };

    if (employee.status !== 'ACTIVE') {
      return {
        ...withEmployee,
        date: record.businessDate,
        outcome: 'SKIP_INACTIVE_EMPLOYEE',
        reason: SYNC_OUTCOME_REASON.SKIP_INACTIVE_EMPLOYEE,
      };
    }

    // A day with no punch and no explicit ABSENT carries no information.
    if (!record.checkIn && record.status !== 'ABSENT') {
      return {
        ...withEmployee,
        date: record.businessDate,
        outcome: 'SKIP_NO_PUNCH',
        reason: SYNC_OUTCOME_REASON.SKIP_NO_PUNCH,
      };
    }

    // Our date key, not theirs: derived from the punch instant using the
    // employee's timezone and the configurable attendance_day_end_time boundary.
    // Falls back to the provider's business date only for punch-less ABSENT rows.
    const dateKey = record.checkIn
      ? await this.attendances.resolveAttendanceDateKey(
          record.checkIn,
          employee.timezone,
        )
      : this.dateOnly(record.businessDate);
    const dateISO = dateKey.toISOString().slice(0, 10);

    if (employee.startDate && dateKey < this.dateOnlyFromDate(employee.startDate)) {
      return {
        ...withEmployee,
        date: dateISO,
        outcome: 'SKIP_BEFORE_START_DATE',
        reason: SYNC_OUTCOME_REASON.SKIP_BEFORE_START_DATE,
      };
    }

    const existing = await this.prisma.attendance.findUnique({
      where: {
        unique_employee_date: { employeeId: employee.id, date: dateKey },
      },
      select: {
        id: true,
        status: true,
        source: true,
        notes: true,
        checkIn: true,
        checkOut: true,
      },
    });

    const guard = await this.checkConflict(employee.id, dateKey, existing, policy);
    if (guard) {
      return { ...withEmployee, date: dateISO, outcome: guard, reason: SYNC_OUTCOME_REASON[guard] };
    }

    // Nothing to do when the provider agrees with what we already hold.
    if (
      existing &&
      this.sameInstant(existing.checkIn, record.checkIn) &&
      this.sameInstant(existing.checkOut, record.checkOut)
    ) {
      return {
        ...withEmployee,
        date: dateISO,
        outcome: 'UNCHANGED',
        reason: SYNC_OUTCOME_REASON.UNCHANGED,
      };
    }

    if (dryRun) {
      const outcome: SyncOutcome = existing ? 'WOULD_UPDATE' : 'WOULD_CREATE';
      return { ...withEmployee, date: dateISO, outcome, reason: SYNC_OUTCOME_REASON[outcome] };
    }

    await this.attendances.applySyncedAttendance({
      employeeId: employee.id,
      branchId: employee.branchId,
      dateKey,
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      status: record.status === 'ABSENT' ? 'ABSENT' : 'PRESENT',
      notes: `Synced from ${displayName}`,
      externalRef: record.externalRef ?? null,
      sessions: record.sessions ?? null,
      timezone: employee.timezone,
    });

    const outcome: SyncOutcome = existing ? 'UPDATED' : 'CREATED';
    return { ...withEmployee, date: dateISO, outcome, reason: SYNC_OUTCOME_REASON[outcome] };
  }

  // ─────────────────────── Conflict policy ───────────────────────

  /**
   * Returns the skip outcome when this row must not be touched, or null to proceed.
   *
   * PROVIDER_WINS_SAFE, the default, protects three things the provider cannot
   * know about: approved leave, approved attendance corrections, and rows an
   * admin typed by hand. Everything else — ESS punches, auto-marked absences,
   * previous syncs — is fair game, because the device is the better witness.
   */
  private async checkConflict(
    employeeId: string,
    dateKey: Date,
    existing: {
      status: string;
      source: string | null;
      notes: string | null;
    } | null,
    policy: ConflictPolicy,
  ): Promise<SyncOutcome | null> {
    if (!existing) return null;
    if (policy === 'FILL_GAPS_ONLY') return 'SKIP_MANUAL';
    if (policy === 'PROVIDER_WINS_ALL') return null;

    // PROVIDER_WINS_SAFE
    if (existing.status === 'LEAVE' || existing.source === 'LEAVE') {
      return 'SKIP_LEAVE';
    }

    // `source` is null on rows written before the provenance column existed.
    // The notes literal is the only evidence those rows were typed by a human,
    // and the migration backfills it for the same reason.
    if (
      existing.source === 'MANUAL' ||
      (existing.source === null && existing.notes === MANUAL_ENTRY_NOTE)
    ) {
      return 'SKIP_MANUAL';
    }

    const corrected = await this.prisma.attendanceCorrection.findFirst({
      where: { employeeId, date: dateKey, status: 'APPROVED' },
      select: { id: true },
    });
    if (corrected) return 'SKIP_CORRECTED';

    return null;
  }

  // ─────────────────────── Employee resolution ───────────────────────

  /**
   * external id → our Employee.
   *
   * 1. an explicit link (`attendanceExternalId`) — the steady state
   * 2. `employeeCode`, case-insensitive, within the integration's branch — and
   *    the link is persisted so step 1 handles it next time
   * 3. unmapped, surfaced in Settings for an admin to bind by hand
   *
   * Never matches on name: two people share a name far more often than an id.
   */
  private async resolveEmployee(
    branchId: string,
    externalId: string,
    cache: Map<string, ResolvedEmployee | null>,
    dryRun: boolean,
  ): Promise<ResolvedEmployee | null> {
    if (cache.has(externalId)) return cache.get(externalId) ?? null;

    const select = {
      id: true,
      employeeCode: true,
      fullName: true,
      status: true,
      branchId: true,
      timezone: true,
      startDate: true,
    } as const;

    let employee = await this.prisma.employee.findFirst({
      where: { branchId, attendanceExternalId: externalId },
      select,
    });

    if (!employee) {
      employee = await this.prisma.employee.findFirst({
        where: {
          branchId,
          employeeCode: { equals: externalId, mode: 'insensitive' },
          attendanceExternalId: null,
        },
        select,
      });

      // Backfill the link so the next run is a direct indexed lookup. A dry run
      // deliberately writes nothing at all, including this.
      if (employee && !dryRun) {
        await this.prisma.employee
          .update({
            where: { id: employee.id },
            data: { attendanceExternalId: externalId },
          })
          .catch((e) =>
            // A unique-index clash means another external id already claimed
            // this employee. Leave the link alone and keep syncing.
            this.logger.warn(
              `Could not link external id "${externalId}" to ${employee?.employeeCode}: ${e?.message}`,
            ),
          );
      }
    }

    cache.set(externalId, employee ?? null);
    return employee ?? null;
  }

  // ─────────────────────── Run bookkeeping ───────────────────────

  private summarize(
    runId: string | null,
    integrationId: string,
    trigger: 'CRON' | 'MANUAL' | 'DRY_RUN',
    fromISO: string,
    toISO: string,
    fetchedCount: number,
    records: SyncRecordResult[],
    startedAt: number,
    dryRun: boolean,
  ): SyncRunSummary {
    const count = (...outcomes: SyncOutcome[]) =>
      records.filter((r) => outcomes.includes(r.outcome)).length;

    const errorCount = count('ERROR');
    const unmapped = count('UNMAPPED');
    const created = count('CREATED', 'WOULD_CREATE');
    const updated = count('UPDATED', 'WOULD_UPDATE');
    const skipped = count(
      'SKIP_LEAVE',
      'SKIP_MANUAL',
      'SKIP_CORRECTED',
      'SKIP_BEFORE_START_DATE',
      'SKIP_NO_PUNCH',
      'SKIP_INACTIVE_EMPLOYEE',
      'UNCHANGED',
    );
    const matched = records.length - unmapped;

    // PARTIAL, not OK, when anything at all needs a human: unmapped employees
    // are silently missing attendance, which payroll will read as absence.
    //
    // A window that returned NOTHING is also PARTIAL. Reporting OK there is the
    // most dangerous outcome this service has: a wrong external branch id is
    // accepted by the provider and answers an empty list, so the connection
    // looks healthy forever while importing nothing. Real weekends are the
    // benign case and are called out in the message rather than hidden.
    const emptyWindow = fetchedCount === 0;
    const status: SyncRunSummary['status'] =
      errorCount > 0 || unmapped > 0 || emptyWindow ? 'PARTIAL' : 'OK';

    let message: string | undefined;
    if (emptyWindow) {
      message =
        `The provider returned no attendance at all for ${fromISO} → ${toISO}. ` +
        `If that window is not entirely non-working days, check the external branch id — ` +
        `an unrecognised one is accepted and answers an empty list.`;
    } else if (unmapped > 0) {
      message =
        `${unmapped} record(s) belong to external employees that are not linked to anyone here. ` +
        `Their attendance was skipped, and payroll reads a missing row as absence.`;
    }

    return {
      runId,
      integrationId,
      trigger,
      windowStart: fromISO,
      windowEnd: toISO,
      status,
      fetched: fetchedCount,
      matched,
      created,
      updated,
      skipped,
      unmapped,
      errorCount,
      durationMs: Date.now() - startedAt,
      message,
      // A dry run's whole purpose is the per-record table, so it returns
      // everything. A real run keeps only what an operator must act on.
      records: dryRun
        ? records.slice(0, MAX_DETAIL_RECORDS)
        : records
            .filter((r) => r.outcome === 'ERROR' || r.outcome === 'UNMAPPED')
            .slice(0, MAX_DETAIL_RECORDS),
    };
  }

  private async closeRun(
    runId: string | null,
    summary: SyncRunSummary,
    records: SyncRecordResult[],
    dryRun: boolean,
  ): Promise<void> {
    if (!runId) return;
    const details = (dryRun
      ? records
      : records.filter((r) => r.outcome === 'ERROR' || r.outcome === 'UNMAPPED')
    ).slice(0, MAX_DETAIL_RECORDS);

    await runWithBranchBypass(() =>
      this.prisma.attendanceSyncRun.update({
        where: { id: runId },
        data: {
          finishedAt: new Date(),
          status: summary.status,
          fetched: summary.fetched,
          matched: summary.matched,
          created: summary.created,
          updated: summary.updated,
          skipped: summary.skipped,
          unmapped: summary.unmapped,
          errorCount: summary.errorCount,
          details: details as unknown as Prisma.InputJsonValue,
        },
      }),
    ).catch((e) => this.logger.warn(`Could not close sync run ${runId}: ${e?.message}`));
  }

  private async failRun(runId: string | null, message: string): Promise<void> {
    if (!runId) return;
    await runWithBranchBypass(() =>
      this.prisma.attendanceSyncRun.update({
        where: { id: runId },
        data: {
          finishedAt: new Date(),
          status: 'ERROR',
          errorCount: 1,
          details: [{ error: message }] as unknown as Prisma.InputJsonValue,
        },
      }),
    ).catch(() => undefined);
  }

  private async stampIntegration(id: string, summary: SyncRunSummary) {
    await runWithBranchBypass(() =>
      this.prisma.attendanceIntegration.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: summary.status,
          lastSyncError:
            summary.status === 'OK'
              ? null
              : (summary.message ??
                `${summary.unmapped} unmapped, ${summary.errorCount} error(s)`),
        },
      }),
    ).catch(() => undefined);
  }

  private async stampIntegrationError(id: string, message: string) {
    await runWithBranchBypass(() =>
      this.prisma.attendanceIntegration.update({
        where: { id },
        data: {
          // lastSyncAt is advanced even on failure so a permanently broken
          // provider is retried on its own interval, not every single minute.
          lastSyncAt: new Date(),
          lastSyncStatus: 'ERROR',
          lastSyncError: message,
        },
      }),
    ).catch(() => undefined);
  }

  // ─────────────────────────── Helpers ───────────────────────────

  private resolveWindow(
    row: { lookbackDays: number },
    opts?: { fromISO?: string; toISO?: string },
  ): { fromISO: string; toISO: string } {
    if (opts?.fromISO && opts?.toISO) {
      return { fromISO: opts.fromISO, toISO: opts.toISO };
    }
    // Cron default: today back through `lookbackDays`, so a punch that arrived
    // late still corrects an earlier ABSENT instead of being lost.
    const today = DateTime.utc().startOf('day');
    return {
      fromISO: today.minus({ days: row.lookbackDays }).toISODate() as string,
      toISO: today.toISODate() as string,
    };
  }

  private assertWindow(fromISO: string, toISO: string): void {
    const from = DateTime.fromISO(fromISO, { zone: 'utc' });
    const to = DateTime.fromISO(toISO, { zone: 'utc' });
    if (!from.isValid || !to.isValid) {
      throw new BadRequestException('from and to must be YYYY-MM-DD dates');
    }
    if (to < from) {
      throw new BadRequestException('`to` cannot be earlier than `from`');
    }
    const span = to.diff(from, 'days').days + 1;
    if (span > MAX_WINDOW_DAYS) {
      throw new BadRequestException(
        `Range of ${Math.round(span)} days exceeds the ${MAX_WINDOW_DAYS}-day limit. Sync in smaller windows.`,
      );
    }
  }

  /** YYYY-MM-DD → a UTC midnight Date, matching how @db.Date keys are built elsewhere. */
  private dateOnly(iso: string): Date {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  private dateOnlyFromDate(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private sameInstant(a: Date | null, b: Date | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    // Second precision: providers vary in whether they emit milliseconds.
    return Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);
  }
}

interface ResolvedEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  status: string;
  branchId: string | null;
  timezone: string | null;
  startDate: Date;
}
