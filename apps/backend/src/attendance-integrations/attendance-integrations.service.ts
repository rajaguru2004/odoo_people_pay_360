import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runWithBranchBypass } from '../common/branch/branch-context';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecret,
} from '../common/crypto/secret-crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateIntegrationDto,
  UpdateIntegrationDto,
} from './dto/upsert-integration.dto';
import { MapEmployeeDto, TestIntegrationDto } from './dto/run-sync.dto';
import { ProviderRegistry } from './providers/provider.registry';
import { ResolvedIntegrationConfig } from './types/attendance-provider.interface';
import { ProviderTestResult } from './types/normalized-attendance';
import { isTopLevelConfigField } from './types/provider-config-schema';

/**
 * CRUD + secret handling for external attendance connections.
 *
 * Secret doctrine, copied from CopilotSettingsService: encrypt-on-write,
 * keep-on-omit, delete-on-clear. The plaintext secret leaves this service in
 * exactly one direction — into a provider adapter's outbound HTTP call. It is
 * never included in any response.
 */
@Injectable()
export class AttendanceIntegrationsService {
  private readonly logger = new Logger(AttendanceIntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
  ) {}

  // ─────────────────────────── Providers ───────────────────────────

  /** The catalogue the admin form is generated from. */
  listProviders() {
    return this.registry.list().map((p) => ({
      key: p.key,
      displayName: p.displayName,
      description: p.description,
      configSchema: p.configSchema,
    }));
  }

  // ─────────────────────────── CRUD ───────────────────────────

  async findAll() {
    const rows = await this.prisma.attendanceIntegration.findMany({
      include: { branch: { select: { id: true, code: true, name: true } } },
      orderBy: { displayName: 'asc' },
    });
    return rows.map((r) => this.toPublic(r));
  }

  async findOne(id: string) {
    const row = await this.prisma.attendanceIntegration.findUnique({
      where: { id },
      include: { branch: { select: { id: true, code: true, name: true } } },
    });
    if (!row) throw new NotFoundException('Attendance integration not found');
    return this.toPublic(row);
  }

  async create(dto: CreateIntegrationDto) {
    this.registry.get(dto.provider); // throws 400 on an unknown key

    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const existing = await this.prisma.attendanceIntegration.findUnique({
      where: { branchId: dto.branchId },
      select: { id: true, displayName: true },
    });
    if (existing) {
      throw new BadRequestException(
        `This branch already has an attendance integration ("${existing.displayName}"). Edit it instead of adding a second one.`,
      );
    }

    const row = await this.prisma.attendanceIntegration.create({
      data: {
        branchId: dto.branchId,
        provider: dto.provider,
        displayName: dto.displayName.trim(),
        enabled: dto.enabled ?? false,
        baseUrl: this.normalizeBaseUrl(dto.baseUrl),
        authScheme: dto.authScheme ?? 'header',
        authHeaderName: dto.authHeaderName?.trim() || null,
        authSecretEnc: dto.authSecret?.trim()
          ? encryptSecret(dto.authSecret.trim())
          : null,
        externalBranchId: dto.externalBranchId.trim(),
        externalTenantId: dto.externalTenantId?.trim() || null,
        options: this.sanitizeOptions(dto.provider, dto.options),
        conflictPolicy: dto.conflictPolicy ?? 'PROVIDER_WINS_SAFE',
        syncIntervalMinutes: dto.syncIntervalMinutes ?? 15,
        lookbackDays: dto.lookbackDays ?? 3,
        autoCreateAbsent: dto.autoCreateAbsent ?? false,
      },
      include: { branch: { select: { id: true, code: true, name: true } } },
    });

    this.logger.log(
      `Attendance integration created: ${row.displayName} (${row.provider} → branch ${row.branchId})`,
    );
    return this.toPublic(row);
  }

