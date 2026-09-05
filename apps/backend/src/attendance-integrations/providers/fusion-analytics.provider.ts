import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { Agent as HttpsAgent } from 'https';
import { DateTime } from 'luxon';
import {
  AttendanceProvider,
  ResolvedIntegrationConfig,
  opt,
} from '../types/attendance-provider.interface';
import {
  NormalizedAttendanceRecord,
  ProviderTestResult,
} from '../types/normalized-attendance';
import { ProviderConfigField } from '../types/provider-config-schema';

/**
 * The whole-day feed returns every tenant's records for a date, so it is far
 * heavier than a per-branch call. 20s was not enough in practice.
 */
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;

/**
 * Happy Eyeballs (RFC 8305). live.thefusionapps.com publishes a NAT64 IPv6
 * address; on a network where that path is black-holed, a plain connect hangs
 * until the timeout on every single request while IPv4 answers in well under a
 * second. `autoSelectFamily` races both families and takes whichever completes,
 * so a broken IPv6 route costs ~250ms instead of failing the sync.
 */
const httpsAgent = new HttpsAgent({
  keepAlive: true,
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250,
});
/** Their v4 dashboard endpoint rejects ranges > 31 days; we cap every window to match. */
const MAX_RANGE_DAYS = 31;
/** Courtesy gap between request waves so a 31-day backfill is not a burst. */
const INTER_REQUEST_DELAY_MS = 120;

/**
 * Days fetched in parallel. The whole-day feed takes ~15-20s per call, so a
 * 31-day backfill run serially is ~10 minutes. Kept deliberately small: this is
 * someone else's production API with no published rate limit.
 */
const DEFAULT_DAY_CONCURRENCY = 4;
const MAX_DAY_CONCURRENCY = 8;

/**
 * fusion-analytics (thefusionapps.com) — face-recognition attendance platform.
 *
 * Records originate from Megvii AI boxes pushing to an open webhook, are queued
 * through RabbitMQ, and land in their `employee_attendance` table. Everything we
 * use here is the read layer on top: `/api/v4/attendance/*`.
 *
 * Quirks that shaped this adapter, all from the vendor's handover doc:
 *  - Their timezone is hardcoded Asia/Kolkata for every branch, worldwide.
 *    `sourceTimezone` exists so a naive wall-clock payload can still be read
 *    correctly; see `toInstant()`.
 *  - `/api/v5/...` does NOT exist despite what their code comments say. The
 *    live router is `/api/v4/attendance`.
 *  - The legacy `/api/v4-old/attendance/stats` path can answer HTTP 202 on a
 *    cold cache. We never call it.
 *  - `calculationVersion` v1–v8 chooses how IN/OUT are picked from raw events;
 *    v1 (First IN / Last OUT) is their default and matches our checkIn/checkOut.
 */
@Injectable()
export class FusionAnalyticsProvider implements AttendanceProvider {
  readonly key = 'fusion-analytics';
  readonly displayName = 'Fusion Analytics';
  readonly description =
    'Face-recognition attendance platform (thefusionapps.com). Read-only mirror of /api/v4/attendance.';

  private readonly logger = new Logger(FusionAnalyticsProvider.name);

