'use client';

import ProtectedRoute from '@/components/auth/ProtectedRoute';
import SalaryComponentForm from '@/components/payroll/SalaryComponentForm';
import { usePageHeader } from '@/hooks/usePageHeader';

function NewSalaryComponent() {
  usePageHeader(
    'New salary component',
    'The code and the type are fixed the moment this exists, so choose them deliberately.',
  );

  return <SalaryComponentForm />;
}

export default function NewSalaryComponentPage() {
  return (
    // ADMIN and PAYROLL_OFFICER, mirroring the `@Roles` on `POST
    // /salary-components`.
    <ProtectedRoute requiredPermission="MANAGE_SALARY_COMPONENTS">
      <NewSalaryComponent />
    </ProtectedRoute>
  );
}
