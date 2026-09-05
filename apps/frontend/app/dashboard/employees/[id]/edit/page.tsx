'use client';

import { useParams } from 'next/navigation';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import EmployeeForm from '@/components/employees/EmployeeForm';
import { Card } from '@/components/ui/Card';
import { useEmployee } from '@/hooks/useEmployees';
import { usePageHeader } from '@/hooks/usePageHeader';
import { fullName } from '@/utils/formatters';

function EditEmployee({ id }: { id: string }) {
  const { data, isLoading, isError } = useEmployee(id);
  const employee = data?.data;

  usePageHeader(
    employee ? `Editing ${fullName(employee)}` : 'Edit employee',
    employee?.employeeCode,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the record…</Card>;
  }

  if (isError || !employee) {
    return (
      <Card className="p-6 text-sm text-status-error">
        Could not load this employee record.
      </Card>
    );
  }

  // Mounted only once the record has arrived: `defaultValues` are read on the
  // first render, so a form built while the request is in flight starts empty
  // and stays empty.
  return <EmployeeForm employee={employee} />;
}

export default function EditEmployeePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <ProtectedRoute requiredPermission="EDIT_EMPLOYEE">
      <EditEmployee id={id} />
    </ProtectedRoute>
  );
}
