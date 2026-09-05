'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import type { PayrollHubSummary } from '@/types/payrollHub';

/**
 * Can the people in this run actually be paid?
 *
 * Nothing in the product answered this before. The figure comes from the same
 * validator the bank-details screens and the wage-file builder use, so a bank
 * record that exists but carries a malformed IBAN counts as NOT ready — the
 * case a plain "has a bank record" count cannot see.
 *
 * It stops short of the WPS identifier checks (labour card, civil ID), which
 * are wage-file-format specific and live in the generator. So this is **not**
 * the WPS verdict, and the panel says so rather than letting a reader take it
 * as clearance to file.
 *
 * The honesty trap it exists to avoid: a branch with no banking country has no
 * required fields, so everybody under it would validate as ready. Those people
 * are counted as unknown and excluded from the rate, which is why the rate can
 * legitimately be `null` and must never be shown as 100%.
 */
export default function PaymentReadinessPanel({
  readiness,
  wps,
  loading = false,
  failed = false,
}: {
  readiness?: PayrollHubSummary['readiness'];
  wps?: PayrollHubSummary['wps'];
  loading?: boolean;
  failed?: boolean;
}) {
  const t = useTranslations('payrollHub');

  /**
   * Every blocked line goes somewhere.
   *
   * A meter that reads "No bank record: 1" names an exception and then stops,
   * leaving the reader to work out which of the bank screens resolves it. Each
   * row now carries the screen that fixes THAT failure — a missing or malformed
   * record is the bank-details list, a pending change is the approval queue, an
   * inactive bank or a disallowed country is the configuration behind it — plus
   * a line saying what the count means.
   */
  const rows: MeterRow[] = [];
  if (readiness) {
    const of = (n: number) => (readiness.total > 0 ? (n / readiness.total) * 100 : 0);
    const push = (
      key: string,
      label: string,
      value: number,
      color?: string,
      href?: string,
      hint?: string,
    ) => {
      if (value > 0) {
        rows.push({ key, label, percent: of(value), valueLabel: String(value), color, href, hint });
      }
    };
    push('ready', t('rdyReady'), readiness.ready, 'var(--color-status-success)', '/dashboard/banks');
    push(
      'noBankRecord',
      t('rdyNoRecord'),
      readiness.noBankRecord,
      'var(--color-status-error)',
      '/dashboard/banks',
      t('rdyNoRecordFix'),
    );
    push(
      'incompleteFields',
      t('rdyInvalid'),
      readiness.incompleteFields,
      'var(--color-status-error)',
      '/dashboard/banks',
      t('rdyInvalidFix'),
    );
    push(
      'pendingChange',
      t('rdyPendingChange'),
      readiness.pendingChange,
      'var(--color-status-warning)',
      '/dashboard/approvals',
      t('attnOldAccount'),
    );
    push(
      'bankInactive',
      t('rdyBankInactive'),
      readiness.bankInactive,
      'var(--color-status-warning)',
      '/dashboard/banks/config',
      t('rdyBankInactiveFix'),
    );
    push(
      'countryNotAllowed',
      t('rdyCountry'),
      readiness.countryNotAllowed,
      'var(--color-status-warning)',
      '/dashboard/banks/branch-countries',
      t('rdyCountryFix'),
    );
    push(
      'unknown',
      t('rdyUnknown'),
      readiness.unknown,
      'var(--color-text-muted)',
      '/dashboard/banks/branch-countries',
      t('rdyUnknownFix'),
    );
  }

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between h-full">
      <PanelHeader
        title={t('readiness')}
        hint={
          readiness
            ? readiness.population === 'run'
              ? t('readinessHintRun')
              : t('readinessHintActive')
            : undefined
        }
        action={<PanelLink href="/dashboard/banks">{t('seeBanks')}</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 mt-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-4 w-full rounded bg-surface-page animate-pulse" />
          ))}
        </div>
      ) : failed ? (
        <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
          {t('readinessUnknown')}
        </p>
      ) : !readiness ? (
        // Distinct from a failure: there was genuinely nobody to judge.
        <p className="flex-1 grid place-items-center text-[13px] text-text-muted">
          {t('readinessNobody')}
        </p>
      ) : (
        <div className="mt-3 flex-1 flex flex-col justify-between gap-4">
          <div>
            <p className="text-[28px] font-extrabold text-text-heading tabular-nums leading-none">
              {/* A rate nobody could compute prints as an em dash. Printing
                  "100%" here would be a clearance to pay that nothing checked. */}
              {readiness.readyRate === null ? '—' : `${readiness.readyRate.toFixed(0)}%`}
            </p>
            <p className="mt-1 text-[12px] text-text-muted">
              {readiness.readyRate === null
                ? t('rdyNothingToJudge')
                : t('rdyReadyOf', { ready: readiness.ready, total: readiness.total - readiness.unknown })}
            </p>
          </div>

          <MeterList rows={rows} trackHeight={12} />

          {/* Only once a wage file has ever existed: an install that does not
              use WPS should not be told about a feature it has never touched. */}
          {wps?.lastFileAt && (
            <Link
              href="/dashboard/payroll/manage"
              className="block pt-3 border-t border-surface-border group rounded-lg hover:bg-surface-page transition-colors"
            >
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                {t('wpsLastFile')}
              </p>
              <p className="mt-1 text-[12px] text-text-body inline-flex items-center gap-1 group-hover:text-brand-primary transition-colors">
                {new Date(wps.lastFileAt).toLocaleDateString()} · {wps.lastFileStatus}
                <ChevronRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity rtl:rotate-180" />
              </p>
              {wps.rejected > 0 && (
                <p className="mt-1 text-[12px] font-semibold text-status-error">
                  {t('wpsRejected', { count: wps.rejected })}
                </p>
              )}
            </Link>
          )}

          <p className="text-[11px] text-text-muted leading-relaxed">{t('readinessCaveat')}</p>
        </div>
      )}
    </div>
  );
}
