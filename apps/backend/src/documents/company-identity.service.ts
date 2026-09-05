import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { runWithBranchBypass } from '../common/branch/branch-context';

export interface CompanyIdentity {
  companyName: string;
  companyLegalName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyWebsite: string;
  companyCrNumber: string;
  companyVatNumber: string;
  branchName: string;
  currency: string;
}

/** Cache lifetime. Identity changes about once a year; documents render constantly. */
const TTL_MS = 5 * 60_000;

/**
 * Who the company is, as a document needs to state it.
 *
 * Resolution is `branch value ?? company setting ?? ''` — the convention Branch
 * already establishes for its nullable columns, where NULL means "inherit"
 * rather than "empty". A branch that has its own CR number and phone prints
 * them; one that does not falls back to the company's, and neither case needs
 * a separate template.
 *
 * Read under `runWithBranchBypass` for the same reason the profile-template
 * resolver does: this is CONFIGURATION, not employee data. Reading it through
 * branch scoping would make a company-wide setting invisible from inside a
 * branch — the exact failure the `direct-or-global` rule exists to prevent.
 */
@Injectable()
export class CompanyIdentityService {
  private cache = new Map<string, { at: number; value: CompanyIdentity }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  async resolve(branchId?: string | null): Promise<CompanyIdentity> {
    const key = branchId ?? '__company__';
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    const [
      companyName,
      companyLegalName,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      companyPhone,
      companyEmail,
      companyWebsite,
      companyCrNumber,
      companyVatNumber,
      currency,
    ] = await Promise.all([
      this.settings.getSetting('company_name', 'The Company'),
      this.settings.getSetting('company_legal_name', ''),
      this.settings.getSetting('company_address_line1', ''),
      this.settings.getSetting('company_address_line2', ''),
      this.settings.getSetting('company_city', ''),
      this.settings.getSetting('company_state', ''),
      this.settings.getSetting('company_postal_code', ''),
      this.settings.getSetting('company_country', ''),
      this.settings.getSetting('company_phone', ''),
      this.settings.getSetting('company_email', ''),
      this.settings.getSetting('company_website', ''),
      this.settings.getSetting('company_cr_number', ''),
      this.settings.getSetting('company_vat_number', ''),
      this.settings.getSetting('currency_code', 'OMR'),
    ]);

    const branch = branchId
      ? await runWithBranchBypass(() =>
          this.prisma.branch.findUnique({
            where: { id: branchId },
            select: {
              name: true,
              addressLine: true,
              city: true,
              state: true,
              postalCode: true,
              country: true,
              phone: true,
              email: true,
              crNumber: true,
              vatNumber: true,
            },
          }),
        )
      : null;

    const join = (...parts: (string | null | undefined)[]) =>
      parts.map((p) => (p ?? '').trim()).filter(Boolean).join(', ');

    const value: CompanyIdentity = {
      companyName,
      companyLegalName: companyLegalName || companyName,
      companyAddress:
        // A branch that carries its own address prints ITS address — a salary
        // certificate from the Sohar office naming the Muscat address is wrong
        // in a way that matters to a bank.
        join(branch?.addressLine, branch?.city, branch?.state, branch?.postalCode, branch?.country) ||
        join(addressLine1, addressLine2, city, state, postalCode, country),
      companyPhone: branch?.phone || companyPhone,
      companyEmail: branch?.email || companyEmail,
      companyWebsite,
      companyCrNumber: branch?.crNumber || companyCrNumber,
      companyVatNumber: branch?.vatNumber || companyVatNumber,
      branchName: branch?.name ?? '',
      currency,
    };

    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** For tests and for an explicit settings save. */
  invalidate(): void {
    this.cache.clear();
  }
}
