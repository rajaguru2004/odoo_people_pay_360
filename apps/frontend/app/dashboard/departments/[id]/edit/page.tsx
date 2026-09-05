'use client';

import { use } from 'react';
import DepartmentForm from '@/components/departments/DepartmentForm';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

export default function EditDepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <ProtectedRoute requiredPermission="MANAGE_DEPARTMENTS">
      <DepartmentForm mode="edit" departmentId={id} />
    </ProtectedRoute>
  );
}