  readonly configSchema: ProviderConfigField[] = [
    {
      name: 'baseUrl',
      label: 'Base URL',
      type: 'text',
      required: true,
      default: 'https://live.thefusionapps.com',
      placeholder: 'https://live.thefusionapps.com',
      help: 'Root of the Fusion deployment. No trailing slash, no /api suffix.',
    },
    {
      name: 'authHeaderName',
      label: 'Auth header name',
      type: 'text',
      required: true,
      default: 'x-analytics-trigger-key',
      help: 'Fusion service-to-service key header. Bypasses their JWT flow, which is what we want for backend-to-backend.',
    },
    {
      name: 'authSecret',
      label: 'Service key',
      type: 'password',
      required: true,
      secret: true,
      help: 'The ANALYTICS_TRIGGER_KEY value. Encrypted at rest; never shown again after saving.',
    },
    {
      name: 'externalBranchId',
      label: 'Fusion branch id',
      type: 'text',
      required: true,
      placeholder: '55',
      help: 'Numeric branch id from their `branches` table — 55 = Taageer Finance HO. NOT the "TAGGER" code in the handover doc: verified live, that value matches no branch and returns nothing.',
    },
    {
      name: 'externalTenantId',
      label: 'Tenant id',
      type: 'text',
      required: false,
      placeholder: '10',
      help: 'Taageer is tenant 10. Branch ids repeat across tenants on their side, so setting this disambiguates the join.',
    },
    {
      name: 'fetchStrategy',
      label: 'Fetch strategy',
      type: 'select',
      required: false,
      default: 'all-join',
      options: [
        { value: 'all-join', label: 'Whole-day feed, filtered by branch (works today)' },
        { value: 'per-branch', label: 'Per-branch endpoint (currently returns nothing)' },
      ],
      help: 'Their per-branch endpoint answers a correct employee count with a permanently empty list. Leave on the whole-day feed until Fusion fixes it.',
    },
    {
      name: 'calculationVersion',
      label: 'Calculation version',
      type: 'select',
      required: false,
      default: 'v1',
      options: [
        { value: 'v1', label: 'v1 — First IN, Last OUT (their default)' },
        { value: 'v2', label: 'v2 — Session-paired, First IN, First OUT' },
        { value: 'v3', label: 'v3 — Session-paired, First IN, Last OUT' },
        { value: 'v4', label: 'v4 — Last IN, First OUT' },
        { value: 'v5', label: 'v5 — Last IN, Last OUT' },
        { value: 'v6', label: 'v6 — First IN, First OUT' },
        { value: 'v7', label: 'v7 — Session-paired, Last IN, Last OUT' },
        { value: 'v8', label: 'v8 — Session-paired, Last IN, First OUT' },
      ],
      help: 'How Fusion picks IN/OUT from raw face events. v1 matches our single checkIn/checkOut model. Agree this with the Fusion team before changing it — it changes reported hours.',
    },
    {
      name: 'sourceTimezone',
      label: 'Source timezone',
      type: 'text',
      required: false,
      default: 'Asia/Kolkata',
      help: 'Only used when a timestamp arrives WITHOUT an offset. Fusion hardcodes Asia/Kolkata for every branch regardless of location.',
    },
    {
      name: 'timestampMode',
      label: 'Timestamp interpretation',
      type: 'select',
      required: false,
      default: 'instant',
      options: [
        { value: 'instant', label: 'Absolute instant (recommended)' },
        { value: 'wallclock', label: 'Wall-clock in the source timezone' },
      ],
      help: 'instant: the timestamp identifies a real moment and we re-render it in the branch timezone. wallclock: the clock face is what matters — use only if their device clocks run on local time but are labelled IST.',
    },
    {
      name: 'maxConcurrentDays',
      label: 'Days fetched in parallel',
      type: 'number',
      required: false,
      default: DEFAULT_DAY_CONCURRENCY,
      help: `Backfills read one request per day and each takes ~15-20s. Higher is faster but heavier on their API. Max ${MAX_DAY_CONCURRENCY}.`,
    },
    {
      name: 'pageSize',
      label: 'Page size',
      type: 'number',
      required: false,
      default: 100,
      help: 'Rows per request. Only used by the per-branch fetch strategy — the whole-day feed is not paginated.',
    },
  ];

  // ─────────────────────────── Test ───────────────────────────

  async testConnection(cfg: ResolvedIntegrationConfig): Promise<ProviderTestResult> {
    // getTodaysAbsentees is the cheapest authenticated, side-effect-free call
    // their API offers, and it exercises the branchId + key pair together.
    const startedAt = Date.now();
    try {
      const res = await this.request(cfg, '/api/v4/attendance/getTodaysAbsentees', {
        branchId: cfg.externalBranchId,
      });
      const latencyMs = Date.now() - startedAt;
      const rows = this.unwrapArray(res);
      return {
        ok: true,
        latencyMs,
        message: `Connected. Branch "${cfg.externalBranchId}" responded with ${rows.length} absentee record(s) for today.`,
        details: { sample: rows.slice(0, 3) },
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: this.explain(e, cfg),
      };
    }
  }

  // ─────────────────────────── Fetch ───────────────────────────

