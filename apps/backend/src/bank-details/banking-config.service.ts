import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { BankingFieldDef, FIELD_TYPES, VALIDATION_TYPES } from './banking-fields.util';
import { UpsertBankingFieldDto } from './dto/banking-config.dto';

/**
 * Country Banking Configuration — the per-country field schema that drives
 * dynamic rendering + validation of employee bank details. Ships defaults for
 * common countries; fully editable so a new country is onboarded via config.
 */
@Injectable()
export class BankingConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Active configured fields for a country, ordered for rendering. */
  async getFieldsForCountry(country: string): Promise<BankingFieldDef[]> {
    const rows = await this.prisma.countryBankingField.findMany({
      where: { country: country.toUpperCase(), isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
    });
    return rows.map(this.toDef);
  }

  /** All fields for a country (admin view, includes inactive). */
  async list(country?: string) {
    const rows = await this.prisma.countryBankingField.findMany({
      where: country ? { country: country.toUpperCase() } : {},
      orderBy: [{ country: 'asc' }, { displayOrder: 'asc' }],
    });
    return { success: true, data: rows };
  }

  async upsert(dto: UpsertBankingFieldDto, actorUserId?: string) {
    if (!VALIDATION_TYPES.includes(dto.validationType as any)) {
      throw new BadRequestException(`Unknown validationType ${dto.validationType}`);
    }
    if (dto.fieldType && !FIELD_TYPES.includes(dto.fieldType as any)) {
      throw new BadRequestException(`Unknown fieldType ${dto.fieldType}`);
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(dto.fieldKey)) {
      throw new BadRequestException('fieldKey must be alphanumeric/underscore');
    }
    const country = dto.country.toUpperCase();
    const row = await this.prisma.countryBankingField.upsert({
      where: { country_fieldKey: { country, fieldKey: dto.fieldKey } },
      create: {
        country,
        fieldKey: dto.fieldKey,
        label: dto.label,
        fieldType: dto.fieldType ?? 'TEXT',
        validationType: dto.validationType,
        regex: dto.regex ?? null,
        options: (dto.options ?? undefined) as any,
        required: dto.required ?? true,
        displayOrder: dto.displayOrder ?? 0,
        placeholder: dto.placeholder ?? null,
        helpText: dto.helpText ?? null,
        isSensitive: dto.isSensitive ?? true,
        isActive: dto.isActive ?? true,
      },
      update: {
        label: dto.label,
        fieldType: dto.fieldType ?? undefined,
        validationType: dto.validationType,
        regex: dto.regex ?? null,
        options: (dto.options ?? undefined) as any,
        required: dto.required ?? undefined,
        displayOrder: dto.displayOrder ?? undefined,
        placeholder: dto.placeholder ?? null,
        helpText: dto.helpText ?? null,
        isSensitive: dto.isSensitive ?? undefined,
        isActive: dto.isActive ?? undefined,
      },
    });
    await this.audit.log({
      userId: actorUserId,
      action: 'BANKING_FIELD_UPSERT',
      resourceType: 'CountryBankingField',
      resourceId: row.id,
      newData: { country, fieldKey: dto.fieldKey, validationType: dto.validationType },
    });
    return { success: true, data: row };
  }

  async remove(id: string, actorUserId?: string) {
    const row = await this.prisma.countryBankingField.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Field not found');
    await this.prisma.countryBankingField.delete({ where: { id } });
    await this.audit.log({
      userId: actorUserId,
      action: 'BANKING_FIELD_DELETED',
      resourceType: 'CountryBankingField',
      resourceId: id,
      oldData: { country: row.country, fieldKey: row.fieldKey },
    });
    return { success: true };
  }

  /** Idempotently seed the default field schema for the shipped countries. */
  async seedDefaults(actorUserId?: string) {
    let created = 0;
    for (const [country, fields] of Object.entries(DEFAULT_COUNTRY_FIELDS)) {
      for (const f of fields) {
        const exists = await this.prisma.countryBankingField.findUnique({
          where: { country_fieldKey: { country, fieldKey: f.fieldKey } },
        });
        if (exists) continue;
        await this.prisma.countryBankingField.create({
          data: { country, ...f } as any,
        });
        created += 1;
      }
    }
    await this.audit.log({
      userId: actorUserId,
      action: 'BANKING_FIELDS_SEEDED',
      resourceType: 'CountryBankingField',
      newData: { created },
    });
    return { success: true, data: { created } };
  }

  private toDef = (r: any): BankingFieldDef => ({
    fieldKey: r.fieldKey,
    label: r.label,
    fieldType: r.fieldType,
    validationType: r.validationType,
    regex: r.regex,
    options: r.options,
    required: r.required,
    displayOrder: r.displayOrder,
    placeholder: r.placeholder,
    helpText: r.helpText,
    isSensitive: r.isSensitive,
  });
}

