'use client';

import ProtectedRoute from '@/components/auth/ProtectedRoute';
import EmployeeForm from '@/components/employees/EmployeeForm';
import { usePageHeader } from '@/hooks/usePageHeader';

function NewEmployee() {
  usePageHeader('New employee', 'Create a record for a joiner.');
  return <EmployeeForm />;
}

export default function NewEmployeePage() {
  return (
    <ProtectedRoute requiredPermission="CREATE_EMPLOYEE">
      <NewEmployee />
    </ProtectedRoute>
  );
}