  async fetchRange(
    cfg: ResolvedIntegrationConfig,
    fromISO: string,
    toISO: string,
  ): Promise<NormalizedAttendanceRecord[]> {
    const days = this.enumerateDays(fromISO, toISO);
    const out: NormalizedAttendanceRecord[] = [];

    // Days are independent, and the whole-day feed is slow (~15-20s each), so a
    // month-long backfill run strictly serially would take ~10 minutes. A small
    // concurrency window cuts that several-fold while staying polite — this is
    // someone else's production API and there is no published rate limit.
    const concurrency = Math.max(
      1,
      Math.min(opt(cfg, 'maxConcurrentDays', DEFAULT_DAY_CONCURRENCY), MAX_DAY_CONCURRENCY),
    );

    for (let i = 0; i < days.length; i += concurrency) {
      const window = days.slice(i, i + concurrency);
      if (i > 0) await this.sleep(INTER_REQUEST_DELAY_MS);

      const batches = await Promise.all(
        window.map(async (day) => {
          // Per-day rather than their date-range dashboard endpoint: the per-day
          // shape is stable, while the dashboard endpoint's varies with
          // `pageVersion` and it enforces the 31-day cap itself.
          const rows = await this.fetchDayRows(cfg, day);
          const mapped: NormalizedAttendanceRecord[] = [];
          for (const row of rows) {
            const record = this.mapRecord(cfg, row, day);
            if (record) mapped.push(record);
          }
          const collapsed = this.collapsePerEmployee(cfg, mapped, day);
          const absentees = cfg.autoCreateAbsent
            ? await this.fetchAbsentees(cfg, day, collapsed)
            : [];
          return [...collapsed, ...absentees];
        }),
      );

      // Preserve chronological order regardless of which request finished first.
      for (const batch of batches) out.push(...batch);
    }

    return out;
  }

  private async fetchDayRows(
    cfg: ResolvedIntegrationConfig,
    day: string,
  ): Promise<any[]> {
    return opt<string>(cfg, 'fetchStrategy', 'all-join') === 'per-branch'
      ? this.fetchViaPerBranch(cfg, day)
      : this.fetchViaAllJoin(cfg, day);
  }

  /**
   * Default strategy.
   *
   * `GET /employeeAttendances/all?date=` returns the whole day across every
   * tenant and branch as two parallel arrays:
   *   { total, employees:[{employeeId, employeeName, branchId, tenantId, jobShift}],
   *             attendance:[{id, employeeId, clockIn, clockOut, attendanceStatus, clockInEventId}] }
   * The attendance rows carry NO branch or tenant, so we join them to the roster
   * on employeeId and filter there.
   *
   * Why not the documented per-branch endpoint: verified live on 2026-07-31,
   * `employeeAttendances?branchId=<id>&date=<d>` answers `{"totalEmployee":N,"list":[]}`
   * — a correct employee count with a permanently empty list, for every branch
   * tried (55 Taageer, 52 TMJ-CBE), with and without tenantId, and with
   * startDate/endDate instead of date. Until Fusion fixes it, that endpoint
   * yields nothing. `fetchStrategy: 'per-branch'` switches back once they do.
   */
  private async fetchViaAllJoin(
    cfg: ResolvedIntegrationConfig,
    day: string,
  ): Promise<any[]> {
    const payload = await this.request(
      cfg,
      '/api/v4/attendance/employeeAttendances/all',
      { date: day },
    );

    const roster = this.unwrapArray(payload, 'employees');
    const attendance = this.unwrapArray(payload, 'attendance');

    const byEmployee = new Map<string, any>();
    for (const e of roster) {
      if (e?.employeeId) byEmployee.set(String(e.employeeId), e);
    }

    // externalTenantId is optional; when set it must also match, because branch
    // ids are only unique within a tenant on their side.
    const wantBranch = String(cfg.externalBranchId);
    const wantTenant = cfg.externalTenantId
      ? String(cfg.externalTenantId)
      : null;

    const rows: any[] = [];
    let unknownEmployee = 0;
    for (const a of attendance) {
      const emp = byEmployee.get(String(a?.employeeId ?? ''));
      if (!emp) {
        unknownEmployee += 1;
        continue;
      }
      if (String(emp.branchId) !== wantBranch) continue;
      if (wantTenant !== null && String(emp.tenantId) !== wantTenant) continue;

      // Carry the roster name across — attendance rows have no name of their own,
      // and the unmapped-employee panel is far more usable with one.
      rows.push({ ...a, employeeName: emp.employeeName, jobShift: emp.jobShift });
    }

    if (unknownEmployee > 0) {
      this.logger.warn(
        `${day}: ${unknownEmployee} attendance row(s) referenced an employee absent from the roster — skipped.`,
      );
    }
    return rows;
  }

