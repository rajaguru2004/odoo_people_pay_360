'use client';

import ProtectedRoute from '@/components/auth/ProtectedRoute';
import BranchForm from '@/components/branches/BranchForm';

export default function NewBranchPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <BranchForm mode="create" />
    </ProtectedRoute>
  );
}
