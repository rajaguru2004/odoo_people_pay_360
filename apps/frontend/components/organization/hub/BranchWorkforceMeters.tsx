'use client';

import { useTranslations } from 'next-intl';
import {
  MeterList,
  PanelHeader,
  PanelLink,
  type MeterRow,
} from '@/components/module-landing/primitives';
import type { OrgUnitRow } from '@/types/organizationHub';

/**
 * Where the workforce sits, by location.
 *
 * The bar is the branch's SHARE of the company, not its raw headcount against
 * the biggest branch — a 62-person Muscat and a 21-person Coimbatore mean
 * something specific about how concentrated the business is, and normalising to
 * the largest branch would draw both at full width in a two-branch company.
 */
export default function BranchWorkforceMeters({
  rows,
  withoutManager = 0,
  limit = 6,
  loading = false,
  failed = false,
}: {
  rows?: OrgUnitRow[];
  withoutManager?: number;
  limit?: number;
  loading?: boolean;
  failed?: boolean;
}) {
  const t = useTranslations('organizationHub');

  const shown = (rows ?? []).slice(0, limit);
  const meters: MeterRow[] = shown.map((b) => ({
    key: b.id,
    label: b.name,
    // A branch with nobody in it draws an empty track rather than a full one.
    percent: b.share ?? 0,
    valueLabel:
      b.share === null
        ? t('branchPeopleOnly', { count: b.employees })
        : t('branchPeopleShare', { count: b.employees, share: b.share.toFixed(0) }),
  }));

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col h-full">
      <PanelHeader
        title={t('branchWorkforce')}
        hint={
          failed
            ? undefined
            : withoutManager > 0
            ? t('branchWorkforceHintGap', { count: withoutManager })
            : t('branchWorkforceHint')
        }
        action={<PanelLink href="/dashboard/branches">{t('seeBranches')}</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 space-y-3 pt-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-9 rounded-lg bg-surface-page animate-pulse" />
          ))}
        </div>
      ) : failed ? (
        // Not "no branches" — the difference matters, because an all-clear
        // nobody checked is worse than a visible gap.
        <p className="text-[13px] text-text-muted py-8">{t('branchesUnknown')}</p>
      ) : meters.length === 0 ? (
        <p className="text-[13px] text-text-muted py-8">{t('noBranches')}</p>
      ) : (
        // Centred only when there are enough rows to fill the panel. One branch
        // floating in the middle of a tall empty box reads as a half-loaded page
        // rather than as a company with one location.
        <div
          className={`flex-1 flex flex-col ${
            meters.length >= 4 ? 'justify-center' : 'justify-start pt-1'
          }`}
        >
          <MeterList rows={meters} />
          {meters.length === 1 && (
            // The branch picker always narrows to exactly one branch, so this
            // panel is a comparison with nothing to compare against far more
            // often than not. Saying so is better than a tall empty box that
            // reads as a half-loaded page.
            <p className="mt-4 text-[11px] text-text-muted leading-snug">
              {t('branchWorkforceSingle')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