  async update(id: string, dto: UpdateIntegrationDto) {
    const current = await this.prisma.attendanceIntegration.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException('Attendance integration not found');

    // branchId and provider are immutable: changing either silently repoints an
    // existing run history at a different system.
    if (dto.branchId && dto.branchId !== current.branchId) {
      throw new BadRequestException(
        'Branch cannot be changed. Delete this connection and create a new one.',
      );
    }
    if (dto.provider && dto.provider !== current.provider) {
      throw new BadRequestException(
        'Provider cannot be changed. Delete this connection and create a new one.',
      );
    }

    const data: Prisma.AttendanceIntegrationUpdateInput = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName.trim();
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.baseUrl !== undefined) data.baseUrl = this.normalizeBaseUrl(dto.baseUrl);
    if (dto.authScheme !== undefined) data.authScheme = dto.authScheme;
    if (dto.authHeaderName !== undefined) {
      data.authHeaderName = dto.authHeaderName.trim() || null;
    }
    if (dto.externalBranchId !== undefined) {
      data.externalBranchId = dto.externalBranchId.trim();
    }
    if (dto.externalTenantId !== undefined) {
      data.externalTenantId = dto.externalTenantId.trim() || null;
    }
    if (dto.options !== undefined) {
      data.options = this.sanitizeOptions(current.provider, dto.options);
    }
    if (dto.conflictPolicy !== undefined) data.conflictPolicy = dto.conflictPolicy;
    if (dto.syncIntervalMinutes !== undefined) {
      data.syncIntervalMinutes = dto.syncIntervalMinutes;
    }
    if (dto.lookbackDays !== undefined) data.lookbackDays = dto.lookbackDays;
    if (dto.autoCreateAbsent !== undefined) {
      data.autoCreateAbsent = dto.autoCreateAbsent;
    }

    // Secret: encrypt-on-write, keep-on-omit, delete-on-clear.
    if (dto.clearAuthSecret) {
      data.authSecretEnc = null;
    } else if (typeof dto.authSecret === 'string' && dto.authSecret.trim()) {
      data.authSecretEnc = encryptSecret(dto.authSecret.trim());
    }

    // Refuse to arm a connection that cannot authenticate — the cron would just
    // log 401s every interval.
    const willBeEnabled = data.enabled ?? current.enabled;
    const willHaveSecret =
      data.authSecretEnc !== undefined
        ? Boolean(data.authSecretEnc)
        : Boolean(current.authSecretEnc);
    if (willBeEnabled && !willHaveSecret) {
      throw new BadRequestException(
        'Cannot enable this connection without an authentication secret.',
      );
    }

