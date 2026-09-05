'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import SalaryStructureForm from '@/components/payroll/SalaryStructureForm';
import { Card } from '@/components/ui/Card';
import { usePageHeader } from '@/hooks/usePageHeader';

function NewSalaryStructure() {
  // Set when the form was opened from an employee record, so the person the
  // structure is for is already chosen.
  const searchParams = useSearchParams();
  const employeeId = searchParams.get('employeeId') ?? undefined;

  usePageHeader(
    'Assign a salary structure',
    'One structure per employee — assigning is creating theirs.',
  );

  return <SalaryStructureForm employeeId={employeeId} />;
}

export default function NewSalaryStructurePage() {
  return (
    // ADMIN and PAYROLL_OFFICER, mirroring the `@Roles` on `POST
    // /salary-structures`. HR may read the register and not write to it, so
    // drawing this form for them would be a promise the server refuses.
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      {/* `useSearchParams` suspends during the prerender pass, and without a
          boundary that failure is the whole route rather than this one field. */}
      <Suspense fallback={<Card className="p-6 text-sm text-text-muted">Loading the form…</Card>}>
        <NewSalaryStructure />
      </Suspense>
    </ProtectedRoute>
  );
}
