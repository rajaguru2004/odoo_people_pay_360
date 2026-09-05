'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Star } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import {
  useOvertimePolicies,
  useSetDefaultOvertimePolicy,
  useSetOvertimePolicyActive,
  useUpdateOvertimePolicy,
} from '@/hooks/useOvertimePolicies';
import { apiErrorMessage } from '@/utils/apiError';
import { formatMultiplier } from '@/components/leave/leaveFormat';
import type { OvertimePolicy } from '@/types/overtime';

/**
 * The overtime rule sets, and which employees each one governs.
 *
 * The chain resolves top-down: an employee override, then their employment type,
 * then the company default. It ALWAYS resolves — there is no off switch — which
 * is why the default cannot be deactivated or demoted without promoting a
 * replacement first. Losing it would drop every uncovered employee onto the raw
 * company settings, silently, and the screen that edits those rates would no
 * longer be the screen that decides their pay.
 */
function OvertimePoliciesContent() {
  const { data, isLoading, isError, error } = useOvertimePolicies();
  const setDefault = useSetDefaultOvertimePolicy();
  const setActive = useSetOvertimePolicyActive();
  const updatePolicy = useUpdateOvertimePolicy();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [rates, setRates] = useState({
    regularRate: '',
    lateRate: '',
    lateThreshold: '',
  });

  const policies = data?.data ?? [];

  usePageHeader(
    'Overtime policies',
    `${policies.filter((p) => p.isActive).length} active`,
  );

  const startEdit = (policy: OvertimePolicy) => {
    setEditingId(policy.id);
    setRates({
      regularRate: String(policy.rules.regularRate ?? ''),
      lateRate: String(policy.rules.lateRate ?? ''),
      lateThreshold: policy.rules.lateThreshold ?? '',
    });
  };

  const onSave = async (policy: OvertimePolicy) => {
    const regularRate = Number(rates.regularRate);
    const lateRate = Number(rates.lateRate);
    if (!(regularRate > 0) || !(lateRate > 0)) {
      // A zero multiplier is not "free overtime", it is a rule nobody meant to
      // write — and it pays an hour worked at nothing.
      toast.error('Both multipliers have to be greater than zero.');
      return;
    }
    try {
      await updatePolicy.mutateAsync({
        id: policy.id,
        // A PARTIAL rules payload: the server composes it over the current
        // values, so the fields this form does not show keep what they had.
        payload: {
          rules: {
            regularRate,
            lateRate,
            lateThreshold: rates.lateThreshold,
          },
        },
      });
      toast.success(`${policy.name} updated.`);
      setEditingId(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The policy could not be saved.'));
    }
  };

  const onPromote = async (policy: OvertimePolicy) => {
    try {
      await setDefault.mutateAsync(policy.id);
      toast.success(`${policy.name} is now the company default.`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The default could not be changed.'));
    }
  };

  const onToggle = async (policy: OvertimePolicy) => {
    try {
      await setActive.mutateAsync({ id: policy.id, isActive: !policy.isActive });
      toast.success(policy.isActive ? 'Policy deactivated.' : 'Policy activated.');
    } catch (err) {
      // The default refuses to be deactivated, and the server says why.
      toast.error(apiErrorMessage(err, 'The policy could not be changed.'));
    }
  };

  return (
    <div className="max-w-5xl space-y-5">
      <Card>
        <CardHeader
          title="How a policy is chosen"
          subtitle="Employee override, then employment type, then the company default."
        />
        <CardBody>
          <p className="text-sm text-text-muted">
            An approved request stores the policy that classified its hours, so
            editing a rate here changes what is paid on requests decided from now
            on — never on ones already approved.
          </p>
        </CardBody>
      </Card>

      {isError ? (
        <Card className="p-6">
          <p className="text-sm text-status-error">
            {apiErrorMessage(error, 'The policies could not be loaded.')}
          </p>
        </Card>
      ) : isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-[var(--radius-card)] bg-surface-border/60" />
          ))}
        </div>
      ) : policies.length === 0 ? (
        <Card>
          <EmptyState
            title="No overtime policies"
            description="The company default is created on start-up; if it is missing, restart the API."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {policies.map((policy) => {
            const isEditing = editingId === policy.id;
            return (
              <Card key={policy.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-text-heading">
                        {policy.name}
                      </h3>
                      {policy.isDefault && <Badge tone="info">Company default</Badge>}
                      {!policy.isActive && <Badge tone="neutral">Inactive</Badge>}
                      {policy.employmentType && (
                        <Badge tone="warning">{policy.employmentType}</Badge>
                      )}
                      {policy.rules.holidayBehavior === 'IGNORE' && (
                        <Badge tone="neutral">holidays as ordinary days</Badge>
                      )}
                    </div>
                    {policy.description && (
                      <p className="mt-1 max-w-2xl text-sm text-text-muted">
                        {policy.description}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-text-muted">
                      {policy._count?.employees ?? 0} employee
                      {(policy._count?.employees ?? 0) === 1 ? '' : 's'} assigned
                      directly
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {isEditing ? (
                      <>
                        <Button
                          size="sm"
                          isLoading={updatePolicy.isPending}
                          onClick={() => void onSave(policy)}
                        >
                          Save rates
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="outline" onClick={() => startEdit(policy)}>
                          Edit rates
                        </Button>
                        {!policy.isDefault && (
                          <Button
                            size="sm"
                            variant="ghost"
                            isLoading={setDefault.isPending}
                            onClick={() => void onPromote(policy)}
                          >
                            <Star className="h-3.5 w-3.5" aria-hidden />
                            Make default
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          isLoading={setActive.isPending}
                          onClick={() => void onToggle(policy)}
                        >
                          {policy.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-4 grid gap-3 border-t border-surface-border-light pt-4 sm:grid-cols-3">
                    <Input
                      type="number"
                      step="0.05"
                      min={0.05}
                      label="Regular multiplier"
                      value={rates.regularRate}
                      onChange={(e) => setRates({ ...rates, regularRate: e.target.value })}
                    />
                    <Input
                      type="number"
                      step="0.05"
                      min={0.05}
                      label="Late multiplier"
                      value={rates.lateRate}
                      onChange={(e) => setRates({ ...rates, lateRate: e.target.value })}
                    />
                    <Input
                      type="time"
                      label="Late from"
                      value={rates.lateThreshold}
                      onChange={(e) => setRates({ ...rates, lateThreshold: e.target.value })}
                    />
                  </div>
                ) : (
                  <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-surface-border-light pt-4 sm:grid-cols-5">
                    <Figure label="Regular" value={formatMultiplier(policy.rules.regularRate)} />
                    <Figure label="Late" value={formatMultiplier(policy.rules.lateRate)} />
                    <Figure label="Late from" value={policy.rules.lateThreshold} />
                    <Figure label="Rest day" value={formatMultiplier(policy.rules.sunday?.regularRate)} />
                    <Figure label="Holiday" value={formatMultiplier(policy.rules.holiday?.regularRate)} />
                    <Figure label="Cap, weekday" value={`${policy.rules.maxHoursPerDay}h`} />
                    <Figure label="Cap, rest day" value={`${policy.rules.maxHoursPerDoubleDay}h`} />
                    <Figure label="Cap, month" value={`${policy.rules.maxHoursPerMonth}h`} />
                    <Figure label="Cap, year" value={`${policy.rules.maxHoursPerYear}h`} />
                    <Figure
                      label="Food allowance"
                      value={
                        policy.rules.foodAllowanceEnabled
                          ? `${policy.rules.foodAllowanceAmount} from ${policy.rules.foodAllowanceThreshold}`
                          : 'none'
                      }
                    />
                  </dl>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums text-text-heading">
        {value}
      </dd>
    </div>
  );
}

export default function OvertimePoliciesPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <OvertimePoliciesContent />
    </ProtectedRoute>
  );
}