    const row = await this.prisma.attendanceIntegration.update({
      where: { id },
      data,
      include: { branch: { select: { id: true, code: true, name: true } } },
    });
    return this.toPublic(row);
  }

  async remove(id: string) {
    const row = await this.prisma.attendanceIntegration.findUnique({
      where: { id },
      select: { id: true, displayName: true },
    });
    if (!row) throw new NotFoundException('Attendance integration not found');

    // Run history cascades. Attendance rows already written are deliberately
    // kept — they are real attendance, and deleting them would silently break
    // payroll for closed months.
    await this.prisma.attendanceIntegration.delete({ where: { id } });
    this.logger.log(`Attendance integration deleted: ${row.displayName}`);
    return { success: true, message: 'Integration removed' };
  }

  // ─────────────────────── Resolution / secrets ───────────────────────

  /**
   * Internal, decrypted view used by the sync engine and provider adapters.
   * `overrides` lets Test Connection run against unsaved form values.
   */
  async resolve(
    id: string,
    overrides?: TestIntegrationDto,
  ): Promise<ResolvedIntegrationConfig> {
    const row = await runWithBranchBypass(() =>
      this.prisma.attendanceIntegration.findUnique({ where: { id } }),
    );
    if (!row) throw new NotFoundException('Attendance integration not found');
    return this.resolveRow(row, overrides);
  }

  /** Same as `resolve` but from an already-loaded row (avoids a second query in the cron). */
  resolveRow(
    row: {
      id: string;
      provider: string;
      branchId: string;
      baseUrl: string;
      authScheme: string;
      authHeaderName: string | null;
      authSecretEnc: string | null;
      externalBranchId: string;
      externalTenantId: string | null;
      options: Prisma.JsonValue | null;
      autoCreateAbsent: boolean;
    },
    overrides?: TestIntegrationDto,
  ): ResolvedIntegrationConfig {
    let authSecret = '';
    if (overrides?.authSecret?.trim()) {
      authSecret = overrides.authSecret.trim();
    } else if (row.authSecretEnc) {
      authSecret = this.decryptOrEmpty(row.authSecretEnc, row.id);
    }

    return {
      id: row.id,
      provider: row.provider,
      branchId: row.branchId,
      baseUrl: this.normalizeBaseUrl(overrides?.baseUrl || row.baseUrl),
      authScheme: row.authScheme,
      authHeaderName:
        overrides?.authHeaderName?.trim() || row.authHeaderName || null,
      authSecret,
      externalBranchId:
        overrides?.externalBranchId?.trim() || row.externalBranchId,
      externalTenantId:
        overrides?.externalTenantId?.trim() || row.externalTenantId || null,
      options: (row.options as Record<string, unknown>) ?? {},
      autoCreateAbsent: row.autoCreateAbsent,
    };
  }

  async testConnection(
    id: string,
    overrides?: TestIntegrationDto,
  ): Promise<ProviderTestResult> {
    const row = await this.prisma.attendanceIntegration.findUnique({
      where: { id },
      select: { provider: true },
    });
    if (!row) throw new NotFoundException('Attendance integration not found');

    const cfg = await this.resolve(id, overrides);
    if (!cfg.authSecret) {
      return {
        ok: false,
        message:
          'No authentication secret configured. Enter one in the form and test again.',
      };
    }

    const provider = this.registry.get(row.provider);
    try {
      return await provider.testConnection(cfg);
    } catch (e: any) {
      return {
        ok: false,
        message: (e?.message ?? 'Connection failed').toString().slice(0, 300),
      };
    }
  }

  // ─────────────────────── Employee mapping ───────────────────────

  /**
   * External ids seen in recent runs that no employee is linked to.
   *
   * Sourced from the persisted run details rather than from a live API call, so
   * the panel stays usable when the vendor is unreachable.
   */
  async listUnmapped(id: string) {
    await this.assertExists(id);

    const runs = await this.prisma.attendanceSyncRun.findMany({
      where: { integrationId: id },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: { details: true, startedAt: true },
    });

    const seen = new Map<string, { externalId: string; name?: string; lastSeen: Date }>();
    for (const run of runs) {
      const records = Array.isArray(run.details) ? (run.details as any[]) : [];
      for (const rec of records) {
        if (rec?.outcome !== 'UNMAPPED' || !rec?.externalEmployeeId) continue;
        const key = String(rec.externalEmployeeId);
        if (!seen.has(key)) {
          seen.set(key, {
            externalId: key,
            name: rec.externalEmployeeName || undefined,
            lastSeen: run.startedAt,
          });
        }
      }
    }
    return [...seen.values()];
  }

  /** Bind (or detach) an external id to one of our employees. */
  async mapEmployee(id: string, dto: MapEmployeeDto) {
    const integration = await this.assertExists(id);

    if (dto.unlink) {
      const cleared = await this.prisma.employee.updateMany({
        where: {
          branchId: integration.branchId,
          attendanceExternalId: dto.externalId,
        },
        data: { attendanceExternalId: null },
      });
      return { success: true, message: `Unlinked ${cleared.count} employee(s)` };
    }

    if (!dto.employeeId) {
      throw new BadRequestException('employeeId is required unless unlink=true');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, branchId: true, employeeCode: true, fullName: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.branchId !== integration.branchId) {
      throw new BadRequestException(
        'Employee belongs to a different branch than this integration.',
      );
    }

    // The DB unique index is (branch_id, attendance_external_id); catch the
    // collision here so the admin gets a sentence instead of a Prisma P2002.
    const clash = await this.prisma.employee.findFirst({
      where: {
        branchId: integration.branchId,
        attendanceExternalId: dto.externalId,
        NOT: { id: employee.id },
      },
      select: { employeeCode: true, fullName: true },
    });
    if (clash) {
      throw new BadRequestException(
        `External id "${dto.externalId}" is already linked to ${clash.fullName} (${clash.employeeCode}).`,
      );
    }

    await this.prisma.employee.update({
      where: { id: employee.id },
      data: { attendanceExternalId: dto.externalId },
    });

    return {
      success: true,
      message: `Linked "${dto.externalId}" to ${employee.fullName} (${employee.employeeCode})`,
    };
  }

  /**
   * Employees an unmapped external id could be bound to: ACTIVE, in this
   * integration's branch, not already linked.
   *
   * A dedicated endpoint rather than reusing /employees because the picker must
   * always show the integration's branch regardless of which branch the admin
   * currently has selected in the UI.
   */
  async listCandidates(id: string, search?: string) {
    const integration = await this.assertExists(id);
    const term = search?.trim();
    return this.prisma.employee.findMany({
      where: {
        branchId: integration.branchId,
        status: 'ACTIVE',
        attendanceExternalId: null,
        ...(term
          ? {
              OR: [
                { fullName: { contains: term, mode: 'insensitive' as const } },
                { employeeCode: { contains: term, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: { id: true, employeeCode: true, fullName: true, position: true },
      orderBy: { fullName: 'asc' },
      take: 50,
    });
  }

  /**
   * Propose an employee for each unmapped external id.
   *
   * Linking a branch by hand is the practical blocker on go-live: a provider
   * with 90 staff means 90 dropdown selections. Providers do send a display
   * name, so we score it against our roster and let the admin confirm in bulk.
   *
   * Deliberately a SUGGESTION, never an automatic link — names collide, and a
   * wrong link silently attributes one person's attendance to another, which
   * flows straight into payroll. Auto-matching stays strictly on employee code.
   */
  async suggestMappings(id: string) {
    const integration = await this.assertExists(id);
    const [unmapped, candidates] = await Promise.all([
      this.listUnmapped(id),
      this.prisma.employee.findMany({
        where: {
          branchId: integration.branchId,
          status: 'ACTIVE',
          attendanceExternalId: null,
        },
        select: { id: true, employeeCode: true, fullName: true, position: true },
      }),
    ]);

    const scored = candidates.map((c) => ({
      ...c,
      tokens: this.nameTokens(c.fullName),
    }));
    // One employee must not be proposed for two different external ids.
    const claimed = new Set<string>();

    return unmapped.map((u) => {
      const tokens = this.nameTokens(u.name ?? '');
      const ranked = tokens.length
        ? scored
            .filter((c) => !claimed.has(c.id))
            .map((c) => ({ c, score: this.nameScore(tokens, c.tokens) }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
        : [];

      const best = ranked[0];
      const runnerUp = ranked[1];
      // Confident only when the top match is strong AND clearly ahead of the
      // next one — "Mohammed Al Balushi" vs "Mohammed Al Bulushi" must not be
      // auto-accepted just because it scored well in isolation.
      const confident =
        !!best && best.score >= 0.75 && (!runnerUp || best.score - runnerUp.score >= 0.25);
      if (confident) claimed.add(best.c.id);

      return {
        externalId: u.externalId,
        externalName: u.name ?? null,
        confident,
        suggestions: ranked.map((r) => ({
          employeeId: r.c.id,
          employeeCode: r.c.employeeCode,
          fullName: r.c.fullName,
          position: r.c.position,
          score: Math.round(r.score * 100) / 100,
        })),
      };
    });
  }

  /**
   * Apply many links at once. Each entry is validated independently so one bad
   * row (already-linked employee, wrong branch, duplicate external id) reports
   * its own reason instead of failing the whole batch.
   */
  async bulkMapEmployees(id: string, entries: { externalId: string; employeeId: string }[]) {
    const integration = await this.assertExists(id);

    const results: {
      externalId: string;
      employeeId: string;
      ok: boolean;
      message: string;
    }[] = [];

    // Guard against the same employee (or external id) appearing twice in one payload.
    const seenEmployees = new Set<string>();
    const seenExternalIds = new Set<string>();

    for (const entry of entries) {
      const externalId = entry.externalId?.trim();
      if (!externalId) {
        results.push({ ...entry, ok: false, message: 'Missing external id' });
        continue;
      }
      if (seenExternalIds.has(externalId)) {
        results.push({ ...entry, ok: false, message: 'Duplicate external id in this batch' });
        continue;
      }
      if (seenEmployees.has(entry.employeeId)) {
        results.push({ ...entry, ok: false, message: 'Employee already used in this batch' });
        continue;
      }

      try {
        await this.mapEmployee(id, { externalId, employeeId: entry.employeeId });
        seenExternalIds.add(externalId);
        seenEmployees.add(entry.employeeId);
        results.push({ externalId, employeeId: entry.employeeId, ok: true, message: 'Linked' });
      } catch (e: any) {
        results.push({
          externalId,
          employeeId: entry.employeeId,
          ok: false,
          message: (e?.message ?? 'Failed').toString().slice(0, 200),
        });
      }
    }

    const linked = results.filter((r) => r.ok).length;
    this.logger.log(
      `Bulk mapping on ${integration.id}: ${linked}/${entries.length} linked`,
    );
    return { linked, failed: results.length - linked, results };
  }

  /**
   * Normalise a name to comparable tokens: lowercase, accents stripped,
   * punctuation dropped, and the connective particles that pepper Arabic and
   * Indian names removed so "Mahran Al Balushi" and "Mahran Balushi" agree.
   */
  private nameTokens(name: string): string[] {
    const NOISE = new Set(['al', 'el', 'bin', 'bint', 'ibn', 'abu', 'mr', 'mrs', 'ms', 'dr']);
    return name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining diacritics
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !NOISE.has(t));
  }

  /**
   * Token-overlap score in [0,1], counting a token as matched when it is equal
   * to, a prefix of, or a one-edit variant of a token on the other side —
   * transliterated names differ by a letter far more often than by a word
   * ("Balushi"/"Bulushi", "Mohammed"/"Mohamed").
   */
  private nameScore(a: string[], b: string[]): number {
    if (!a.length || !b.length) return 0;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    const pool = [...long];
    let matched = 0;

    for (const token of short) {
      const idx = pool.findIndex(
        (candidate) =>
          candidate === token ||
          (token.length >= 4 && candidate.startsWith(token)) ||
          (candidate.length >= 4 && token.startsWith(candidate)) ||
          this.withinOneEdit(token, candidate),
      );
      if (idx !== -1) {
        matched += 1;
        pool.splice(idx, 1); // each roster token can only be claimed once
      }
    }
    return matched / short.length;
  }

  /** True when two tokens are within a single insert/delete/substitute. */
  private withinOneEdit(a: string, b: string): boolean {
    if (Math.min(a.length, b.length) < 4) return false;
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a === b) return true;

    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i += 1;
        j += 1;
        continue;
      }
      if (++edits > 1) return false;
      if (a.length === b.length) {
        i += 1;
        j += 1;
      } else if (a.length > b.length) {
        i += 1;
      } else {
        j += 1;
      }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  /** Everyone in this integration's branch who already carries an external id. */
  async listMapped(id: string) {
    const integration = await this.assertExists(id);
    return this.prisma.employee.findMany({
      where: {
        branchId: integration.branchId,
        attendanceExternalId: { not: null },
      },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        status: true,
        attendanceExternalId: true,
      },
      orderBy: { fullName: 'asc' },
    });
  }

  // ─────────────────────────── Run history ───────────────────────────

  async listRuns(id: string, limit = 20) {
    await this.assertExists(id);
    const runs = await this.prisma.attendanceSyncRun.findMany({
      where: { integrationId: id },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return runs.map((r) => ({
      ...r,
      // `details` can hold hundreds of records; the list view only needs counts.
      details: undefined,
      detailCount: Array.isArray(r.details) ? (r.details as any[]).length : 0,
      durationMs: r.finishedAt
        ? r.finishedAt.getTime() - r.startedAt.getTime()
        : null,
    }));
  }

  async getRun(id: string, runId: string) {
    await this.assertExists(id);
    const run = await this.prisma.attendanceSyncRun.findFirst({
      where: { id: runId, integrationId: id },
    });
    if (!run) throw new NotFoundException('Sync run not found');
    return run;
  }

  // ─────────────────────────── Helpers ───────────────────────────

  private async assertExists(id: string) {
    const row = await this.prisma.attendanceIntegration.findUnique({
      where: { id },
      select: { id: true, branchId: true, provider: true },
    });
    if (!row) throw new NotFoundException('Attendance integration not found');
    return row;
  }

  /** Admin-facing projection. The secret is reduced to a boolean + a masked hint. */
  private toPublic(row: any) {
    const {
      authSecretEnc,
      ...rest
    }: { authSecretEnc: string | null } & Record<string, unknown> = row;

    let masked = '';
    if (authSecretEnc) {
      try {
        masked = maskSecret(decryptSecret(authSecretEnc));
      } catch {
        masked = '••••';
      }
    }

    return {
      ...rest,
      authSecretConfigured: Boolean(authSecretEnc),
      authSecretMasked: masked,
    };
  }

  private decryptOrEmpty(enc: string, integrationId: string): string {
    if (!isEncryptedSecret(enc)) {
      // A plaintext value here means the row was written outside this service.
      // Use it rather than failing the sync, but say so loudly.
      this.logger.warn(
        `Integration ${integrationId} holds an unencrypted auth secret. Re-save it from Settings to encrypt at rest.`,
      );
      return enc;
    }
    try {
      return decryptSecret(enc);
    } catch (e: any) {
      // Almost always a changed SETTINGS_ENCRYPTION_KEY.
      this.logger.error(
        `Cannot decrypt the auth secret for integration ${integrationId}: ${e?.message}. Re-enter it in Settings.`,
      );
      return '';
    }
  }

  private normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }

  /**
   * Keep only keys the provider actually declares, so a stale UI or a hand-rolled
   * request cannot smuggle arbitrary JSON into `options`. Top-level fields
   * (baseUrl, authSecret, ...) live in columns and are filtered out here.
   */
  private sanitizeOptions(
    providerKey: string,
    options?: Record<string, unknown>,
  ): Prisma.InputJsonValue {
    if (!options) return {};
    const provider = this.registry.get(providerKey);
    const allowed = new Set(
      provider.configSchema
        .map((f) => f.name)
        .filter((name) => !isTopLevelConfigField(name)),
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(options)) {
      if (allowed.has(k)) out[k] = v;
    }
    return out as Prisma.InputJsonValue;
  }
}
