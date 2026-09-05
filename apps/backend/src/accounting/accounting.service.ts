import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertBranchAssignable } from '../common/branch/branch-scope.util';
import {
  CreateLedgerAccountDto,
  UpdateLedgerAccountDto,
  UpsertLedgerMappingDto,
} from './dto/accounting.dto';

/**
 * The chart of accounts, and which loan event posts to which of them.
 *
 * Deliberately thin. The customer's real ledger lives elsewhere; this exists so
 * a posting can name its two sides in the customer's own account codes instead
 * of in strings somebody hard-coded.
 */
@Injectable()
export class AccountingService {
  constructor(private prisma: PrismaService) {}

  // ── Accounts ──────────────────────────────────────────────────────────────

  async findAccounts(includeInactive = false) {
    return this.prisma.ledgerAccount.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { code: 'asc' },
      include: { branch: { select: { id: true, code: true, name: true } } },
    });
  }

  async createAccount(dto: CreateLedgerAccountDto) {
    if (dto.branchId) assertBranchAssignable(dto.branchId);
    try {
      return await this.prisma.ledgerAccount.create({
        data: {
          code: dto.code.toUpperCase(),
          name: dto.name,
          type: dto.type,
          branchId: dto.branchId ?? null,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Account ${dto.code} already exists.`);
      }
      throw e;
    }
  }

  async updateAccount(id: string, dto: UpdateLedgerAccountDto) {
    await this.getAccount(id);
    if (dto.branchId) assertBranchAssignable(dto.branchId);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.branchId !== undefined) data.branchId = dto.branchId ?? null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to change.');
    }
    return this.prisma.ledgerAccount.update({ where: { id }, data });
  }

  private async getAccount(id: string) {
    const row = await this.prisma.ledgerAccount.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Ledger account not found');
    return row;
  }

  /**
   * Deletion is only for an account nothing has ever used. Once a journal line
   * names it, the account is what makes that line readable — the FK is
   * `Restrict` and this is its readable mirror.
   */
  async removeAccount(id: string) {
    await this.getAccount(id);
    const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM journal_lines
      WHERE debit_account_id = ${id}::uuid OR credit_account_id = ${id}::uuid
    `;
    if (Number(count) > 0) {
      throw new ConflictException(
        `${count} journal line(s) name this account, so it cannot be deleted. Deactivate it instead.`,
      );
    }
    const mapped = await this.prisma.ledgerMapping.count({
      where: { OR: [{ debitAccountId: id }, { creditAccountId: id }] },
    });
    if (mapped > 0) {
      throw new ConflictException(
        `${mapped} mapping(s) point at this account. Remove them first.`,
      );
    }
    await this.prisma.ledgerAccount.delete({ where: { id } });
    return { success: true };
  }

  // ── Mappings ──────────────────────────────────────────────────────────────

  async findMappings() {
    return this.prisma.ledgerMapping.findMany({
      orderBy: [{ event: 'asc' }, { component: 'asc' }],
      include: {
        debitAccount: true,
        creditAccount: true,
        branch: { select: { id: true, code: true, name: true } },
      },
    });
  }

  async upsertMapping(dto: UpsertLedgerMappingDto) {
    if (dto.branchId) assertBranchAssignable(dto.branchId);

    const debit = await this.getAccount(dto.debitAccountId);
    const credit = await this.getAccount(dto.creditAccountId);
    if (debit.id === credit.id) {
      // An entry debiting and crediting one account moves nothing and hides
      // that it moves nothing.
      throw new BadRequestException(
        'The debit and credit sides of a mapping must be different accounts.',
      );
    }

    const branchId = dto.branchId ?? null;
    const component = dto.component ?? 'TOTAL';

    // Find-then-write, not upsert: `branchId` is nullable, and Postgres does
    // not treat two NULLs as equal, so the company-wide row is not addressable
    // through a compound unique.
    const existing = await this.prisma.ledgerMapping.findFirst({
      where: { event: dto.event, component, branchId },
    });

    const data = {
      debitAccountId: dto.debitAccountId,
      creditAccountId: dto.creditAccountId,
      isActive: dto.isActive ?? true,
    };

    const include = { debitAccount: true, creditAccount: true };
    if (existing) {
      return this.prisma.ledgerMapping.update({
        where: { id: existing.id },
        data,
        include,
      });
    }
    return this.prisma.ledgerMapping.create({
      data: { event: dto.event, component, branchId, ...data },
      include,
    });
  }

  async removeMapping(id: string) {
    const row = await this.prisma.ledgerMapping.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Ledger mapping not found');
    await this.prisma.ledgerMapping.delete({ where: { id } });
    return { success: true };
  }

  // ── Journals ──────────────────────────────────────────────────────────────

  async findEntries(query: { from?: string; to?: string; sourceId?: string } = {}) {
    return this.prisma.journalEntry.findMany({
      where: {
        ...(query.sourceId ? { sourceId: query.sourceId } : {}),
        ...(query.from || query.to
          ? {
              entryDate: {
                ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
                ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ entryDate: 'desc' }, { postedAt: 'desc' }],
      take: 500,
      include: {
        lines: { include: { debitAccount: true, creditAccount: true } },
      },
    });
  }

  async getEntry(id: string) {
    const row = await this.prisma.journalEntry.findFirst({
      where: { id },
      include: {
        lines: { include: { debitAccount: true, creditAccount: true } },
      },
    });
    if (!row) throw new NotFoundException('Journal entry not found');
    return row;
  }
}
