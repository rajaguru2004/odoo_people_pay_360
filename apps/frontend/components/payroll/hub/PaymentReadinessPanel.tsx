'use client';

import { useTranslations } from 'next-intl';
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
 * validator the bank-details screens use, so a bank record that exists but
 * carries a malformed IBAN counts as NOT ready — the case a plain "has a bank
 * record" count cannot see.
 *
 * It checks bank records and nothing else, and the panel says so rather than
 * letting a reader take it as clearance to pay.
 *
 * The honesty trap it exists to avoid: a branch with no banking country has no
 * required fields, so everybody under it would validate as ready. Those people
 * are counted as unknown and excluded from the rate, which is why the rate can
 * legitimately be `null` and must never be shown as 100%.
 */
export default function PaymentReadinessPanel({
  readiness,
  loading = false,
  failed = false,
}: {
  readiness?: PayrollHubSummary['readiness'];
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

          <p className="text-[11px] text-text-muted leading-relaxed">{t('readinessCaveat')}</p>
        </div>
      )}
    </div>
  );
}
