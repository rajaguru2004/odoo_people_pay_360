'use client';

import DepartmentForm from '@/components/departments/DepartmentForm';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

export default function NewDepartmentPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_DEPARTMENTS">
      <DepartmentForm mode="create" />
    </ProtectedRoute>
  );
}
