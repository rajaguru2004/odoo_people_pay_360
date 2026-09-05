'use client';

import { use } from 'react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import DepartmentForm from '@/components/departments/DepartmentForm';

export default function EditDepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <DepartmentForm mode="edit" departmentId={id} />
    </ProtectedRoute>
  );
}