  /** The endpoint the handover doc documents. Kept behind an option — see above. */
  private async fetchViaPerBranch(
    cfg: ResolvedIntegrationConfig,
    day: string,
  ): Promise<any[]> {
    const pageSize = opt(cfg, 'pageSize', 100);
    const calculationVersion = opt<string>(cfg, 'calculationVersion', 'v1');
    const rows: any[] = [];

    let page = 1;
    // Hard stop: a provider that ignores `page` would otherwise loop forever.
    const MAX_PAGES = 200;
    while (page <= MAX_PAGES) {
      const res = await this.request(
        cfg,
        '/api/v4/attendance/employeeAttendances',
        {
          branchId: cfg.externalBranchId,
          date: day,
          page,
          limit: pageSize,
          version: calculationVersion,
        },
      );
      const batch = this.unwrapArray(res, 'list');
      rows.push(...batch);
      if (batch.length < pageSize) break;
      page += 1;
      await this.sleep(INTER_REQUEST_DELAY_MS);
    }
    if (page > MAX_PAGES) {
      this.logger.warn(
        `Stopped paginating ${day} at ${MAX_PAGES} pages — the endpoint may be ignoring the page parameter.`,
      );
    }
    return rows;
  }

  /** Documented shape: `[{ employeeId, employeeName }]`. Only used when autoCreateAbsent is on. */
  private async fetchAbsentees(
    cfg: ResolvedIntegrationConfig,
    day: string,
    already: NormalizedAttendanceRecord[],
  ): Promise<NormalizedAttendanceRecord[]> {
    // Their endpoint is "today's" absentees with no date parameter, so it is
    // only meaningful for the current day. Silently skipping past days avoids
    // stamping today's absentee list onto a backfilled date.
    const todayInSource = DateTime.now()
      .setZone(opt(cfg, 'sourceTimezone', 'Asia/Kolkata'))
      .toISODate();
    if (day !== todayInSource) return [];

    try {
      const res = await this.request(cfg, '/api/v4/attendance/getTodaysAbsentees', {
        branchId: cfg.externalBranchId,
      });
      const seen = new Set(already.map((r) => `${r.externalEmployeeId}|${r.businessDate}`));
      return this.unwrapArray(res)
        .map((row) => this.pick(row, ['employeeId', 'employee_id', 'empId']))
        .filter((id): id is string => Boolean(id))
        .filter((id) => !seen.has(`${id}|${day}`))
        .map((id) => ({
          externalEmployeeId: String(id),
          businessDate: day,
          checkIn: null,
          checkOut: null,
          status: 'ABSENT' as const,
        }));
    } catch (e) {
      this.logger.warn(`Absentee fetch failed for ${day}: ${this.short(e)}`);
      return [];
    }
  }

