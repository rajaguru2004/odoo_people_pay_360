import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { branchAllowedCountries, normalizeCountry } from './banking-fields.util';
import { CreateBankDto, UpdateBankDto } from './dto/bank.dto';

/**
 * Bank Master — the admin-managed catalog of banks per country. Employees pick a
 * Bank from here instead of typing a free-text name. Not branch-scoped: the
 * catalog is company-wide reference data keyed by country.
 */
@Injectable()
export class BankService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** List banks, optionally filtered by country and/or active-only. */
  async list(country?: string, activeOnly = false) {
    const data = await this.prisma.bank.findMany({
      where: {
        ...(country ? { country: country.toUpperCase() } : {}),
        ...(activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ country: 'asc' }, { name: 'asc' }],
    });
    return { success: true, data };
  }

  async getOrThrow(id: string) {
    const bank = await this.prisma.bank.findUnique({ where: { id } });
    if (!bank) throw new NotFoundException('Bank not found');
    return bank;
  }

  async create(dto: CreateBankDto, actorUserId?: string) {
    const country = dto.country.toUpperCase();
    // Any ISO-2 country may hold banks. IBAN structure/length is still enforced
    // per-country at change-request time for countries in IBAN_COUNTRY_RULES.
    const existing = await this.prisma.bank.findFirst({
      where: { country, name: dto.name },
    });
    if (existing) {
      throw new ConflictException(
        `A bank named "${dto.name}" already exists for ${country}`,
      );
    }
    const bank = await this.prisma.bank.create({
      data: {
        country,
        name: dto.name,
        bankCode: dto.bankCode?.toUpperCase() ?? null,
        swift: dto.swift?.toUpperCase() ?? null,
      },
    });
    await this.audit.log({
      userId: actorUserId,
      action: 'BANK_MASTER_CREATED',
      resourceType: 'Bank',
      resourceId: bank.id,
      newData: { country, name: bank.name, bankCode: bank.bankCode },
    });
    return { success: true, data: bank };
  }

  async update(id: string, dto: UpdateBankDto, actorUserId?: string) {
    const bank = await this.getOrThrow(id);
    const updated = await this.prisma.bank.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        bankCode:
          dto.bankCode !== undefined ? dto.bankCode?.toUpperCase() ?? null : undefined,
        swift: dto.swift !== undefined ? dto.swift?.toUpperCase() ?? null : undefined,
        isActive: dto.isActive ?? undefined,
      },
    });
    await this.audit.log({
      userId: actorUserId,
      action: dto.isActive === false ? 'BANK_MASTER_DEACTIVATED' : 'BANK_MASTER_UPDATED',
      resourceType: 'Bank',
      resourceId: id,
      oldData: { name: bank.name, bankCode: bank.bankCode, isActive: bank.isActive },
      newData: { name: updated.name, bankCode: updated.bankCode, isActive: updated.isActive },
    });
    return { success: true, data: updated };
  }

  /** Soft-disable a bank so it can no longer be selected on new requests. */
  async deactivate(id: string, actorUserId?: string) {
    return this.update(id, { isActive: false }, actorUserId);
  }

  // ── Per-branch allowed banking countries ──────────────────────────────────

  /** Branches (branch-scoped) with their allowed banking countries. */
  async listBranchCountries() {
    const rows = await this.prisma.branch.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        code: true,
        country: true,
        bankingCountries: true,
      },
      orderBy: { name: 'asc' },
    });
    return {
      success: true,
      data: rows.map((b) => ({
        ...b,
        allowedCountries: branchAllowedCountries(b),
      })),
    };
  }

  /** Set the allowed banking countries (ISO-2) for a branch. */
  async setBranchCountries(
    branchId: string,
    countries: string[],
    actorUserId?: string,
  ) {
    // Cross-branch admin/HR config — intentionally NOT branch-scoped (the screen
    // manages every branch, independent of the active X-Branch-Id context).
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, bankingCountries: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const normalized = Array.from(
      new Set((countries ?? []).map(normalizeCountry).filter(Boolean)),
    );
    if ((countries ?? []).length && normalized.length === 0) {
      throw new BadRequestException('Countries must be ISO-2 codes');
    }

    const updated = await this.prisma.branch.update({
      where: { id: branchId },
      data: { bankingCountries: normalized },
      select: { id: true, name: true, bankingCountries: true },
    });
    await this.audit.log({
      userId: actorUserId,
      action: 'BRANCH_BANKING_COUNTRIES_SET',
      resourceType: 'Branch',
      resourceId: branchId,
      oldData: { bankingCountries: branch.bankingCountries },
      newData: { bankingCountries: normalized },
    });
    return { success: true, data: updated };
  }
}
