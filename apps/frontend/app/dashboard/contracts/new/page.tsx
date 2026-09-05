'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ContractForm from '@/components/contracts/ContractForm';
import { Card } from '@/components/ui/Card';
import { usePageHeader } from '@/hooks/usePageHeader';

function NewContract() {
  // Set when the form was opened from an employee record, so the person the
  // contract is for is already chosen.
  const searchParams = useSearchParams();
  const employeeId = searchParams.get('employeeId') ?? undefined;

  usePageHeader('New contract', 'Draft the terms for an existing employee.');

  return <ContractForm employeeId={employeeId} />;
}

export default function NewContractPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      {/* `useSearchParams` suspends during the prerender pass, and without a
          boundary that failure is the whole route rather than this one field. */}
      <Suspense fallback={<Card className="p-6 text-sm text-text-muted">Loading the form…</Card>}>
        <NewContract />
      </Suspense>
    </ProtectedRoute>
  );
}