  /**
   * Collapse the several rows Fusion can emit for one employee on one day into
   * the single record our `attendances` table holds.
   *
   * Measured live on the Taageer branch (2026-07-28…30): 10–15 of ~55 employees
   * per day carry more than one row — duplicate face events that their pipeline
   * paired into separate sessions. Without this the sync would upsert them in
   * arbitrary order against the (employeeId, date) unique key and whichever row
   * happened to be processed last would win, silently discarding the rest.
   *
   * The IN/OUT choice mirrors their own `calculationVersion` semantics so our
   * numbers agree with what their dashboard shows.
   */
  private collapsePerEmployee(
    cfg: ResolvedIntegrationConfig,
    records: NormalizedAttendanceRecord[],
    day: string,
  ): NormalizedAttendanceRecord[] {
    const version = opt<string>(cfg, 'calculationVersion', 'v1');
    // v1/v3 First IN + Last OUT · v2/v6 First IN + First OUT
    // v4/v8 Last IN + First OUT · v5/v7 Last IN + Last OUT
    const lastIn = ['v4', 'v5', 'v7', 'v8'].includes(version);
    const lastOut = ['v1', 'v3', 'v5', 'v7'].includes(version);

    const groups = new Map<string, NormalizedAttendanceRecord[]>();
    for (const r of records) {
      const list = groups.get(r.externalEmployeeId);
      if (list) list.push(r);
      else groups.set(r.externalEmployeeId, [r]);
    }

    const out: NormalizedAttendanceRecord[] = [];
    let collapsed = 0;

    for (const [externalEmployeeId, group] of groups) {
      if (group.length > 1) collapsed += group.length - 1;

      const ins = group.map((g) => g.checkIn).filter((d): d is Date => !!d);
      const outs = group.map((g) => g.checkOut).filter((d): d is Date => !!d);
      const pick = (dates: Date[], last: boolean) =>
        dates.length
          ? dates.reduce((a, b) => ((last ? b > a : b < a) ? b : a))
          : null;

      const checkIn = pick(ins, lastIn);
      let checkOut = pick(outs, lastOut);

      // Their feed occasionally pairs a clock-out that PRECEDES the clock-in
      // (seen daily, by a few seconds — mis-paired duplicate face events).
      // Treated as a missing punch: passing it through would hit our
      // overnight-shift rule, which adds 24h and turns an 18-second inversion
      // into a 23-hour working day.
      if (checkIn && checkOut && checkOut.getTime() < checkIn.getTime()) {
        this.logger.warn(
          `${day} ${externalEmployeeId}: clockOut precedes clockIn by ${Math.round(
            (checkIn.getTime() - checkOut.getTime()) / 1000,
          )}s — dropping the clock-out.`,
        );
        checkOut = null;
      }

      // Intra-day detail must survive the collapse: take each row's own
      // sessions when it has them, otherwise synthesise one from its punches.
      const sessions = group
        .flatMap((g) =>
          g.sessions?.length
            ? g.sessions
            : g.checkIn
              ? [{ checkIn: g.checkIn, checkOut: g.checkOut ?? null }]
              : [],
        )
        .filter((s) => !(s.checkOut && s.checkOut.getTime() < s.checkIn.getTime()))
        .sort((a, b) => a.checkIn.getTime() - b.checkIn.getTime());

      const primary = group.find((g) => g.checkIn === checkIn) ?? group[0];
      out.push({
        ...primary,
        checkIn,
        checkOut,
        sessions: sessions.length > 1 ? sessions : undefined,
        // Keep every source id so a row can be traced back to all of them.
        externalRef: group
          .map((g) => g.externalRef)
          .filter(Boolean)
          .join(',')
          .slice(0, 100),
        status: group.some((g) => g.status === 'PRESENT') ? 'PRESENT' : 'ABSENT',
      });
    }

    if (collapsed > 0) {
      this.logger.log(
        `${day}: collapsed ${collapsed} duplicate row(s) into ${groups.size} employee-day record(s) using ${version}.`,
      );
    }
    return out;
  }

  // ─────────────────────────── Mapping ───────────────────────────

  /**
   * Vendor payload → our normalized record.
   *
   * THIS IS THE ONLY FUNCTION THAT KNOWS FUSION'S FIELD NAMES.
   *
   * Their handover doc documents request parameters but not response bodies, so
   * each field is resolved from a small list of plausible aliases rather than
   * one hardcoded name. Once the Fusion team supplies a real sample payload,
   * collapse each list to the single correct key and delete the rest.
   */
  private mapRecord(
    cfg: ResolvedIntegrationConfig,
    row: any,
    requestedDay: string,
  ): NormalizedAttendanceRecord | null {
    if (!row || typeof row !== 'object') return null;

    const externalEmployeeId = this.pick(row, [
      'employeeId',
      'employee_id',
      'empId',
      'employeeCode',
    ]);
    if (!externalEmployeeId) return null;

    const checkIn = this.toInstant(
      cfg,
      this.pickRaw(row, ['clockIn', 'clock_in', 'checkIn', 'check_in', 'inTime', 'firstIn']),
      requestedDay,
    );
    const checkOut = this.toInstant(
      cfg,
      this.pickRaw(row, ['clockOut', 'clock_out', 'checkOut', 'check_out', 'outTime', 'lastOut']),
      requestedDay,
    );

    const rawSessions = row.sessions ?? row.events ?? row.eventList;
    const sessions = Array.isArray(rawSessions)
      ? rawSessions
          .map((s: any) => ({
            checkIn: this.toInstant(
              cfg,
              this.pickRaw(s, ['clockIn', 'checkIn', 'inTime', 'startTime']),
              requestedDay,
            ),
            checkOut: this.toInstant(
              cfg,
              this.pickRaw(s, ['clockOut', 'checkOut', 'outTime', 'endTime']),
              requestedDay,
            ),
          }))
          .filter(
            (s): s is { checkIn: Date; checkOut: Date | null } => s.checkIn !== null,
          )
      : undefined;

    const rawStatus = String(
      this.pick(row, ['attendanceStatus', 'status']) ?? '',
    ).toUpperCase();

    return {
      externalEmployeeId: String(externalEmployeeId),
      externalEmployeeName:
        this.pick(row, ['employeeName', 'employee_name', 'name', 'fullName']) ?? undefined,
      // Trust the day we asked for, not a date field in their payload: theirs is
      // derived in Asia/Kolkata and would drift for a non-Indian branch. Our own
      // date key is recomputed downstream from `checkIn` anyway.
      businessDate: requestedDay,
      checkIn,
      checkOut,
      sessions: sessions?.length ? sessions : undefined,
      status: rawStatus.includes('ABSENT') ? 'ABSENT' : 'PRESENT',
      externalRef: this.pick(row, ['id', '_id', 'attendanceId'])?.toString(),
      raw: row,
    };
  }

