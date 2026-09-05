'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Users } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PayrollRunForm, { type PayrollRunFormValues } from '@/components/payroll/PayrollRunForm';
import PreflightFindings from '@/components/payroll/PreflightFindings';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import {
  useCalculatePayrollRun,
  useCreatePayrollRun,
  usePreflightPayrollRun,
} from '@/hooks/usePayrollRuns';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import type { ApiResponse } from '@/types/api';
import type { CreatePayrollRunPayload, PayrollRun, PreflightResult } from '@/types/payroll';

/**
 * Open a run for a period — pre-flight first, generation second.
 *
 * The pre-flight writes NOTHING. It answers what a run would do, so an
 * objection is read here rather than after a row exists that then has to be
 * cancelled. `canGenerate` is the server's verdict and the button reads it
 * directly; the page never decides for itself which findings are fatal.
 *
 * Generating is TWO calls — create, then calculate — and the page says which
 * one failed. A single "could not generate" over a run that was created but not
 * calculated leaves a DRAFT nobody knows about, and the next attempt makes a
 * second one.
 */
function NewPayrollRun() {
  const router = useRouter();
  const preflight = usePreflightPayrollRun();
  const createRun = useCreatePayrollRun();
  const calculateRun = useCalculatePayrollRun();

  const [result, setResult] = useState<PreflightResult | null>(null);
  const [checkedPeriod, setCheckedPeriod] = useState<{ month: number; year: number } | null>(null);
  const [generating, setGenerating] = useState(false);

  usePageHeader('New payroll run', 'Check a period before anything is created for it.');

  // The period a run is normally opened for: the month that has just closed.
  const now = new Date();
  const defaultMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const defaultYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const handleCheck = async (values: PayrollRunFormValues) => {
    try {
      const response = await preflight.mutateAsync({
        month: values.month,
        year: values.year,
      });
      setResult(response.data);
      setCheckedPeriod({ month: values.month, year: values.year });
    } catch (error) {
      setResult(null);
      setCheckedPeriod(null);
      toast.error(apiErrorMessage(error, 'The pre-flight could not be run'));
    }
  };

  const handleGenerate = async (values: PayrollRunFormValues) => {
    setGenerating(true);
    const payload: CreatePayrollRunPayload = {
      month: values.month,
      year: values.year,
      ...(values.notes ? { notes: values.notes } : {}),
    };

    let runId: string;
    try {
      // The shared run-mutation helper types every result as `unknown` — it
      // exists to invalidate the payroll subtree, not to describe a payload —
      // so the one caller that needs the new id names the shape it asked for.
      const created = (await createRun.mutateAsync(payload)) as ApiResponse<PayrollRun>;
      runId = created.data.id;
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The run could not be created'));
      setGenerating(false);
      return;
    }

    try {
      await calculateRun.mutateAsync(runId);
      toast.success('The run was created and its payslips calculated.');
    } catch (error) {
      // The run EXISTS. Saying only "generation failed" would hide a draft that
      // the next attempt would duplicate, so the reader is sent to it.
      toast.error(
        apiErrorMessage(
          error,
          'The run was created but its payslips could not be calculated. Open it and calculate again.',
        ),
      );
    } finally {
      setGenerating(false);
      router.push(`/dashboard/payroll/runs/${runId}`);
    }
  };

  return (
    <div className="space-y-5">
      <PayrollRunForm
        onCheck={(values) => void handleCheck(values)}
        onGenerate={(values) => void handleGenerate(values)}
        checking={preflight.isPending}
        generating={generating}
        canGenerate={result?.canGenerate ?? false}
        checkedPeriod={checkedPeriod}
        defaultMonth={defaultMonth}
        defaultYear={defaultYear}
      />

      {result && (
        <Card data-testid="preflight-result">
          <CardHeader
            title={`Pre-flight for ${result.period.label}`}
            subtitle={`${formatDateOnly(result.period.periodStart)} – ${formatDateOnly(
              result.period.periodEnd,
            )}`}
            action={
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-body">
                <Users className="h-4 w-4 text-text-muted" aria-hidden />
                {result.employeeCount} employee{result.employeeCount === 1 ? '' : 's'}
              </span>
            }
          />
          <CardBody>
            <PreflightFindings findings={result.findings} canGenerate={result.canGenerate} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export default function NewPayrollRunPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <NewPayrollRun />
    </ProtectedRoute>
  );
}
