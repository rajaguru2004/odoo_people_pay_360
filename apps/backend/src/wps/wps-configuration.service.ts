import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertBranchAssignable, assertInBranch } from '../common/branch/branch-scope.util';
import { encryptSecret } from '../common/crypto/secret-crypto';
import { DynamicConfigField } from '../common/config-schema/dynamic-config-field';
import { WpsFormatRegistry } from './formats/wps-format.registry';

const MASK = '••••••••';

/**
 * Employer profiles + per-branch wage-file configuration.
 *
 * Secret handling follows the doctrine already used by attendance integrations:
 * encrypt on write, KEEP on omit, DELETE on explicit empty string. A secret is
 * never returned to the browser — only a masked placeholder — so a round-tripped
 * form cannot overwrite a stored secret with its own mask.
 */
@Injectable()
export class WpsConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: WpsFormatRegistry,
  ) {}

  /** The format catalogue, optionally narrowed to a country. */
  catalogue(country?: string) {
    const formats = country ? this.registry.listForCountry(country) : this.registry.list();
    return {
      success: true,
      data: formats.map((f) => ({
        key: f.key,
        displayName: f.displayName,
        description: f.description,
        country: f.country,
        currency: f.currency,
        currencyExponent: f.currencyExponent,
        specVersion: f.specVersion,
        employerConfigSchema: f.employerConfigSchema,
        runOptionsSchema: f.runOptionsSchema,
        requiredIdentifiers: f.requiredIdentifiers,
      })),
    };
  }

  // ── Employer profiles ─────────────────────────────────────────────────────

  async listProfiles() {
    const rows = await this.prisma.wpsEmployerProfile.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { configurations: { select: { branchId: true } } },
    });
    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        legalName: r.legalName,
        country: r.country,
        format: r.format,
        isActive: r.isActive,
        data: this.maskSecrets(r.format, (r.data as Record<string, string>) ?? {}),
        usedByBranchIds: r.configurations.map((c) => c.branchId),
      })),
    };
  }

  async createProfile(
    dto: {
      name: string;
      legalName: string;
      country: string;
      format: string;
      data?: Record<string, unknown>;
    },
    user: any,
  ) {
    const format = this.registry.get(dto.format);
    const data = this.sanitize(format.employerConfigSchema, dto.data ?? {}, {});

    const created = await this.prisma.wpsEmployerProfile.create({
      data: {
        name: dto.name,
        legalName: dto.legalName,
        country: dto.country.toUpperCase(),
        format: dto.format,
        data: data as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      userId: user.id,
      action: 'WPS_EMPLOYER_PROFILE_CREATED',
      resourceType: 'WpsEmployerProfile',
      resourceId: created.id,
      newData: { name: dto.name, country: dto.country, format: dto.format },
    });
    return { success: true, data: { id: created.id }, message: 'Employer profile created' };
  }

  async updateProfile(
    id: string,
    dto: {
      name?: string;
      legalName?: string;
      isActive?: boolean;
      data?: Record<string, unknown>;
    },
    user: any,
  ) {
    const existing = await this.prisma.wpsEmployerProfile.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Employer profile not found');
    const format = this.registry.get(existing.format);

    const data =
      dto.data === undefined
        ? undefined
        : this.sanitize(
            format.employerConfigSchema,
            dto.data,
            (existing.data as Record<string, string>) ?? {},
          );

    await this.prisma.wpsEmployerProfile.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.legalName !== undefined ? { legalName: dto.legalName } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(data !== undefined ? { data: data as Prisma.InputJsonValue } : {}),
      },
    });

    await this.audit.log({
      userId: user.id,
      action: 'WPS_EMPLOYER_PROFILE_UPDATED',
      resourceType: 'WpsEmployerProfile',
      resourceId: id,
      newData: { fields: Object.keys(dto) },
    });
    return { success: true, message: 'Employer profile updated' };
  }

  async deleteProfile(id: string, user: any) {
    const inUse = await this.prisma.wpsConfiguration.count({
      where: { employerProfileId: id },
    });
    if (inUse > 0) {
      throw new BadRequestException(
        `This employer profile is used by ${inUse} branch configuration(s). Detach it first.`,
      );
    }
    await this.prisma.wpsEmployerProfile.delete({ where: { id } });
    await this.audit.log({
      userId: user.id,
      action: 'WPS_EMPLOYER_PROFILE_DELETED',
      resourceType: 'WpsEmployerProfile',
      resourceId: id,
    });
    return { success: true, message: 'Employer profile deleted' };
  }

  // ── Per-branch configuration ──────────────────────────────────────────────

  async listConfigs() {
    // Auto branch-scoped (WpsConfiguration is 'direct').
    const rows = await this.prisma.wpsConfiguration.findMany({
      include: {
        branch: { select: { code: true, name: true, country: true } },
        employerProfile: { select: { id: true, name: true, legalName: true, country: true } },
      },
      orderBy: { branch: { code: 'asc' } },
    });
    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        branchId: r.branchId,
        branchCode: r.branch.code,
        branchName: r.branch.name,
        branchCountry: r.branch.country,
        employerProfile: r.employerProfile,
        format: r.format,
        enabled: r.enabled,
        defaultRunOptions: r.defaultRunOptions ?? {},
        acceptedWarnings: r.acceptedWarnings,
      })),
    };
  }

  async upsertConfig(
    dto: {
      branchId: string;
      employerProfileId: string;
      format: string;
      enabled?: boolean;
      defaultRunOptions?: Record<string, unknown>;
      acceptedWarnings?: string[];
    },
    user: any,
  ) {
    assertBranchAssignable(dto.branchId);
    const format = this.registry.get(dto.format);

    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
      select: { id: true, code: true, country: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    // A format declares the country it is legal in. '*' means country-neutral.
    const branchCountry = (branch.country ?? '').toUpperCase();
    if (format.country !== '*' && format.country !== branchCountry) {
      throw new BadRequestException(
        `${format.displayName} applies to ${format.country}, but branch ${branch.code} is in ${branchCountry || 'no country'}. Set the branch country or pick another format.`,
      );
    }

    const profile = await this.prisma.wpsEmployerProfile.findUnique({
      where: { id: dto.employerProfileId },
    });
    if (!profile) throw new NotFoundException('Employer profile not found');
    if (profile.format !== dto.format) {
      throw new BadRequestException(
        `That employer profile was set up for ${profile.format}, not ${dto.format}. Its fields would not match.`,
      );
    }

    const runOptions = this.sanitize(format.runOptionsSchema, dto.defaultRunOptions ?? {}, {});

    const saved = await this.prisma.wpsConfiguration.upsert({
      where: { branchId: dto.branchId },
      create: {
        branchId: dto.branchId,
        employerProfileId: dto.employerProfileId,
        format: dto.format,
        enabled: dto.enabled ?? false,
        defaultRunOptions: runOptions as Prisma.InputJsonValue,
        acceptedWarnings: dto.acceptedWarnings ?? [],
      },
      update: {
        employerProfileId: dto.employerProfileId,
        format: dto.format,
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        defaultRunOptions: runOptions as Prisma.InputJsonValue,
        ...(dto.acceptedWarnings !== undefined
          ? { acceptedWarnings: dto.acceptedWarnings }
          : {}),
      },
    });

    await this.audit.log({
      userId: user.id,
      action: 'WPS_CONFIGURATION_SAVED',
      resourceType: 'WpsConfiguration',
      resourceId: saved.id,
      branchId: dto.branchId,
      newData: { format: dto.format, enabled: saved.enabled },
    });
    return { success: true, data: { id: saved.id }, message: 'WPS configuration saved' };
  }

  async deleteConfig(id: string, user: any) {
    const cfg = await this.prisma.wpsConfiguration.findUnique({ where: { id } });
    if (!cfg) throw new NotFoundException('WPS configuration not found');
    assertInBranch(cfg.branchId);

    const files = await this.prisma.wpsFile.count({ where: { configurationId: id } });
    if (files > 0) {
      // Keep the history readable: detach rather than cascade-delete generated files.
      await this.prisma.wpsFile.updateMany({
        where: { configurationId: id },
        data: { configurationId: null },
      });
    }
    await this.prisma.wpsConfiguration.delete({ where: { id } });
    await this.audit.log({
      userId: user.id,
      action: 'WPS_CONFIGURATION_DELETED',
      resourceType: 'WpsConfiguration',
      resourceId: id,
      branchId: cfg.branchId,
    });
    return { success: true, message: 'WPS configuration deleted' };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Keep only declared fields, coerce to strings, and apply the secret doctrine:
   * omitted ⇒ keep the stored value, empty string ⇒ clear it, anything else ⇒
   * encrypt. Unknown keys are dropped rather than stored, so a stale form cannot
   * smuggle fields into the JSONB.
   */
  private sanitize(
    schema: DynamicConfigField[],
    incoming: Record<string, unknown>,
    stored: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of schema) {
      const raw = incoming[field.name];

      if (field.secret) {
        if (raw === undefined || raw === MASK) {
          if (stored[field.name]) out[field.name] = stored[field.name];
          continue;
        }
        const asStr = String(raw ?? '');
        if (asStr === '') continue; // explicit clear
        out[field.name] = encryptSecret(asStr);
        continue;
      }

      if (raw === undefined) {
        if (stored[field.name] !== undefined) out[field.name] = stored[field.name];
        continue;
      }
      if (field.type === 'boolean') {
        out[field.name] = raw === true || raw === 'true' ? 'true' : 'false';
        continue;
      }
      out[field.name] = String(raw ?? '').trim();
    }
    return out;
  }

  /** Replace secret values with a placeholder for any read projection. */
  private maskSecrets(
    formatKey: string,
    data: Record<string, string>,
  ): Record<string, string> {
    let schema: DynamicConfigField[] = [];
    try {
      schema = this.registry.get(formatKey).employerConfigSchema;
    } catch {
      return {}; // unknown format: reveal nothing
    }
    const secrets = new Set(schema.filter((f) => f.secret).map((f) => f.name));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = secrets.has(k) ? (v ? MASK : '') : v;
    }
    return out;
  }
}