  /**
   * Parse a vendor timestamp into an absolute instant.
   *
   * - String carrying an offset or Z  → that instant, verbatim.
   * - Naive string / epoch number     → interpreted in `sourceTimezone`.
   * - `timestampMode: 'wallclock'`    → the clock face is authoritative: we
   *   strip whatever offset arrived and re-anchor the same wall time in the
   *   source timezone. Only correct when the vendor's clocks run on local time
   *   but are labelled with someone else's zone.
   * - Bare `HH:mm[:ss]`               → combined with the requested day.
   */
  private toInstant(
    cfg: ResolvedIntegrationConfig,
    value: unknown,
    requestedDay: string,
  ): Date | null {
    if (value === null || value === undefined || value === '') return null;

    const zone = opt<string>(cfg, 'sourceTimezone', 'Asia/Kolkata');
    // Explicit <string>: inference would otherwise narrow to the literal
    // 'instant' and make the wallclock branch below unreachable to the compiler.
    const mode = opt<string>(cfg, 'timestampMode', 'instant');

    let dt: DateTime | null = null;

    if (value instanceof Date) {
      dt = DateTime.fromJSDate(value);
    } else if (typeof value === 'number') {
      // Heuristic: 10-digit values are seconds, 13-digit are milliseconds.
      dt = value > 1e11
        ? DateTime.fromMillis(value, { zone })
        : DateTime.fromSeconds(value, { zone });
    } else if (typeof value === 'string') {
      const s = value.trim();
      if (!s) return null;

      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
        dt = DateTime.fromISO(`${requestedDay}T${s.padStart(5, '0')}`, { zone });
      } else {
        // setZone:true keeps an explicit offset; a naive string adopts `zone`.
        dt = DateTime.fromISO(s, { zone, setZone: true });
        if (!dt.isValid) dt = DateTime.fromSQL(s, { zone });
        if (!dt.isValid) dt = DateTime.fromJSDate(new Date(s));
      }
    }

    if (!dt || !dt.isValid) {
      this.logger.warn(`Unparseable timestamp from provider: ${JSON.stringify(value)}`);
      return null;
    }

    if (mode === 'wallclock') {
      dt = DateTime.fromObject(
        {
          year: dt.year,
          month: dt.month,
          day: dt.day,
          hour: dt.hour,
          minute: dt.minute,
          second: dt.second,
        },
        { zone },
      );
    }