type DefaultField = Omit<BankingFieldDef, never> & { fieldKey: string };

/**
 * Shipped defaults. Common fields: accountHolderName (never sensitive), then the
 * country-specific identifier(s). Organizations may edit/extend any of these.
 */
export const DEFAULT_COUNTRY_FIELDS: Record<string, DefaultField[]> = {
  OM: [
    { fieldKey: 'accountHolderName', label: 'Account Holder Name', fieldType: 'TEXT', validationType: 'NONE', required: true, displayOrder: 1, placeholder: 'As on the account', helpText: null, isSensitive: false },
    { fieldKey: 'iban', label: 'IBAN', fieldType: 'TEXT', validationType: 'IBAN', required: true, displayOrder: 2, placeholder: 'OM81 0180 0000 0129 9123 456', helpText: '23 characters', isSensitive: true },
  ],
  AE: [
    { fieldKey: 'accountHolderName', label: 'Account Holder Name', fieldType: 'TEXT', validationType: 'NONE', required: true, displayOrder: 1, placeholder: 'As on the account', helpText: null, isSensitive: false },
    { fieldKey: 'iban', label: 'IBAN', fieldType: 'TEXT', validationType: 'IBAN', required: true, displayOrder: 2, placeholder: 'AE07 0331 2345 6789 0123 456', helpText: '23 characters', isSensitive: true },
  ],
  IN: [
    { fieldKey: 'accountHolderName', label: 'Account Holder Name', fieldType: 'TEXT', validationType: 'NONE', required: true, displayOrder: 1, placeholder: 'As on the account', helpText: null, isSensitive: false },
    { fieldKey: 'accountNumber', label: 'Account Number', fieldType: 'TEXT', validationType: 'NUMBER', required: true, displayOrder: 2, placeholder: '1234567890', helpText: null, isSensitive: true },
    { fieldKey: 'ifsc', label: 'IFSC Code', fieldType: 'TEXT', validationType: 'IFSC', required: true, displayOrder: 3, placeholder: 'HDFC0001234', helpText: '11 characters', isSensitive: false },
  ],
  GB: [
    { fieldKey: 'accountHolderName', label: 'Account Holder Name', fieldType: 'TEXT', validationType: 'NONE', required: true, displayOrder: 1, placeholder: 'As on the account', helpText: null, isSensitive: false },
    { fieldKey: 'accountNumber', label: 'Account Number', fieldType: 'TEXT', validationType: 'NUMBER', required: true, displayOrder: 2, placeholder: '12345678', helpText: '8 digits', isSensitive: true },
    { fieldKey: 'sortCode', label: 'Sort Code', fieldType: 'TEXT', validationType: 'SORT_CODE', required: true, displayOrder: 3, placeholder: '12-34-56', helpText: '6 digits', isSensitive: false },
  ],
  US: [
    { fieldKey: 'accountHolderName', label: 'Account Holder Name', fieldType: 'TEXT', validationType: 'NONE', required: true, displayOrder: 1, placeholder: 'As on the account', helpText: null, isSensitive: false },
    { fieldKey: 'accountNumber', label: 'Account Number', fieldType: 'TEXT', validationType: 'NUMBER', required: true, displayOrder: 2, placeholder: '000123456789', helpText: null, isSensitive: true },
    { fieldKey: 'routingNumber', label: 'Routing Number', fieldType: 'TEXT', validationType: 'ROUTING', required: true, displayOrder: 3, placeholder: '021000021', helpText: '9 digits', isSensitive: false },
  ],
};
