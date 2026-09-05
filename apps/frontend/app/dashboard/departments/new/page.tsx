'use client';

import ProtectedRoute from '@/components/auth/ProtectedRoute';
import DepartmentForm from '@/components/departments/DepartmentForm';

export default function NewDepartmentPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <DepartmentForm mode="create" />
    </ProtectedRoute>
  );
}