    return dt.toUTC().toJSDate();
  }

  // ─────────────────────────── HTTP ───────────────────────────

  private async request(
    cfg: ResolvedIntegrationConfig,
    path: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.authScheme === 'bearer') {
      headers.Authorization = `Bearer ${cfg.authSecret}`;
    } else {
      headers[cfg.authHeaderName || 'x-analytics-trigger-key'] = cfg.authSecret;
    }

    const query: Record<string, unknown> = { ...params };
    if (cfg.externalTenantId) query.tenantId = cfg.externalTenantId;

    const options: AxiosRequestConfig = {
      params: query,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      httpsAgent,
      // Their v4-old path can answer 202 on a cold cache; treat only <300 as OK
      // so a 202 body is never mistaken for data.
      validateStatus: (s) => s >= 200 && s < 300,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await axios.get(`${cfg.baseUrl}${path}`, options);
        if (res.status === 202) {
          throw new Error('Provider responded 202 (result not ready). Retry later.');
        }
        return res.data;
      } catch (e) {
        lastError = e;
        // 4xx is a request problem — retrying cannot fix it.
        const status = (e as AxiosError)?.response?.status;
        if (status && status >= 400 && status < 500) break;
        if (attempt < MAX_RETRIES) {
          await this.sleep(300 * Math.pow(2, attempt));
        }
      }
    }
    throw new Error(this.explain(lastError, cfg));
  }

  /**
   * Their responses wrap the payload differently per endpoint; find the array.
   * Observed live: `list` (employeeAttendances), `attendance` + `employees`
   * (employeeAttendances/all), bare array (getTodaysAbsentees).
   */
  private unwrapArray(payload: unknown, preferredKey?: string): any[] {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    const obj = payload as Record<string, unknown>;
    if (preferredKey && Array.isArray(obj[preferredKey])) {
      return obj[preferredKey] as any[];
    }
    for (const key of [
      'list',
      'attendance',
      'data',
      'result',
      'records',
      'rows',
      'attendances',
      'items',
    ]) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
      // One level deeper, e.g. { data: { rows: [...] } }
      if (v && typeof v === 'object') {
        for (const inner of ['data', 'rows', 'records', 'items', 'list']) {
          const iv = (v as Record<string, unknown>)[inner];
          if (Array.isArray(iv)) return iv;
        }
      }
    }
    return [];
  }

  private pick(row: any, keys: string[]): string | undefined {
    const v = this.pickRaw(row, keys);
    return v === undefined ? undefined : String(v);
  }

  /**
   * Like `pick` but preserves the original type. Required for timestamps: an
   * epoch number stringified here would fall into toInstant's string branch and
   * parse as nothing.
   */
  private pickRaw(row: any, keys: string[]): unknown {
    for (const k of keys) {
      const v = row?.[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  /** Turn a transport failure into something an admin can act on. */
  private explain(e: unknown, cfg: ResolvedIntegrationConfig): string {
    const err = e as AxiosError;
    const status = err?.response?.status;

    if (status === 401 || status === 403) {
      return `Authentication rejected (HTTP ${status}). Check the service key and the "${cfg.authHeaderName || 'x-analytics-trigger-key'}" header name.`;
    }
    if (status === 404) {
      return `Endpoint not found (HTTP 404). Check the base URL — the live router is /api/v4/attendance (there is no /api/v5).`;
    }
    if (status === 400) {
      const body = err?.response?.data;
      return `Provider rejected the request (HTTP 400): ${this.stringify(body)}. Check the Fusion branch id "${cfg.externalBranchId}".`;
    }
    if (status && status >= 500) {
      return `Provider error (HTTP ${status}) after ${MAX_RETRIES + 1} attempts.`;
    }
    if ((err as any)?.code === 'ECONNABORTED') {
      return `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s contacting ${cfg.baseUrl}.`;
    }
    if ((err as any)?.code === 'ENOTFOUND' || (err as any)?.code === 'ECONNREFUSED') {
      return `Cannot reach ${cfg.baseUrl} (${(err as any).code}).`;
    }
    return this.short(e);
  }

  /**
   * Never returns an empty string. An axios failure can carry a blank `message`
   * (aborted socket, no response object), which would otherwise surface to the
   * operator as a 500 with no explanation at all.
   */
  private short(e: unknown): string {
    const err = e as any;
    const parts = [err?.message, err?.code, err?.response?.status]
      .filter((p) => p !== undefined && p !== null && p !== '')
      .map(String);
    if (!parts.length) {
      return `Request failed with no error detail (${Object.prototype.toString.call(e)}).`;
    }
    return parts.join(' — ').slice(0, 300);
  }

  private stringify(v: unknown): string {
    try {
      return (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 200);
    } catch {
      return '<unserializable>';
    }
  }

  private enumerateDays(fromISO: string, toISO: string): string[] {
    const start = DateTime.fromISO(fromISO, { zone: 'utc' });
    const end = DateTime.fromISO(toISO, { zone: 'utc' });
    if (!start.isValid || !end.isValid) {
      throw new Error(`Invalid date range: ${fromISO} → ${toISO}`);
    }
    if (end < start) {
      throw new Error(`End date ${toISO} precedes start date ${fromISO}`);
    }
    const span = end.diff(start, 'days').days + 1;
    if (span > MAX_RANGE_DAYS) {
      throw new Error(
        `Range of ${Math.round(span)} days exceeds the provider's ${MAX_RANGE_DAYS}-day limit. Sync in smaller windows.`,
      );
    }
    const days: string[] = [];
    for (let d = start; d <= end; d = d.plus({ days: 1 })) {
      days.push(d.toISODate() as string);
    }
    return days;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
